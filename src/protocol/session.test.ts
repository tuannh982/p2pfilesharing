import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../crypto/chunks';
import { generateRawKey, importRawKey } from '../crypto/keys';
import { MemorySink } from '../sink/memory';
import type { Sink } from '../sink/sink';
import type { Channel, ChannelMessage, CloseReason } from '../transport/channel';
import { createLoopbackPair } from '../transport/loopback';
import { FIRST_FILE_INDEX, type ManifestEntry } from './manifest';
import { ProtocolError, serializeControl } from './messages';
import { ReceiverSession, SenderSession, type SenderSessionOptions } from './session';
import { CLOSE_MESSAGES } from './transfer';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const encryptedFrames = (channel: Channel): ArrayBuffer[] => {
  const frames: ArrayBuffer[] = [];
  channel.onMessage((msg: ChannelMessage) => {
    if (typeof msg !== 'string') frames.push(msg);
  });
  return frames;
};

const settledWithin = async (work: Promise<unknown>, ms = 100): Promise<string> =>
  Promise.race([
    work.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);

const bufferedBySession = (session: ReceiverSession): number =>
  (session as unknown as { pending: unknown[] }).pending.length;

const deferredSink = (): { promise: Promise<Sink>; release: (sink: Sink) => void } => {
  let release: (sink: Sink) => void = () => {};
  const promise = new Promise<Sink>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const trackingSink = (): Sink & { aborted: () => boolean } => {
  let aborted = false;
  return {
    write: () => Promise.resolve(),
    close: () => Promise.resolve(),
    abort: () => {
      aborted = true;
    },
    aborted: () => aborted,
  };
};

const key = async (): Promise<CryptoKey> => importRawKey(await generateRawKey());

const list = (): File[] => [
  new File([new Uint8Array(1000)], 'a.bin'),
  new File([new Uint8Array(2000)], 'b.bin'),
  new File([new Uint8Array(3000)], 'c.bin'),
];

const expected = (files: File[]): ManifestEntry[] =>
  files.map((file) => ({ name: file.name, size: BigInt(file.size) }));

const bytesOf = async (file: File): Promise<Uint8Array> => new Uint8Array(await file.arrayBuffer());

const connect = async (files: File[], shared: CryptoKey, onFirstSettled?: () => void) => {
  const { a, b } = createLoopbackPair();
  const sender = new SenderSession(a, shared, files, { pollIntervalMs: 0 });
  const sinks: MemorySink[] = [];
  let seen: ManifestEntry[] = [];
  const receiver = new ReceiverSession(b, shared, {
    openSink: async () => {
      const sink = new MemorySink();
      sinks.push(sink);
      if (onFirstSettled === undefined || sinks.length > 1) return sink;
      return {
        write: (chunk: Uint8Array) => sink.write(chunk),
        close: () => {
          const settled = sink.close();
          settled.then(onFirstSettled);
          return settled;
        },
        abort: () => sink.abort(),
      };
    },
    onManifest: (entries) => {
      seen = entries;
    },
  });
  const connecting = receiver.run();
  const serving = sender.run();
  await connecting;
  await settle();
  return { a, b, sender, receiver, sinks, seen, serving };
};

describe('connecting and listing', () => {
  it('learns the whole file list from the manifest, before any selection', async () => {
    const files = list();
    const { receiver, seen, sender } = await connect(files, await key());
    expect(seen).toEqual(expected(files));
    receiver.abort();
    await sender.run().catch(() => undefined);
  });

  it('has no list at all before the sender answers, so there is nothing to show yet', async () => {
    const { b } = createLoopbackPair();
    const receiver = new ReceiverSession(b, await key(), {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    expect(receiver.files).toEqual([]);
  });

  it('fails when the first frame is a control message rather than the manifest', async () => {
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    a.send(serializeControl({ t: 'accept' }));
    await expect(connecting).rejects.toThrowError(ProtocolError);
  });

  it('fails when the manifest is not decryptable with the token key', async () => {
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverSession(b, await key(), {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const { encryptManifest } = await import('./manifest');
    a.send(await encryptManifest(await key(), expected(list())));
    await expect(connecting).rejects.toThrow();
  });

  it('goes quiet once the file list is in, so a download is not held in memory twice', async () => {
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sender = new SenderSession(a, shared, list(), { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    expect(bufferedBySession(receiver)).toBe(0);

    await receiver.select(0);
    await receiver.finish();
    await serving;

    expect(bufferedBySession(receiver)).toBe(0);
  });
});

describe('the multi-file loop', () => {
  it('delivers two chosen files in the order requested, on one connection', async () => {
    const files = list();
    const { receiver, sinks, serving } = await connect(files, await key());

    await receiver.select(2);
    await receiver.select(0);
    await receiver.finish();
    await serving;

    expect(sinks).toHaveLength(2);
    expect(sinks[0]?.toUint8Array()).toEqual(await bytesOf(files[2] as File));
    expect(sinks[1]?.toUint8Array()).toEqual(await bytesOf(files[0] as File));
  });

  it('lets the receiver take the second file and skip the first', async () => {
    const files = list();
    const { receiver, sinks, serving } = await connect(files, await key());

    await receiver.select(1);
    await receiver.finish();
    await serving;

    expect(sinks).toHaveLength(1);
    expect(sinks[0]?.toUint8Array()).toEqual(await bytesOf(files[1] as File));
  });

  it('hands back a sink opened with the manifest entry, not a caller-chosen name', async () => {
    const files = list();
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const opened: ManifestEntry[] = [];
    const sender = new SenderSession(a, shared, files, { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async (entry) => {
        opened.push(entry);
        return new MemorySink();
      },
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    await receiver.select(1);
    await receiver.finish();
    await serving;

    expect(opened).toEqual([expected(files)[1]]);
  });

  it('stops the sender cleanly on finish, with no error', async () => {
    const { sender, receiver, serving } = await connect(list(), await key());
    await receiver.select(0);
    await receiver.finish();
    await expect(serving).resolves.toBeUndefined();
    sender.abort();
  });
});

describe('a receiver cannot reach past the list', () => {
  it('serves the same file twice, because the nonce reuse repeats the plaintext too', async () => {
    const files = list();
    const { receiver, sinks, serving } = await connect(files, await key());

    await receiver.select(0);
    await receiver.select(0);
    await receiver.finish();
    await serving;

    expect(sinks).toHaveLength(2);
    expect(sinks[0]?.toUint8Array()).toEqual(await bytesOf(files[0] as File));
    expect(sinks[1]?.toUint8Array()).toEqual(await bytesOf(files[0] as File));
  });

  it('refuses an index past the end, before opening a destination', async () => {
    const files = list();
    const { a, b } = createLoopbackPair();
    const shared = await key();
    let opened = 0;
    const sender = new SenderSession(a, shared, files, { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => {
        opened += 1;
        return new MemorySink();
      },
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    await expect(receiver.select(9)).rejects.toThrowError(/not in this share/i);
    expect(opened).toBe(0);

    receiver.abort();
    await serving.catch(() => undefined);
  });

  it('treats an out-of-range select on the wire as a hard protocol error', async () => {
    const { a, b } = createLoopbackPair();
    const sender = new SenderSession(a, await key(), list(), { pollIntervalMs: 0 });
    const serving = sender.run();
    await settle();
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX + 9 }));

    await expect(serving).rejects.toThrowError(ProtocolError);
    await expect(serving).rejects.toThrowError(/not in this share/i);
  });

  it('rejects a first control message that is neither select nor finish', async () => {
    const { a, b } = createLoopbackPair();
    const sender = new SenderSession(a, await key(), list(), { pollIntervalMs: 0 });
    const serving = sender.run();
    await settle();
    b.send(serializeControl({ t: 'accept' }));
    await expect(serving).rejects.toThrowError(ProtocolError);
  });

  it('rejects file data where a control message was expected', async () => {
    const { a, b } = createLoopbackPair();
    const sender = new SenderSession(a, await key(), list(), { pollIntervalMs: 0 });
    const serving = sender.run();
    await settle();
    b.send(new ArrayBuffer(32));
    await expect(serving).rejects.toThrowError(ProtocolError);
  });

  it('refuses a share with no files, rather than sending an empty manifest', async () => {
    const { a } = createLoopbackPair();
    const sender = new SenderSession(a, await key(), [], {});
    await expect(sender.run()).rejects.toThrowError(/at least one file/i);
  });
});

describe('session failure handling', () => {
  it('surfaces a receiver sink failure to the sender', async () => {
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sender = new SenderSession(a, shared, list(), { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () =>
        ({
          write: () => Promise.reject(new Error('the disk is full')),
          close: () => Promise.resolve(),
          abort: () => {},
        }) as Sink,
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    await expect(receiver.select(0)).rejects.toThrowError('the disk is full');
    await expect(serving).rejects.toThrowError(/disk is full/i);
  });

  it('fails the receiver when the sender disconnects', async () => {
    const files = list();
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sender = new SenderSession(a, shared, files, { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    a.close();
    await expect(receiver.select(0)).rejects.toThrowError(/connection closed/i);
    await serving.catch(() => undefined);
  });

  it('fails the receiver when no manifest ever arrives', async () => {
    const { a } = createLoopbackPair();
    const receiver = new ReceiverSession(a, await key(), {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
      stallTimeoutMs: 10,
    });
    await expect(receiver.run()).rejects.toThrowError(/quiet|timed out/i);
  });

  it('fails the receiver when the sender sends a manifest it cannot read', async () => {
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sender = new SenderSession(a, shared, list(), { pollIntervalMs: 0 });
    const receiving = new ReceiverSession(b, await key(), {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    }).run();
    const serving = sender.run();
    await expect(receiving).rejects.toThrow();
    await serving.catch(() => undefined);
  });

  it('lets the sender stop serving when aborted', async () => {
    const files = list();
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sender = new SenderSession(a, shared, files, { pollIntervalMs: 0 });
    const connecting = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    }).run();
    const serving = sender.run();
    await connecting;
    await settle();

    sender.abort();
    await expect(serving).resolves.toBeUndefined();
  });
});

describe('the sender session as a whole', () => {
  it('refuses a second run, so the manifest is never re-encrypted at its own nonce', async () => {
    const { a, b } = createLoopbackPair();
    const frames = encryptedFrames(b);
    const sender = new SenderSession(a, await key(), list(), { pollIntervalMs: 0 });
    const serving = sender.run();
    await settle();
    expect(frames).toHaveLength(1);

    const second = sender.run();

    expect(await settledWithin(second)).toBe('settled');
    await expect(second).rejects.toThrowError(ProtocolError);
    await expect(second).rejects.toThrowError(/only be called once/i);
    await settle();
    expect(frames).toHaveLength(1);

    sender.abort();
    await serving;
  });

  it('resolves promptly when the signal is aborted while the share sits idle', async () => {
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const controller = new AbortController();
    const sender = new SenderSession(a, shared, list(), { pollIntervalMs: 0 });
    const connecting = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    }).run();
    const serving = sender.run(controller.signal);
    await connecting;
    await settle();

    setTimeout(() => controller.abort(), 5);

    expect(await settledWithin(serving)).toBe('settled');
  });

  it('sends nothing at all when the signal was already aborted before the run', async () => {
    const { a, b } = createLoopbackPair();
    const frames = encryptedFrames(b);
    const controller = new AbortController();
    controller.abort();
    const sender = new SenderSession(a, await key(), list(), { pollIntervalMs: 0 });

    await expect(sender.run(controller.signal)).resolves.toBeUndefined();
    await settle();

    expect(frames).toHaveLength(0);
  });

  it('closes the channel when the receiver sends something the sender cannot use', async () => {
    const { a, b } = createLoopbackPair();
    let closedRemotely = false;
    b.onClose(() => {
      closedRemotely = true;
    });
    const sender = new SenderSession(a, await key(), list(), { pollIntervalMs: 0 });
    const serving = sender.run();
    await settle();

    b.send(serializeControl({ t: 'accept' }));

    await expect(serving).rejects.toThrowError(ProtocolError);
    expect(closedRemotely).toBe(true);
  });

  it('closes the channel when a transfer fails, so a dead peer cannot hold it open', async () => {
    const { a, b } = createLoopbackPair();
    let closedRemotely = false;
    b.onClose(() => {
      closedRemotely = true;
    });
    const shared = await key();
    const sender = new SenderSession(a, shared, list(), { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () =>
        ({
          write: () => Promise.reject(new Error('the disk is full')),
          close: () => Promise.resolve(),
          abort: () => {},
        }) as Sink,
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    await expect(receiver.select(0)).rejects.toThrowError('the disk is full');
    await expect(serving).rejects.toThrowError(/disk is full/i);

    expect(closedRemotely).toBe(true);
  });

  it('closes the channel on a normal finish, once the share is over', async () => {
    const { b, receiver, serving } = await connect(list(), await key());
    let closedRemotely = false;
    b.onClose(() => {
      closedRemotely = true;
    });

    await receiver.finish();

    await expect(serving).resolves.toBeUndefined();
    expect(closedRemotely).toBe(true);
  });

  it('keeps an idle share open past the per-file stall timeout, because a reader browses', async () => {
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sender = new SenderSession(a, shared, list(), { pollIntervalMs: 0, stallTimeoutMs: 10 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
      stallTimeoutMs: 10,
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(await settledWithin(serving)).toBe('pending');

    await receiver.select(0);
    await receiver.finish();
    await serving;
  });
});

describe('once the share is over', () => {
  it('refuses a file requested after the share is over, without opening a destination', async () => {
    const files = list();
    const { a, b } = createLoopbackPair();
    const shared = await key();
    let opened = 0;
    const sender = new SenderSession(a, shared, files, { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => {
        opened += 1;
        return new MemorySink();
      },
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    await receiver.finish();
    await serving;

    await expect(receiver.select(0)).rejects.toThrowError(/share is over/i);
    expect(opened).toBe(0);
  });

  it('does not send a finish on a connection that has already closed', async () => {
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sender = new SenderSession(a, shared, list(), { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    sender.abort();
    await serving;

    await expect(receiver.finish()).rejects.toThrowError(CLOSE_MESSAGES.remote);
  });
});

describe('a share that ends while a destination is still opening', () => {
  it('does not report a failed transfer when the receiver finished on purpose', async () => {
    const files = list();
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const opened = deferredSink();
    const sender = new SenderSession(a, shared, files, { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: () => opened.promise,
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    const selecting = receiver.select(0);
    await settle();
    await receiver.finish();
    await serving;

    const sink = trackingSink();
    const outcome = expect(selecting).rejects.not.toThrowError(CLOSE_MESSAGES.remote);
    opened.release(sink);
    await outcome;
    expect(sink.aborted()).toBe(true);
  });

  it('still reports the close reason when the share is interrupted before any finish', async () => {
    const files = list();
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const opened = deferredSink();
    const sender = new SenderSession(a, shared, files, { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: () => opened.promise,
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    const selecting = receiver.select(0);
    await settle();
    a.close();

    const sink = trackingSink();
    const outcome = expect(selecting).rejects.toThrowError(CLOSE_MESSAGES.remote);
    opened.release(sink);
    await outcome;
    expect(sink.aborted()).toBe(true);
    await serving.catch(() => undefined);
  });
});

describe('the next select is never lost to a finishing engine', () => {
  it('serves a select that arrives the instant the previous file completes', async () => {
    const files = [new File([new Uint8Array(64)], 'a.bin'), new File([new Uint8Array(64)], 'b.bin')];
    let second: Promise<unknown> = Promise.resolve();
    const { receiver, sinks, serving } = await connect(files, await key(), () => {
      second = receiver.select(1).then(() => receiver.finish());
    });

    await receiver.select(0);
    await second;
    await serving;

    expect(sinks).toHaveLength(2);
    expect(sinks[0]?.toUint8Array()).toEqual(await bytesOf(files[0] as File));
    expect(sinks[1]?.toUint8Array()).toEqual(await bytesOf(files[1] as File));
  });

  it('queues a select that arrives while the sender engine is still running', async () => {
    const files = [new File([new Uint8Array(64)], 'a.bin'), new File([new Uint8Array(64)], 'b.bin')];
    const { b, sender, receiver, sinks } = await connect(files, await key());

    await receiver.select(0);
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX + 1 }));
    await settle();
    receiver.abort();
    await sender.run().catch(() => undefined);

    expect(sinks).toHaveLength(1);
  });

  it('finishes cleanly when finish arrives before any select', async () => {
    const { receiver, sender, serving } = await connect(list(), await key());
    await receiver.finish();
    await expect(serving).resolves.toBeUndefined();
    sender.abort();
  });
});

describe('session progress reporting', () => {
  it('reports progress against the selected file only, and completes it once', async () => {
    const files = [new File([new Uint8Array(CHUNK_SIZE * 2 + 5)], 'big.bin')];
    const progress: bigint[] = [];
    const completed: number[] = [];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const options: SenderSessionOptions = {
      pollIntervalMs: 0,
      onProgress: (_index, sent) => progress.push(sent),
      onComplete: (index) => completed.push(index),
    };
    const sender = new SenderSession(a, shared, files, options);
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    await receiver.select(0);
    await receiver.finish();
    await serving;

    expect(progress.at(-1)).toBe(BigInt(CHUNK_SIZE * 2 + 5));
    expect(completed).toEqual([0]);
  });

  it('reports which file started, so a multi-file UI can label the row', async () => {
    const started: number[] = [];
    const files = list();
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onTransferStart: (index) => started.push(index),
    });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    await receiver.select(1);
    await receiver.select(2);
    await receiver.finish();
    await serving;

    expect(started).toEqual([1, 2]);
  });

  it('does not report a completion for a transfer the receiver abandoned', async () => {
    const completed: number[] = [];
    const files = [new File([new Uint8Array(CHUNK_SIZE * 400)], 'huge.bin')];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onComplete: (index) => completed.push(index),
    });
    const connecting = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    }).run();
    const serving = sender.run();
    await connecting;
    await settle();

    b.close();
    await serving.catch(() => undefined);
    expect(completed).toEqual([]);
  });
});

describe('the receiver learns that the sender went away', () => {
  it('reports a close while the receiver is sitting idle on the file list', async () => {
    const { a, b } = createLoopbackPair();
    void a;
    const shared = await key();
    const closed: CloseReason[] = [];
    const sender = new SenderSession(a, shared, list(), { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
      onDisconnect: (reason) => closed.push(reason),
    });

    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    // The sender goes away: its side closes, which the receiver reads as remote.
    sender.abort();
    a.close();

    expect(closed).toEqual(['remote']);
    await serving.catch(() => undefined);
  });

  it('reports the first close reason only, since one failure can fire twice', async () => {
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const closed: CloseReason[] = [];
    const sender = new SenderSession(a, shared, list(), { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
      onDisconnect: (reason) => closed.push(reason),
    });

    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    sender.abort();
    a.close();
    a.close();

    expect(closed).toHaveLength(1);
    expect(closed[0]).toBe('remote');
    await serving.catch(() => undefined);
  });

  it('stays silent when the receiver itself finished the share', async () => {
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const closed: CloseReason[] = [];
    const sender = new SenderSession(a, shared, list(), { pollIntervalMs: 0 });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
      onDisconnect: (reason) => closed.push(reason),
    });

    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    await receiver.finish();
    await serving;
    await settle();

    expect(closed).toEqual([]);
  });
});
