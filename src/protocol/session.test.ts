import { describe, expect, it } from 'vitest';
import { buildBinding, CHUNK_DOMAIN, CHUNK_SIZE, encryptChunk } from '../crypto/chunks';
import { generateRawKey, importRawKey } from '../crypto/keys';
import { MemorySink } from '../sink/memory';
import type { Sink } from '../sink/sink';
import type { Channel, ChannelMessage, CloseReason } from '../transport/channel';
import { createLoopbackPair } from '../transport/loopback';
import {
  encryptManifest,
  FIRST_FILE_INDEX,
  manifestFromFiles,
  type ManifestEntry,
} from './manifest';
import { ProtocolError, serializeControl, parseControl, type ControlMessage } from './messages';
import { ReceiverSession, SenderSession, type SenderSessionOptions } from './session';
import { CLOSE_MESSAGES, TransferCancelledError } from './transfer';

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

// One shared buffer, so the tests that need a transfer still in flight when the
// peer leaves do not each allocate 26 MB. Only the size matters to them.
const inFlightBytes: Uint8Array<ArrayBuffer> = new Uint8Array(CHUNK_SIZE * 400);

const inFlightFile = (): File => new File([inFlightBytes], 'huge.bin');

// A peer that speaks the control protocol by hand, so a test can act at the one
// wire moment it cares about — including inside the gap between the sender's
// last chunk and the receiver's acknowledgement, which a real receiver never
// leaves open.
const scriptedPeer = (channel: Channel, onControl: (control: ControlMessage) => void): void => {
  channel.onMessage((msg) => {
    if (typeof msg !== 'string') return;
    onControl(parseControl(msg));
  });
};

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

  it('does not report a completion for a transfer it aborted itself', async () => {
    const files = [inFlightFile()];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const completed: number[] = [];
    const failures: string[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
    });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    const selecting = receiver.select(0).catch(() => undefined);
    await settle();

    sender.abort();
    await expect(serving).resolves.toBeUndefined();
    await selecting;
    expect(completed).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('does not report a completion for a transfer cancelled by its signal', async () => {
    // The same reporting as an abort() above, reached through the signal, so
    // the two ways of stopping a session cannot drift apart.
    const files = [inFlightFile()];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const controller = new AbortController();
    const completed: number[] = [];
    const failures: string[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
    });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run(controller.signal);
    await connecting;
    const selecting = receiver.select(0).catch(() => undefined);
    await settle();

    controller.abort();
    await expect(serving).resolves.toBeUndefined();
    await selecting;
    expect(completed).toEqual([]);
    expect(failures).toEqual([]);
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

  it('does not report a completion for a transfer that never started', async () => {
    const completed: number[] = [];
    const files = [inFlightFile()];
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

describe('a receiver disconnecting', () => {
  it('reports a disconnect when the peer closes the channel mid-share', async () => {
    const { a, b } = createLoopbackPair();
    const reasons: string[] = [];
    const sender = new SenderSession(a, await key(), list(), {
      pollIntervalMs: 0,
      onDisconnect: (reason) => reasons.push(reason),
    });
    const serving = sender.run();
    await settle();
    b.close();
    await serving;
    expect(reasons).toEqual(['remote']);
  });

  it('stays silent when the sender aborts the session itself', async () => {
    const { a } = createLoopbackPair();
    const reasons: string[] = [];
    const sender = new SenderSession(a, await key(), list(), {
      pollIntervalMs: 0,
      onDisconnect: (reason) => reasons.push(reason),
    });
    const serving = sender.run();
    await settle();
    sender.abort();
    await serving;
    expect(reasons).toEqual([]);
  });

  it('stays silent when the receiver finishes the share normally', async () => {
    const files = list();
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const reasons: string[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onDisconnect: (reason) => reasons.push(reason),
    });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await receiver.finish();
    await serving;
    await settle();
    expect(reasons).toEqual([]);
  });

  it('does not call onComplete for a transfer the receiver abandoned', async () => {
    // Big enough that the transfer is still in flight when the peer leaves.
    const files = [inFlightFile()];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const completed: number[] = [];
    const failures: string[] = [];
    const reasons: CloseReason[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
      onDisconnect: (reason) => reasons.push(reason),
    });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    const selecting = receiver.select(0);
    await settle();
    b.close();
    await Promise.all([selecting.catch(() => undefined), serving.catch(() => undefined)]);
    expect(completed).toEqual([]);
    expect(failures).toEqual([]);
    // The same event, reported as a disconnect rather than as a transfer.
    expect(reasons).toEqual(['remote']);
  });

  it('says nothing at all when the peer leaves after the last chunk, before it acknowledges', async () => {
    // Two chunks, so the whole file goes out and the sender is left waiting on
    // the acknowledgement when the peer leaves. That gap is the only way into
    // the error path: a close during the send loop resolves instead, and the
    // engine reports itself stopped rather than throwing.
    const files = [new File([new Uint8Array(CHUNK_SIZE + 5)], 'small.bin')];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const completed: number[] = [];
    const failures: string[] = [];
    const reasons: CloseReason[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
      onDisconnect: (reason) => reasons.push(reason),
    });
    scriptedPeer(b, (control) => {
      if (control.t === 'offer') b.send(serializeControl({ t: 'accept' }));
      // Everything the sender is going to send has arrived. Leave, unacknowledged.
      if (control.t === 'done') b.close();
    });
    const serving = sender.run();
    await settle();
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));

    await expect(serving).rejects.toThrowError(/never confirmed/i);
    expect(completed).toEqual([]);
    expect(failures).toEqual([]);
    expect(reasons).toEqual(['remote']);
  });

  it('still reports a real failure on a connection that is still open', async () => {
    // The same wire moment as the test above, and the opposite answer: the peer
    // is still there and says the transfer broke, so the sender must say so too.
    const files = [new File([new Uint8Array(CHUNK_SIZE + 5)], 'small.bin')];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const completed: number[] = [];
    const failures: string[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
    });
    scriptedPeer(b, (control) => {
      if (control.t === 'offer') b.send(serializeControl({ t: 'accept' }));
      if (control.t === 'done') {
        b.send(serializeControl({ t: 'error', message: 'the disk is full' }));
      }
    });
    const serving = sender.run();
    await settle();
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));

    await expect(serving).rejects.toThrowError(/disk is full/i);
    expect(completed).toEqual([]);
    expect(failures).toEqual(['the disk is full']);
  });

  it('still reports a delivery the receiver confirmed, when the connection drops afterwards', async () => {
    const files = list();
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const completed: number[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onComplete: (index) => completed.push(index),
    });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;
    await settle();

    // select() resolves once the receiver has written the file and sent its
    // acknowledgement, so the delivery is confirmed before the peer leaves.
    await receiver.select(0);
    b.close();
    await serving;

    expect(completed).toEqual([0]);
  });
});

describe('cancelling a selection', () => {
  const big = new File([new Uint8Array(CHUNK_SIZE * 8)], 'big.bin');
  const small = new File([new Uint8Array(64)], 'small.bin');

  // A sender driven a frame at a time, so a test can hold a transfer in flight
  // for exactly as long as it needs and then hand over a second file. How the
  // real sender reacts to a cancel is another task's business; what these
  // tests are about is what the receiver's own cancel does to the share.
  const streamFor = async (
    shared: CryptoKey,
    file: File,
    wireIndex: number,
  ): Promise<ChannelMessage[]> => {
    const total = BigInt(file.size);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const frames: ChannelMessage[] = [serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE })];
    for (let offset = 0, i = 0; offset < bytes.length; offset += CHUNK_SIZE, i += 1) {
      const part = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
      frames.push(
        await encryptChunk(
          shared,
          part,
          wireIndex,
          BigInt(i),
          buildBinding(CHUNK_DOMAIN, wireIndex, total),
        ),
      );
    }
    frames.push(serializeControl({ t: 'done' }));
    return frames;
  };

  const share = async (files: File[], onComplete?: (index: number) => void) => {
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sinks: MemorySink[] = [];
    const aborts: number[] = [];
    const controls: ControlMessage[] = [];
    const closes: CloseReason[] = [];
    a.onMessage((msg: ChannelMessage) => {
      if (typeof msg === 'string') controls.push(parseControl(msg));
    });
    b.onClose((reason) => closes.push(reason));
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => {
        const sink = new MemorySink();
        sinks.push(sink);
        return {
          write: (chunk: Uint8Array) => sink.write(chunk),
          close: () => sink.close(),
          abort: () => {
            aborts.push(sinks.length);
            sink.abort();
          },
        };
      },
      onManifest: () => {},
      onComplete,
    });
    const connecting = receiver.run();
    a.send(await encryptManifest(shared, manifestFromFiles(files)));
    await connecting;

    return { a, shared, receiver, sinks, aborts, controls, closes };
  };

  const selects = (controls: ControlMessage[]): ControlMessage[] =>
    controls.filter((control) => control.t === 'select');

  it('sends a cancel for the wire index, and keeps the channel for the next file', async () => {
    const files = [big, small];
    const completed: number[] = [];
    const { a, shared, receiver, sinks, aborts, controls, closes } = await share(files, (index) =>
      completed.push(index),
    );

    const controller = new AbortController();
    const selecting = receiver.select(0, controller.signal);
    await settle();
    const first = await streamFor(shared, big, FIRST_FILE_INDEX);
    a.send(first[0] as ChannelMessage);
    await settle();
    a.send(first[1] as ChannelMessage);
    await settle();

    controller.abort();

    await expect(selecting).rejects.toThrowError(TransferCancelledError);
    expect(controls).toContainEqual({ t: 'cancel', index: FIRST_FILE_INDEX });
    expect(controls).toContainEqual({ t: 'select', index: FIRST_FILE_INDEX });
    expect(controls.filter((c) => c.t === 'error')).toEqual([]);
    expect(aborts, 'the half-written destination is released once').toEqual([1]);
    expect(completed, 'a file the receiver skipped is not a delivery').toEqual([]);
    // A close is deferred by a turn, so this has to outlast the turn it is
    // looking for. 'local' is the receiver's own close; the share it just lost
    // one file of is still there.
    await settle();
    expect(closes).toEqual([]);

    const selectingNext = receiver.select(1);
    // Asked for now, and not sent until the sender says it has finished with
    // the file it cancelled. An engine subscribed in the meantime would meet
    // the rest of that file's chunks and read the first as its own offer.
    await settle();
    expect(selects(controls)).toEqual([{ t: 'select', index: FIRST_FILE_INDEX }]);

    // A sender in no hurry to oblige: the chunks it had already put on the
    // wire when the cancel arrived, and nothing yet to say they have stopped.
    for (const frame of first.slice(2, -1)) a.send(frame);
    await settle();
    expect(selects(controls), 'the sender was still sending the cancelled file').toEqual([
      { t: 'select', index: FIRST_FILE_INDEX },
    ]);

    // This one had already finished the file by the time the cancel landed, so
    // its done is the last frame that index will ever produce.
    a.send(first[first.length - 1] as ChannelMessage);
    for (const frame of await streamFor(shared, small, FIRST_FILE_INDEX + 1)) a.send(frame);
    await selectingNext;

    expect(selects(controls)).toEqual([
      { t: 'select', index: FIRST_FILE_INDEX },
      { t: 'select', index: FIRST_FILE_INDEX + 1 },
    ]);
    expect(completed).toEqual([1]);
    expect(sinks[1]?.toUint8Array()).toEqual(await bytesOf(small));
    expect(closes).toEqual([]);
  });

  it('waits for the sender to say the cancelled file has stopped, not for its done', async () => {
    // The other way a sender can leave: stopped part-way, so there is no done
    // coming and the only thing that ends the wait is the terminator. The frame
    // is the sender's to send and this commit's sender does not send it yet, so
    // a hand-driven peer stands in for one.
    const { a, shared, receiver, controls, closes } = await share([big, small]);
    const controller = new AbortController();
    const selecting = receiver.select(0, controller.signal);
    await settle();
    const first = await streamFor(shared, big, FIRST_FILE_INDEX);
    a.send(first[0] as ChannelMessage);
    await settle();
    a.send(first[1] as ChannelMessage);
    await settle();
    controller.abort();
    await expect(selecting).rejects.toThrowError(TransferCancelledError);

    const selectingNext = receiver.select(1);
    for (const frame of first.slice(2, -1)) a.send(frame);
    a.send(serializeControl({ t: 'cancelled', index: FIRST_FILE_INDEX }));
    for (const frame of await streamFor(shared, small, FIRST_FILE_INDEX + 1)) a.send(frame);
    await selectingNext;

    expect(selects(controls)).toEqual([
      { t: 'select', index: FIRST_FILE_INDEX },
      { t: 'select', index: FIRST_FILE_INDEX + 1 },
    ]);
    expect(closes).toEqual([]);
  });

  it('is answered by a sender that stops serving, not by a protocol error', async () => {
    // The receiver's half on its own. How a sender answers a cancel, and what
    // it takes to keep the share, is the describe below.
    const files = [new File([new Uint8Array(CHUNK_SIZE * 40)], 'big.bin')];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const controller = new AbortController();
    const failures: string[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onError: (_index, message) => failures.push(message),
    });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => new MemorySink(),
      onManifest: () => {},
      onProgress: (_index, received) => {
        if (received > 0n) controller.abort();
      },
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;

    await expect(receiver.select(0, controller.signal)).rejects.toThrowError(TransferCancelledError);
    expect(await settledWithin(serving, 200)).toBe('pending');
    expect(failures, 'the sender did not close over the cancelled file').toEqual([]);

    sender.abort();
    await serving;
  });
});

describe('a receiver cancelling a transfer', () => {
  // 400 chunks, so a cancel can always land while there is file left to stop;
  // and one chunk, so a transfer can be over before a test's cancel arrives.
  const endless = inFlightFile;
  const oneChunk = new File([new Uint8Array(64)], 'one.bin');
  const endlessTotal = BigInt(inFlightBytes.byteLength);

  type Wire = { kind: 'control'; control: ControlMessage } | { kind: 'chunk' };

  // Everything the sender puts on the wire, in order, so a test can say what
  // came last for a file and not merely that a frame arrived at some point.
  // Subscribed once the manifest has gone: that is one binary frame too, and
  // counting it would put every chunk's counter one out.
  const wireLog = (channel: Channel): Wire[] => {
    const log: Wire[] = [];
    channel.onMessage((msg) => {
      log.push(
        typeof msg === 'string' ? { kind: 'control', control: parseControl(msg) } : { kind: 'chunk' },
      );
    });
    return log;
  };

  const tagsOf = (frames: Wire[]): string[] =>
    frames.map((frame) => (frame.kind === 'chunk' ? 'chunk' : frame.control.t));

  const isTag =
    (tag: string) =>
    (frame: Wire): boolean =>
      frame.kind === 'control' && frame.control.t === tag;

  const terminators = (log: Wire[]): ControlMessage[] =>
    log
      .filter(isTag('cancelled'))
      .map((frame) => (frame as { kind: 'control'; control: ControlMessage }).control);

  // A peer that drives a real SenderSession a frame at a time, so a test can
  // act at the wire moments the sender does not control. Reports how many
  // chunks have arrived since it was subscribed.
  const handDriven = (
    channel: Channel,
    hooks: {
      onChunk?: (seen: number) => void;
      onControl?: (control: ControlMessage) => void;
    },
  ): (() => number) => {
    let seen = 0;
    channel.onMessage((msg) => {
      if (typeof msg !== 'string') {
        seen += 1;
        hooks.onChunk?.(seen);
        return;
      }
      hooks.onControl?.(parseControl(msg));
    });
    return () => seen;
  };

  // Sealed frames for an index, as a peer with no business sending them would
  // produce them. The chunk numbers are far outside any real stream, so one
  // that turned up in a file's own run of chunks would be unmistakable.
  const sealedFrames = async (
    shared: CryptoKey,
    wireIndex: number,
  ): Promise<ChannelMessage[]> => {
    const frames: ChannelMessage[] = [];
    for (const chunkIndex of [900n, 901n]) {
      frames.push(
        await encryptChunk(
          shared,
          new Uint8Array(64),
          wireIndex,
          chunkIndex,
          buildBinding(CHUNK_DOMAIN, wireIndex, endlessTotal),
        ),
      );
    }
    return frames;
  };

  it('stops serving a file the receiver cancelled, instead of finishing it', async () => {
    // The regression this commit exists for. A cancel arrives precisely while
    // the handler drops every frame that is not a select or a finish, so with
    // no intercept above that filter the send loop runs all 400 chunks and the
    // file the receiver stopped is delivered to it anyway.
    const files = [endless(), oneChunk];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const cancelled: number[] = [];
    const completed: number[] = [];
    const failures: string[] = [];
    let report!: (index: number) => void;
    const firstCancel = new Promise<number>((resolve) => {
      report = resolve;
    });
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onCancel: (index) => {
        cancelled.push(index);
        report(index);
      },
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
    });
    const serving = sender.run();
    await settle();
    const chunks = handDriven(b, {
      onChunk: (seen) => {
        if (seen === 2) b.send(serializeControl({ t: 'cancel', index: FIRST_FILE_INDEX }));
      },
      onControl: (control) => {
        if (control.t === 'offer') b.send(serializeControl({ t: 'accept' }));
      },
    });
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));

    expect(await settledWithin(firstCancel), 'the abort reaches the send loop').toBe('settled');
    expect(cancelled).toEqual([0]);
    expect(completed, 'a file the receiver stopped is not a delivery').toEqual([]);
    expect(failures, 'the receiver asked for this, so it is not a failure').toEqual([]);
    expect(chunks(), 'the send loop stopped short of the whole file').toBeLessThan(20);
    expect(await settledWithin(serving), 'the session is still serving').toBe('pending');

    b.send(serializeControl({ t: 'finish' }));
    await expect(serving).resolves.toBeUndefined();
  });

  it('answers a cancel with one terminator, after the last frame it had sent for that file', async () => {
    // The receiver drains the frames this sender had already put on the wire,
    // on a deadline, and past it the next file fails. So the last of this
    // file's frames has to be said out loud, and said here: after everything
    // the engine sent for this index and before the loop serves the next
    // select, because the receiver stops discarding at that frame and anything
    // after it lands on the next file's engine. It carries the wire index the
    // cancel named, which the receiver's drain cannot check -- it ends on any
    // control frame -- so a mismatched index is a wrong answer that works.
    const files = [endless(), oneChunk];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const failures: string[] = [];
    let report!: () => void;
    const answered = new Promise<void>((resolve) => {
      report = resolve;
    });
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onError: (_index, message) => failures.push(message),
    });
    const serving = sender.run();
    await settle();
    const log = wireLog(b);
    handDriven(b, {
      onChunk: (seen) => {
        if (seen === 2) b.send(serializeControl({ t: 'cancel', index: FIRST_FILE_INDEX }));
      },
      onControl: (control) => {
        if (control.t === 'offer') b.send(serializeControl({ t: 'accept' }));
        if (control.t === 'cancelled') report();
      },
    });
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));

    expect(await settledWithin(answered)).toBe('settled');
    expect(terminators(log), 'exactly one terminator, for the index the cancel named').toEqual([
      { t: 'cancelled', index: FIRST_FILE_INDEX },
    ]);
    const at = log.findIndex(isTag('cancelled'));
    expect(
      log.slice(0, at).filter((frame) => frame.kind === 'chunk').length,
      'the chunk already on its way when the cancel arrived went before it',
    ).toBeGreaterThan(0);
    expect(tagsOf(log.slice(at + 1)), 'nothing for that file may follow the terminator').toEqual([]);

    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX + 1 }));
    await settle();
    expect(tagsOf(log.slice(at + 1)), 'the next file is served only after it').toEqual([
      'offer',
      'chunk',
      'done',
    ]);

    b.send(serializeControl({ t: 'done' }));
    b.send(serializeControl({ t: 'finish' }));
    await expect(serving).resolves.toBeUndefined();
    expect(failures).toEqual([]);
  });

  it('serves the next file whatever the peer does after the cancel', async () => {
    // The property the whole feature exists for, asked of a peer that is not
    // cooperative. It keeps putting the cancelled file's own sealed frames on
    // the wire after the cancel, cancels the same index a second time, sends a
    // terminator of its own that it has no standing to send, and cancels the
    // file it is about to ask for. None of that is the sender's to answer, and
    // none of it may cost the share the next file is on.
    const files = [endless(), oneChunk];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const rude = await sealedFrames(shared, FIRST_FILE_INDEX);
    const log: Wire[] = [];
    const cancelled: number[] = [];
    const completed: number[] = [];
    const failures: string[] = [];
    let report!: () => void;
    const answered = new Promise<void>((resolve) => {
      report = resolve;
    });
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onCancel: (index) => cancelled.push(index),
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
    });
    const serving = sender.run();
    await settle();
    handDriven(b, {
      onChunk: (seen) => {
        // While the transfer is still in flight, so these land on the engine
        // that is mid-file rather than in the session's own queue, where file
        // data is a protocol error in its own right.
        if (seen === 2) {
          b.send(serializeControl({ t: 'cancel', index: FIRST_FILE_INDEX }));
          for (const frame of rude) b.send(frame);
        }
      },
      onControl: (control) => {
        if (control.t === 'offer') b.send(serializeControl({ t: 'accept' }));
        if (control.t === 'cancelled' && control.index === FIRST_FILE_INDEX) {
          log.push({ kind: 'control', control });
          report();
          // None of this is the sender's to answer, and none of it may be
          // answered: a terminator naming the file about to start would end
          // that file's own drain before it had read anything.
          b.send(serializeControl({ t: 'cancel', index: FIRST_FILE_INDEX }));
          b.send(serializeControl({ t: 'cancelled', index: FIRST_FILE_INDEX + 1 }));
          b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX + 1 }));
        }
      },
    });
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));

    expect(await settledWithin(answered)).toBe('settled');
    await settle();
    b.send(serializeControl({ t: 'done' }));
    await settle();

    expect(completed, 'the file the receiver went on to ask for still arrives').toEqual([1]);
    expect(cancelled, 'a cancel for the file in flight is reported once').toEqual([0]);
    expect(failures).toEqual([]);
    expect(
      terminators(log).filter((control) => control.t === 'cancelled' && control.index === FIRST_FILE_INDEX + 1),
      'no terminator for a cancel the sender was not serving',
    ).toEqual([]);
    expect(await settledWithin(serving), 'the session is still serving').toBe('pending');

    b.send(serializeControl({ t: 'finish' }));
    await expect(serving).resolves.toBeUndefined();
  });

  it('ignores a cancel for a file that is not in flight', async () => {
    // A stale cancel -- one naming the file that has just been delivered, and
    // one for an index that was never offered at all -- must neither abort a
    // transfer nor be answered. The index is the whole hazard here: a cancel
    // left lying about for the file that was just finished names the very next
    // transfer if the peer asks for that same index again, which is why the
    // re-selection below is of the file the stale cancels point at.
    const files = [oneChunk, endless()];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const cancelled: number[] = [];
    const completed: number[] = [];
    const failures: string[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onCancel: (index) => cancelled.push(index),
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
    });
    const serving = sender.run();
    await settle();
    const log = wireLog(b);
    const chunks = handDriven(b, {
      onControl: (control) => {
        if (control.t === 'offer') b.send(serializeControl({ t: 'accept' }));
        if (control.t === 'done') b.send(serializeControl({ t: 'done' }));
      },
    });
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));
    await settle();

    // The session is idle here, with nothing in flight and a delivered file
    // behind it, which is where a cancel that has been overtaken by the sender
    // actually turns up.
    b.send(serializeControl({ t: 'cancel', index: FIRST_FILE_INDEX }));
    b.send(serializeControl({ t: 'cancel', index: FIRST_FILE_INDEX + 40 }));
    await settle();
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));
    await settle();
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX + 1 }));

    expect(await settledWithin(serving.then(() => 'settled', () => 'settled')), 'still serving').toBe(
      'pending',
    );
    expect(completed).toEqual([0, 0, 1]);
    expect(cancelled, 'a cancel the sender did not act on is not a cancellation').toEqual([]);
    expect(failures).toEqual([]);
    expect(terminators(log), 'an unacted-on cancel gets no terminator').toEqual([]);
    expect(chunks(), 'the first file went out again, and the second went out whole').toBe(2 + 400);

    b.send(serializeControl({ t: 'finish' }));
    await expect(serving).resolves.toBeUndefined();
  });

  it('treats a cancel that arrives where the acknowledgement goes as a cancel, not a failure', async () => {
    // The sender is past the file: every chunk and its done have already gone,
    // so the engine meets the cancel where it expected the receiver's own done
    // and reads it as a protocol error. It is not one here. The receiver asked
    // it to stop, and letting the error through would both put a spurious
    // failure on the sender's own UI and end the share over the file the
    // receiver chose to skip.
    const files = [new File([new Uint8Array(CHUNK_SIZE + 5)], 'small.bin'), oneChunk];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const cancelled: number[] = [];
    const completed: number[] = [];
    const failures: string[] = [];
    let firstDone = true;
    let report!: () => void;
    const answered = new Promise<void>((resolve) => {
      report = resolve;
    });
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onCancel: (index) => cancelled.push(index),
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
    });
    const serving = sender.run();
    await settle();
    const log = wireLog(b);
    handDriven(b, {
      onControl: (control) => {
        if (control.t === 'offer') b.send(serializeControl({ t: 'accept' }));
        if (control.t === 'done' && firstDone) {
          firstDone = false;
          // Every frame for this index has gone. What the receiver owes now is
          // the acknowledgement, and instead it cancels.
          b.send(serializeControl({ t: 'cancel', index: FIRST_FILE_INDEX }));
          return;
        }
        if (control.t === 'done') b.send(serializeControl({ t: 'done' }));
        if (control.t === 'cancelled') report();
      },
    });
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));

    expect(await settledWithin(answered)).toBe('settled');
    expect(cancelled).toEqual([0]);
    expect(completed, 'nothing confirmed the delivery, so nothing is a delivery').toEqual([]);
    expect(failures, 'the receiver said stop, so this is not a failed transfer').toEqual([]);
    expect(terminators(log)).toEqual([{ t: 'cancelled', index: FIRST_FILE_INDEX }]);

    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX + 1 }));
    await settle();
    b.send(serializeControl({ t: 'finish' }));
    await expect(serving).resolves.toBeUndefined();
    expect(completed).toEqual([1]);
  });

  it('reports a cancel, not a failure, when the engine throws while cancelled', async () => {
    // The one path left where a skip could be reported as a failure. Most of
    // the time the abort settles the engine's wait before anything throws. A
    // stall or a failure the receiver reported is raised ahead of the engine's
    // own abort check, so the engine throws with serving.cancelled already true,
    // and that lands in serve's catch. This was reachable and untested, and it
    // is the feature's central promise, so it gets its own test.
    const files = [endless(), oneChunk];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const cancelled: number[] = [];
    const completed: number[] = [];
    const failures: string[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onCancel: (index) => cancelled.push(index),
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
    });
    const serving = sender.run();
    await settle();
    const log = wireLog(b);
    handDriven(b, {
      onControl: (control) => {
        if (control.t === 'offer') b.send(serializeControl({ t: 'accept' }));
        if (control.t === 'done') b.send(serializeControl({ t: 'done' }));
        if (control.t === 'cancelled') b.send(serializeControl({ t: 'finish' }));
      },
    });
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));
    await settle();

    // Mid-transfer: the engine is sending chunks, raiseRemoteFailure runs
    // before its abort check, so the error below is what it throws.
    b.send(serializeControl({ t: 'error', message: 'The disk went away.' }));
    b.send(serializeControl({ t: 'cancel', index: FIRST_FILE_INDEX }));
    await settle();
    await settle();

    expect(cancelled, 'the receiver asked to stop, so it is a cancel').toEqual([0]);
    expect(failures, 'and not a failure the sender would put on its own row').toEqual([]);
    expect(
      terminators(log),
      'without the terminator the receiver drains to its deadline and the next file dies',
    ).toEqual([{ t: 'cancelled', index: FIRST_FILE_INDEX }]);
    expect(completed, 'nothing confirmed this one, so the share moves on').toEqual([]);

    b.send(serializeControl({ t: 'finish' }));
    await expect(serving).resolves.toBeUndefined();
  });

  it('does not end the share over a cancelled frame the peer sent of its own accord', async () => {
    // The terminator is the sender's to send. A peer that sends one is not
    // speaking, and ending the share over it would be the sender refusing to
    // go on with a share that is still perfectly good.
    const files = [oneChunk, oneChunk];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const completed: number[] = [];
    const failures: string[] = [];
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
    });
    const serving = sender.run();
    await settle();
    handDriven(b, {
      onControl: (control) => {
        if (control.t === 'offer') b.send(serializeControl({ t: 'accept' }));
        if (control.t === 'done') b.send(serializeControl({ t: 'done' }));
      },
    });

    // While the session sits idle with nothing in flight, where the frame goes
    // straight to the loop rather than through the busy filter.
    b.send(serializeControl({ t: 'cancelled', index: FIRST_FILE_INDEX }));
    await settle();
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));
    await settle();
    b.send(serializeControl({ t: 'select', index: FIRST_FILE_INDEX + 1 }));
    await settle();
    b.send(serializeControl({ t: 'finish' }));

    await expect(serving).resolves.toBeUndefined();
    expect(completed).toEqual([0, 1]);
    expect(failures).toEqual([]);
  });

  it('reports the cancel and keeps the connection, with a real receiver cancelling', async () => {
    // Both halves of the feature at once, over a real channel: the receiver
    // stops itself, drains what the sender had already put on the wire, and the
    // next file lands on the same connection.
    const files = [endless(), oneChunk];
    const { a, b } = createLoopbackPair();
    const shared = await key();
    const sinks: MemorySink[] = [];
    const aborted: number[] = [];
    const cancelled: number[] = [];
    const completed: number[] = [];
    const failures: string[] = [];
    const controller = new AbortController();
    const sender = new SenderSession(a, shared, files, {
      pollIntervalMs: 0,
      onCancel: (index) => cancelled.push(index),
      onComplete: (index) => completed.push(index),
      onError: (_index, message) => failures.push(message),
    });
    const receiver = new ReceiverSession(b, shared, {
      openSink: async () => {
        const sink = new MemorySink();
        sinks.push(sink);
        return {
          write: (chunk: Uint8Array) => sink.write(chunk),
          close: () => sink.close(),
          abort: () => {
            aborted.push(sinks.length);
            sink.abort();
          },
        };
      },
      onManifest: () => {},
      onProgress: (_index, received) => {
        if (received > 0n) controller.abort();
      },
    });
    const connecting = receiver.run();
    const serving = sender.run();
    await connecting;

    const selecting = receiver.select(0, controller.signal);
    await expect(selecting).rejects.toThrowError(TransferCancelledError);

    // Asked for at once, so it waits on the cancelled file's drain. A sender
    // that never said the last of its frames has gone would leave this waiting
    // out the drain's 60s ceiling and then failing, so the select below is
    // where the terminator is proved.
    await receiver.select(1);
    await receiver.finish();
    await expect(serving).resolves.toBeUndefined();

    expect(cancelled).toEqual([0]);
    expect(completed).toEqual([1]);
    expect(failures).toEqual([]);
    expect(sinks).toHaveLength(2);
    expect(aborted, 'the half-written destination is released once').toEqual([1]);
    expect(sinks[1]?.toUint8Array()).toEqual(await bytesOf(oneChunk));
  });
});
