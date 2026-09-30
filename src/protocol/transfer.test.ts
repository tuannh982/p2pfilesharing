import { describe, expect, it, vi } from 'vitest';
import {
  buildBinding,
  CHUNK_DOMAIN,
  CHUNK_SIZE,
  TAG_BYTES,
  DecryptionError,
  decryptChunk,
  encryptChunk,
} from '../crypto/chunks';
import { generateRawKey, importRawKey } from '../crypto/keys';
import { MemorySink } from '../sink/memory';
import type { Sink } from '../sink/sink';
import type { Channel, ChannelMessage, CloseReason } from '../transport/channel';
import { createLoopbackPair } from '../transport/loopback';
import { FIRST_FILE_INDEX, MANIFEST_FILE_INDEX } from './manifest';
import {
  MAX_PEER_TEXT,
  parseControl,
  ProtocolError,
  serializeControl,
  type ControlMessage,
} from './messages';
import { ReceiverSession, SenderSession } from './session';
import {
  CLOSE_MESSAGES,
  DEFAULT_STALL_TIMEOUT_MS,
  DeliveryUnconfirmedError,
  MAX_STEPPED_FRAMES,
  ReceiverEngine,
  SenderEngine,
  SenderStalledError,
  TransferCancelledError,
  TransferDeclinedError,
  TransferStalledError,
  TruncatedTransferError,
  type ReceiverState,
  type SenderState,
} from './transfer';

const RANDOM_LIMIT = 65536;

const FILE_INDEX = FIRST_FILE_INDEX;

// File index 0 is MANIFEST_FILE_INDEX, reserved for the encrypted file list.
// A test that encrypts or decrypts at 0 would be asserting against the
// manifest's nonce, which is the exact collision this design exists to
// prevent, and would pass while proving nothing about a real file.
it('uses a file index that cannot collide with the reserved manifest index', () => {
  expect(FILE_INDEX).toBe(MANIFEST_FILE_INDEX + 1);
});

const randomBlob = (size: number): Blob => {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += RANDOM_LIMIT) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + RANDOM_LIMIT, size)));
  }
  return new Blob([bytes]);
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// A hang is a failure mode of its own, and one that only shows up as a bare
// suite timeout. This gives a promise a deadline so a stalled engine says
// which deadline it missed.
const within = <T>(ms: number, promise: Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`nothing settled in ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });

interface Recorder {
  frames: ArrayBuffer[];
  controls: ControlMessage[];
}

const watch = (channel: Channel, into: Recorder = { frames: [], controls: [] }): Recorder => {
  const { frames, controls } = into;
  channel.onMessage((m: ChannelMessage) => {
    if (typeof m === 'string') controls.push(parseControl(m));
    else frames.push(m);
  });
  return into;
};

const withBufferedAmount = (base: Channel, read: () => number): Channel => ({
  send: (m) => base.send(m),
  onMessage: (cb) => base.onMessage(cb),
  onClose: (cb) => base.onClose(cb),
  close: () => base.close(),
  get bufferedAmount() {
    return read();
  },
});

class SpySink implements Sink {
  writes = 0;
  closes = 0;
  aborts = 0;
  private chunks: Uint8Array[] = [];
  private total = 0;

  get byteLength(): number {
    return this.total;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.writes += 1;
    this.chunks.push(chunk.slice());
    this.total += chunk.length;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }

  abort(): void {
    this.aborts += 1;
    this.chunks = [];
    this.total = 0;
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

const createManualPeer = () => {
  const inbound: ((msg: ChannelMessage) => void)[] = [];
  const inboundClose: ((reason: CloseReason) => void)[] = [];
  const outbound: ((msg: ChannelMessage) => void)[] = [];
  const outboundClose: ((reason: CloseReason) => void)[] = [];
  const sent: ChannelMessage[] = [];
  let closeCalls = 0;

  const channel: Channel = {
    send: (msg) => {
      sent.push(msg);
      for (const cb of outbound) cb(msg);
    },
    onMessage: (cb) => {
      inbound.push(cb);
    },
    onClose: (cb) => {
      inboundClose.push(cb);
    },
    close: () => {
      closeCalls += 1;
      for (const cb of outboundClose) cb('local');
    },
    bufferedAmount: 0,
  };

  return {
    channel,
    sent,
    closeCalls: () => closeCalls,
    controls: () => sent.filter((m): m is string => typeof m === 'string').map((m) => parseControl(m)),
    frames: () => sent.filter((m): m is ArrayBuffer => m instanceof ArrayBuffer),
    deliver: (msg: ChannelMessage) => {
      for (const cb of inbound) cb(msg);
    },
    drop: (reason: CloseReason) => {
      for (const cb of inboundClose) cb(reason);
    },
  };
};

const playAcceptingReceiver = (channel: Channel): void => {
  channel.onMessage((msg) => {
    if (typeof msg !== 'string') return;
    const control = parseControl(msg);
    if (control.t === 'offer') channel.send(serializeControl({ t: 'accept' }));
    if (control.t === 'done') channel.send(serializeControl({ t: 'done' }));
  });
};

const pacedBlob = (size: number, gapMs: number): Blob => {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += RANDOM_LIMIT) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + RANDOM_LIMIT, size)));
  }
  const backing = new Blob([bytes]);
  return {
    get size() {
      return backing.size;
    },
    slice: (start, end) => {
      const part = backing.slice(start, end);
      return {
        get size() {
          return part.size;
        },
        arrayBuffer: async () => {
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          return part.arrayBuffer();
        },
      } as Blob;
    },
    type: backing.type,
  } as Blob;
};

// A real signal, wrapped so a test can count what the engine adds to it and
// what it hands back. Leaking one listener per chunk is invisible from the
// outside, so it has to be measured rather than reasoned about.
const countingSignal = (): {
  signal: AbortSignal;
  added: () => number;
  removed: () => number;
} => {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  return {
    signal: {
      get aborted() {
        return controller.signal.aborted;
      },
      addEventListener: (...args: Parameters<AbortSignal['addEventListener']>) => {
        added += 1;
        controller.signal.addEventListener(...args);
      },
      removeEventListener: (...args: Parameters<AbortSignal['removeEventListener']>) => {
        removed += 1;
        controller.signal.removeEventListener(...args);
      },
    } as unknown as AbortSignal,
    added: () => added,
    removed: () => removed,
  };
};

const createPollingChannel = (): { channel: Channel; peak: () => number } => {
  let inflight = 0;
  let highWater = 0;
  let polls = 0;
  let inbound: ((msg: ChannelMessage) => void) | null = null;
  return {
    channel: {
      send: (m) => {
        inflight += typeof m === 'string' ? m.length : m.byteLength;
        highWater = Math.max(highWater, inflight);
        if (typeof m === 'string') {
          const control = parseControl(m);
          if (control.t === 'offer') inbound?.(serializeControl({ t: 'accept' }));
          if (control.t === 'done') inbound?.(serializeControl({ t: 'done' }));
        }
      },
      onMessage: (cb) => {
        inbound = cb;
      },
      onClose: () => {},
      close: () => {},
      get bufferedAmount() {
        polls += 1;
        if (polls > 1) inflight = 0;
        return inflight;
      },
    },
    peak: () => highWater,
  };
};

describe('CLOSE_MESSAGES', () => {
  it('gives every close reason its own distinct message', () => {
    const reasons: CloseReason[] = ['local', 'remote', 'error', 'transport-failure'];
    expect(Object.keys(CLOSE_MESSAGES).sort()).toEqual([...reasons].sort());

    const messages = reasons.map((reason) => CLOSE_MESSAGES[reason]);
    for (const message of messages) expect(message.length).toBeGreaterThan(0);
    expect(new Set(messages).size).toBe(reasons.length);
  });
});

describe('SenderEngine', () => {
  it('sends only an offer and a done for an empty file', async () => {
    const { a, b } = createLoopbackPair();
    const seen = watch(b);
    playAcceptingReceiver(b);
    const engine = new SenderEngine(a, new Blob([]), await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX });

    await engine.run();
    await settle();

    expect(seen.frames).toHaveLength(0);
    expect(seen.controls).toEqual([
      { t: 'offer', chunkSize: CHUNK_SIZE },
      { t: 'done' },
    ]);
    expect(engine.state).toBe('completed');
  });

  it('splits a file into 64 KiB frames with one short final frame', async () => {
    const { a, b } = createLoopbackPair();
    const seen = watch(b);
    playAcceptingReceiver(b);
    const size = CHUNK_SIZE * 2 + 17;
    const engine = new SenderEngine(a, randomBlob(size), await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX });

    await engine.run();
    await settle();

    expect(seen.frames).toHaveLength(3);
    expect(seen.frames[0]?.byteLength).toBe(CHUNK_SIZE + TAG_BYTES);
    expect(seen.frames[1]?.byteLength).toBe(CHUNK_SIZE + TAG_BYTES);
    expect(seen.frames[2]?.byteLength).toBe(17 + TAG_BYTES);
  });

  it('never places plaintext on the channel', async () => {
    const { a, b } = createLoopbackPair();
    const seen = watch(b);
    playAcceptingReceiver(b);
    const secret = randomBlob(4096);
    const engine = new SenderEngine(a, secret, await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX });

    await engine.run();
    await settle();

    expect(seen.frames.length).toBeGreaterThan(0);
    const plain = new Uint8Array(await secret.arrayBuffer());
    expect(new Uint8Array(seen.frames[0] as ArrayBuffer)).not.toEqual(plain);
  });

  it('produces frames the matching key decrypts, in order and at the right offsets', async () => {
    const raw = await generateRawKey();
    const key = await importRawKey(raw);
    const size = CHUNK_SIZE + 100;
    const secret = randomBlob(size);
    const expected = new Uint8Array(await secret.arrayBuffer());
    const { a, b } = createLoopbackPair();
    const seen = watch(b);
    playAcceptingReceiver(b);

    await new SenderEngine(a, secret, key, { fileIndex: FILE_INDEX }).run();
    await settle();

    expect(seen.frames.length).toBe(2);
    for (let i = 0; i < seen.frames.length; i += 1) {
      const got = await decryptChunk(
        key,
        seen.frames[i] as ArrayBuffer,
        FILE_INDEX,
        BigInt(i),
        buildBinding(CHUNK_DOMAIN, FILE_INDEX, BigInt(size)),
      );
      const start = i * CHUNK_SIZE;
      expect(got).toEqual(expected.subarray(start, start + got.length));
    }
  });

  it('reports monotonic progress ending exactly at the file size', async () => {
    const size = CHUNK_SIZE * 3 + 5;
    const progress: bigint[] = [];
    const { a, b } = createLoopbackPair();
    watch(b);
    playAcceptingReceiver(b);

    const engine = new SenderEngine(a, randomBlob(size), await importRawKey(await generateRawKey()), {
      fileIndex: FILE_INDEX,
      onProgress: (sent) => progress.push(sent),
    });
    await engine.run();

    expect(progress).toHaveLength(4);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i] as bigint).toBeGreaterThan(progress[i - 1] as bigint);
    }
    expect(progress.at(-1)).toBe(BigInt(size));
  });

  it('holds the queue at the high-water mark instead of buffering the whole file', async () => {
    const { a, b } = createLoopbackPair();
    playAcceptingReceiver(b);
    let peak = 0;
    const gauge = withBufferedAmount(a, () => a.bufferedAmount);
    const counted: Channel = {
      send: (m) => {
        gauge.send(m);
        peak = Math.max(peak, a.bufferedAmount);
      },
      onMessage: (cb) => gauge.onMessage(cb),
      onClose: (cb) => gauge.onClose(cb),
      close: () => gauge.close(),
      get bufferedAmount() {
        return gauge.bufferedAmount;
      },
    };

    const engine = new SenderEngine(
      counted,
      randomBlob(CHUNK_SIZE * 40),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, highWaterMark: 1024, pollIntervalMs: 0 },
    );
    await engine.run();

    expect(peak).toBeLessThanOrEqual(1024 + CHUNK_SIZE + TAG_BYTES);
    expect(engine.state).toBe('completed');
  });

  it('consults bufferedAmount between chunks instead of sending the whole file ahead', async () => {
    const { channel, peak } = createPollingChannel();
    const engine = new SenderEngine(
      channel,
      randomBlob(CHUNK_SIZE * 40),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, highWaterMark: 1024, pollIntervalMs: 0 },
    );
    await engine.run();

    expect(peak()).toBeLessThanOrEqual(1024 + CHUNK_SIZE + TAG_BYTES);
    expect(engine.state).toBe('completed');
  });

  it('stops when aborted mid-transfer, saying nothing to the peer', async () => {
    // An abort is a receiver's cancel, and the receiver knows it asked. What
    // tells the sender apart from one that stopped is what follows -- a select,
    // or a closed channel -- so the frame that would claim otherwise is not just
    // unnecessary, it is the one the receiver's drain is meant to end on instead
    // of the terminator behind it.
    const { a, b } = createLoopbackPair();
    const seen = watch(b);
    playAcceptingReceiver(b);
    const controller = new AbortController();

    const engine = new SenderEngine(
      a,
      randomBlob(CHUNK_SIZE * 500),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, onProgress: () => controller.abort(), pollIntervalMs: 0 },
    );
    await engine.run(controller.signal);
    await settle();

    expect(engine.state).toBe('aborted');
    expect(seen.frames.length).toBeLessThan(500);
    expect(
      seen.controls.filter((c) => c.t === 'error'),
      'the sender did not stop sharing, and the receiver is the one that knows why',
    ).toEqual([]);
  });

  it('stops when the receiver disconnects', async () => {
    const { a, b } = createLoopbackPair();
    playAcceptingReceiver(b);
    const engine = new SenderEngine(
      a,
      randomBlob(CHUNK_SIZE * 500),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, onProgress: () => b.close(), pollIntervalMs: 0 },
    );
    await engine.run();
    expect(engine.state).toBe('aborted');
  });

  it('stops the transfer when abort() is called, without a signal', async () => {
    const { a, b } = createLoopbackPair();
    const seen = watch(b);
    playAcceptingReceiver(b);
    const engine = new SenderEngine(
      a,
      randomBlob(CHUNK_SIZE * 500),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, onProgress: () => engine.abort(), pollIntervalMs: 0 },
    );

    await engine.run();
    await settle();

    expect(engine.state).toBe('aborted');
    expect(seen.controls).not.toContainEqual({ t: 'done' });
    expect(seen.frames.length).toBeLessThan(500);
  });

  it('sends nothing past the offer when aborted, and never a done', async () => {
    // The same path, asked of the whole frame sequence rather than of one frame:
    // a file cut short owes the peer nothing, so the only control frames left on
    // the wire are the offer it was answering and the ones the peer sent. A done
    // here would be worse than silence -- it is the frame a receiver writes the
    // file on.
    const { a, b } = createLoopbackPair();
    const seen = watch(b);
    playAcceptingReceiver(b);
    const controller = new AbortController();

    const engine = new SenderEngine(
      a,
      randomBlob(CHUNK_SIZE * 500),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, onProgress: () => controller.abort(), pollIntervalMs: 0 },
    );
    await engine.run(controller.signal);
    await settle();

    expect(
      seen.controls.map((c) => c.t),
      'a cut-short file is left unfinished in every way the wire can show',
    ).toEqual(['offer']);
    expect(seen.controls).not.toContainEqual({ t: 'done' });
    expect(seen.controls).not.toContainEqual({ t: 'cancelled' });
  });

  it('reports failed and rethrows when the channel throws mid-transfer', async () => {
    const { a, b } = createLoopbackPair();
    watch(b);
    playAcceptingReceiver(b);
    let sends = 0;
    const exploding: Channel = {
      send: (m) => {
        sends += 1;
        if (sends > 2) throw new Error('socket exploded');
        a.send(m);
      },
      onMessage: (cb) => a.onMessage(cb),
      onClose: (cb) => a.onClose(cb),
      close: () => a.close(),
      get bufferedAmount() {
        return a.bufferedAmount;
      },
    };

    const engine = new SenderEngine(
      exploding,
      randomBlob(CHUNK_SIZE * 10),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, pollIntervalMs: 0 },
    );

    await expect(engine.run()).rejects.toThrowError('socket exploded');
    expect(engine.state).toBe('failed');
  });

  it('reports each state transition in order', async () => {
    const { a, b } = createLoopbackPair();
    watch(b);
    playAcceptingReceiver(b);
    const states: string[] = [];

    const engine = new SenderEngine(a, randomBlob(10), await importRawKey(await generateRawKey()), {
      fileIndex: FILE_INDEX,
      onStateChange: (s) => states.push(s),
    });
    expect(states).toEqual(['idle']);
    await engine.run();
    expect(states).toEqual(['idle', 'sending', 'sent', 'completed']);
  });

  it('sends nothing but the offer until the receiver accepts', async () => {
    const peer = createManualPeer();
    const size = CHUNK_SIZE + 5;
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(size),
      await importRawKey(await generateRawKey()), { fileIndex: FILE_INDEX },
    );

    const running = engine.run();
    await settle();

    expect(peer.controls()).toEqual([
      { t: 'offer', chunkSize: CHUNK_SIZE },
    ]);
    expect(peer.frames()).toHaveLength(0);
    expect(engine.state).toBe('sending');

    peer.deliver(serializeControl({ t: 'accept' }));
    await settle();
    expect(peer.frames()).toHaveLength(2);

    peer.deliver(serializeControl({ t: 'done' }));
    await running;
  });

  it('stops on a reject, sends no frames, and surfaces the receiver reason', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE * 4),
      await importRawKey(await generateRawKey()), { fileIndex: FILE_INDEX },
    );

    const running = engine.run();
    await settle();
    peer.deliver(serializeControl({ t: 'reject', reason: 'That is not the file I asked for.' }));

    await expect(running).rejects.toThrowError(TransferDeclinedError);
    await expect(running).rejects.toThrowError('That is not the file I asked for.');
    expect(peer.frames()).toHaveLength(0);
    expect(peer.controls().map((c) => c.t)).toEqual(['offer']);
    expect(engine.state).toBe('aborted');
  });

  it('treats an error control while waiting for consent as an abort', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE * 4),
      await importRawKey(await generateRawKey()), { fileIndex: FILE_INDEX },
    );

    const running = engine.run();
    await settle();
    // Whatever the peer said, verbatim. The text is the peer's to choose, so
    // there is nothing here to match against production wording.
    peer.deliver(serializeControl({ t: 'error', message: 'peer said no (arbitrary text)' }));

    await expect(running).resolves.toBeUndefined();
    expect(peer.frames()).toHaveLength(0);
    expect(engine.state).toBe('aborted');
  });

  it('treats a close while waiting for consent as an abort', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE * 4),
      await importRawKey(await generateRawKey()), { fileIndex: FILE_INDEX },
    );

    const running = engine.run();
    await settle();
    peer.drop('remote');

    await expect(running).resolves.toBeUndefined();
    expect(peer.frames()).toHaveLength(0);
    expect(engine.state).toBe('aborted');
  });

  it('stops waiting for consent when the abort signal fires', async () => {
    const peer = createManualPeer();
    const controller = new AbortController();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE * 4),
      await importRawKey(await generateRawKey()), { fileIndex: FILE_INDEX },
    );

    const running = engine.run(controller.signal);
    await settle();
    controller.abort();

    await expect(running).resolves.toBeUndefined();
    expect(peer.frames()).toHaveLength(0);
    expect(engine.state).toBe('aborted');
  });

  it('stops waiting for consent when abort() is called', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE * 4),
      await importRawKey(await generateRawKey()), { fileIndex: FILE_INDEX },
    );

    const running = engine.run();
    await settle();
    engine.abort();

    await expect(running).resolves.toBeUndefined();
    expect(peer.frames()).toHaveLength(0);
    expect(engine.state).toBe('aborted');
  });

  it('refuses to stream when the first control message is not a consent', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE * 4),
      await importRawKey(await generateRawKey()), { fileIndex: FILE_INDEX },
    );

    const running = engine.run();
    await settle();
    peer.deliver(serializeControl({ t: 'done' }));

    await expect(running).rejects.toThrowError(ProtocolError);
    expect(peer.frames()).toHaveLength(0);
    expect(engine.state).toBe('failed');
  });
});

describe('SenderEngine delivery confirmation', () => {
  it('does not report completed until the receiver acknowledges', async () => {
    const peer = createManualPeer();
    const states: SenderState[] = [];
    const size = CHUNK_SIZE + 3;
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(size),
      await importRawKey(await generateRawKey()),
      {
        fileIndex: FILE_INDEX,
        onStateChange: (state) => states.push(state),
      },
    );

    const running = engine.run();
    await settle();
    peer.deliver(serializeControl({ t: 'accept' }));
    await settle();

    expect(engine.state).toBe('sent');
    expect(states).toEqual(['idle', 'sending', 'sent']);

    peer.deliver(serializeControl({ t: 'done' }));
    await running;

    expect(engine.state).toBe('completed');
  });

  it('does not report completed when the receiver write fails after the last frame', async () => {
    const key = await importRawKey(await generateRawKey());
    const size = CHUNK_SIZE + 3;
    const { a, b } = createLoopbackPair();
    const sink = new SpySink();
    const sender = new SenderEngine(a, randomBlob(size), key, { fileIndex: FILE_INDEX, pollIntervalMs: 0 });
    const receiver = new ReceiverEngine(
      b,
      key,
      { size: BigInt(size) },
      {
        write: () => Promise.reject(new Error('the disk is full')),
        close: () => Promise.resolve(),
        abort: () => {},
      },
      { fileIndex: FILE_INDEX },
    );

    const sending = sender.run();
    const receiving = receiver.run();

    await expect(receiving).rejects.toThrowError('the disk is full');
    await sending.catch(() => undefined);
    expect(sender.state).not.toBe('completed');
    expect(sink.aborts).toBe(0);
  });

  it('reports unconfirmed rather than completed when the connection closes before the ack', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE + 3),
      await importRawKey(await generateRawKey()), { fileIndex: FILE_INDEX },
    );

    const running = engine.run();
    await settle();
    peer.deliver(serializeControl({ t: 'accept' }));
    await settle();
    expect(engine.state).toBe('sent');

    peer.drop('remote');

    await expect(running).rejects.toThrowError(DeliveryUnconfirmedError);
    expect(engine.state).toBe('failed');
  });

  it('surfaces the reason when the receiver fails while the sender waits for the ack', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE + 3),
      await importRawKey(await generateRawKey()), { fileIndex: FILE_INDEX },
    );

    const running = engine.run();
    await settle();
    peer.deliver(serializeControl({ t: 'accept' }));
    await settle();
    peer.deliver(serializeControl({ t: 'error', message: 'The disk is full.' }));

    await expect(running).rejects.toThrowError('The disk is full.');
    expect(engine.state).toBe('failed');
  });

  it('stops waiting for the ack when abort() is called after the last frame', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE + 3),
      await importRawKey(await generateRawKey()), { fileIndex: FILE_INDEX },
    );

    const running = engine.run();
    await settle();
    peer.deliver(serializeControl({ t: 'accept' }));
    await settle();
    expect(engine.state).toBe('sent');

    engine.abort();

    await expect(running).resolves.toBeUndefined();
    expect(engine.state).toBe('aborted');
  });

  it('counts a full round trip as completed once the receiver has written the file', async () => {
    const key = await importRawKey(await generateRawKey());
    const size = CHUNK_SIZE * 2 + 9;
    const { a, b } = createLoopbackPair();
    const sink = new SpySink();
    const sender = new SenderEngine(a, randomBlob(size), key, { fileIndex: FILE_INDEX, pollIntervalMs: 0 });
    const receiver = new ReceiverEngine(b, key,
      { size: BigInt(size) }, sink, { fileIndex: FILE_INDEX });

    const sending = sender.run();
    const receiving = receiver.run();
    await Promise.all([sending, receiving]);

    expect(sink.closes).toBe(1);
    expect(sender.state).toBe('completed');
    expect(receiver.state).toBe('completed');
  });
});

describe('ReceiverEngine', () => {
  const transfer = async (
    size: number,
    key: Uint8Array,
    tamper?: (frame: Uint8Array, index: number) => void,
  ) => {
    const keyHandle = await importRawKey(key);
    const secret = randomBlob(size);
    const { a, b } = createLoopbackPair();
    const seen = watch(b);
    watch(a, seen);
    const sink = new SpySink();
    const events: ReceiverState[] = [];
    let framesSeen = 0;

    const outbound: Channel = {
      send: (m) => {
        if (m instanceof ArrayBuffer) {
          const copy = new Uint8Array(m);
          tamper?.(copy, framesSeen);
          framesSeen += 1;
          a.send(copy.buffer);
          return;
        }
        a.send(m);
      },
      onMessage: (cb) => a.onMessage(cb),
      onClose: (cb) => a.onClose(cb),
      close: () => a.close(),
      get bufferedAmount() {
        return a.bufferedAmount;
      },
    };

    const receiver = new ReceiverEngine(
      b,
      keyHandle,
      { size: BigInt(size) },
      sink,
      { fileIndex: FILE_INDEX, onStateChange: (s) => events.push(s) },
    );
    const receiving = receiver.run();
    const sending = new SenderEngine(outbound, secret, keyHandle,
      { fileIndex: FILE_INDEX, pollIntervalMs: 0 }).run();
    await Promise.all([receiving, sending.catch(() => undefined)]);

    return { sink, secret, events, seen };
  };

  it('reassembles the file byte for byte across chunk boundaries', async () => {
    const size = CHUNK_SIZE * 2 + 1234;
    const { sink, secret } = await transfer(size, await generateRawKey());
    expect(sink.byteLength).toBe(size);
    expect(sink.toUint8Array()).toEqual(new Uint8Array(await secret.arrayBuffer()));
  });

  it('closes the sink exactly once and never aborts it on the happy path', async () => {
    const size = CHUNK_SIZE * 2 + 5;
    const { sink } = await transfer(size, await generateRawKey());
    expect(sink.writes).toBe(3);
    expect(sink.closes).toBe(1);
    expect(sink.aborts).toBe(0);
  });

  it('never aborts an already-closed sink when completed fails after the close', async () => {
    const key = await importRawKey(await generateRawKey());
    const size = CHUNK_SIZE + 11;
    const { a, b } = createLoopbackPair();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(b, key, { size: BigInt(size) }, sink, { fileIndex: FILE_INDEX,
      onStateChange: (state) => {
        if (state === 'completed') throw new Error('caller blew up on completed');
      },
    });

    const receiving = receiver.run();
    await new SenderEngine(a, randomBlob(size), key, { fileIndex: FILE_INDEX, pollIntervalMs: 0 }).run();

    await expect(receiving).rejects.toThrowError(/caller blew up on completed/);
    expect(sink.closes).toBe(1);
    expect(sink.aborts).toBe(0);
    expect(receiver.state).toBe('failed');
  });

  it('answers a valid offer with accept and a completed transfer with done', async () => {
    const size = CHUNK_SIZE + 9;
    const { seen } = await transfer(size, await generateRawKey());
    expect(seen.controls).toEqual([
      { t: 'offer', chunkSize: CHUNK_SIZE },
      { t: 'accept' },
      { t: 'done' },
      { t: 'done' },
    ]);
  });

  it('buffers messages that arrive before run() is called', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const sink = new MemorySink();
    const secret = randomBlob(500);
    const plain = new Uint8Array(await secret.arrayBuffer());
    const receiver = new ReceiverEngine(b, key, { size: 500n }, sink, { fileIndex: FILE_INDEX });

    a.send(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    a.send(
      await encryptChunk(key, plain, FILE_INDEX, 0n, buildBinding(CHUNK_DOMAIN, FILE_INDEX, 500n)),
    );
    a.send(serializeControl({ t: 'done' }));
    await settle();

    expect(receiver.state).toBe('idle');
    await receiver.run();

    expect(sink.toUint8Array()).toEqual(plain);
    expect(receiver.state).toBe('completed');
  });

  it('completes a zero-byte file', async () => {
    const { sink, events } = await transfer(0, await generateRawKey());
    expect(sink.byteLength).toBe(0);
    expect(events).toEqual(['idle', 'awaiting-offer', 'receiving', 'completed']);
  });

  it('reports monotonic progress ending exactly at the file size', async () => {
    const key = await generateRawKey();
    const size = CHUNK_SIZE * 2 + 9;
    const { a, b } = createLoopbackPair();
    const sink = new MemorySink();
    const progress: bigint[] = [];

    const receiver = new ReceiverEngine(
      b,
      await importRawKey(key),
      { size: BigInt(size) },
      sink,
      { fileIndex: FILE_INDEX, onProgress: (received) => progress.push(received) },
    );
    const receiving = receiver.run();
    await new SenderEngine(a, randomBlob(size), await importRawKey(key),
      { fileIndex: FILE_INDEX, pollIntervalMs: 0 }).run();
    await receiving;

    expect(progress.at(-1)).toBe(BigInt(size));
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i] as bigint).toBeGreaterThan(progress[i - 1] as bigint);
    }
  });

  it('reports the real failure even when the sink throws while aborting', async () => {
    // A sink that throws on abort must not replace the actual transfer error,
    // and must not leave the engine half-torn-down: state has to reach
    // 'failed' and the channel has to close.
    const key = await importRawKey(await generateRawKey());
    const size = CHUNK_SIZE * 2;
    const { a, b } = createLoopbackPair();
    let closed = 0;
    b.onClose(() => {
      closed += 1;
    });
    const receiver = new ReceiverEngine(
      b,
      key,
      { size: BigInt(size) },
      {
        write: () => Promise.reject(new Error('the disk is full')),
        close: () => Promise.resolve(),
        abort: () => {
          throw new TypeError('writable?.abort is not a function');
        },
      },
      { fileIndex: FIRST_FILE_INDEX },
    );

    const receiving = receiver.run();
    const sending = new SenderEngine(a, randomBlob(size), key, {
      fileIndex: FIRST_FILE_INDEX,
      pollIntervalMs: 0,
    }).run();

    await expect(receiving).rejects.toThrow('the disk is full');
    await sending.catch(() => undefined);
    expect(receiver.state).toBe('failed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(1);
  });

  it('fails with DecryptionError when a ciphertext bit is flipped', async () => {
    await expect(
      transfer(CHUNK_SIZE + 100, await generateRawKey(), (frame, i) => {
        if (i === 1) frame[5] = (frame[5] as number) ^ 0x01;
      }),
    ).rejects.toThrowError(/integrity check failed/i);
  });

  it('fails with DecryptionError when the key does not match the sender', async () => {
    const { a, b } = createLoopbackPair();
    const size = 1000;
    const receiver = new ReceiverEngine(
      b,
      await importRawKey(await generateRawKey()),
      { size: BigInt(size) },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();
    const sending = new SenderEngine(a, randomBlob(size), await importRawKey(await generateRawKey()), {
      fileIndex: FILE_INDEX,
      pollIntervalMs: 0,
    }).run();
    await expect(receiving).rejects.toThrowError(/integrity check failed/i);
    await sending.catch(() => undefined);
  });

  it('surfaces the reason when the sender aborts', async () => {
    const key = await generateRawKey();
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverEngine(
      b,
      await importRawKey(key),
      { size: 10n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();
    a.send(serializeControl({ t: 'error', message: 'The sender stopped sharing.' }));
    await expect(receiving).rejects.toThrowError('The sender stopped sharing.');
  });

  it('detects a short file even after a well-formed done', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(b, key,
      { size: 1000n }, sink, { fileIndex: FILE_INDEX });
    const receiving = receiver.run();

    a.send(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    a.send(
      await encryptChunk(
        key,
        new Uint8Array(400),
        FILE_INDEX,
        0n,
        buildBinding(CHUNK_DOMAIN, FILE_INDEX, 1000n),
      ),
    );
    a.send(serializeControl({ t: 'done' }));

    await expect(receiving).rejects.toThrowError(TruncatedTransferError);
    expect(sink.byteLength).toBe(0);
    expect(sink.aborts).toBe(1);
    expect(sink.closes).toBe(0);
  });

  it('fails promptly when the sender disconnects instead of hanging', async () => {
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverEngine(
      b,
      await importRawKey(await generateRawKey()),
      { size: 100n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();
    a.close();
    await expect(receiving).rejects.toThrowError(/connection closed/i);
    expect(receiver.state).toBe('failed');
  });

  it('fails with the close reason when the peer drops after a frame is in flight', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(
      peer.channel,
      key,
      { size: 1000n },
      sink, { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();

    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(
      await encryptChunk(
        key,
        new Uint8Array(400),
        FILE_INDEX,
        0n,
        buildBinding(CHUNK_DOMAIN, FILE_INDEX, 1000n),
      ),
    );
    peer.drop('remote');

    await expect(receiving).rejects.toThrowError(/connection closed/i);
    expect(sink.writes).toBe(1);
    expect(sink.aborts).toBe(1);
    expect(sink.closes).toBe(0);
    expect(receiver.state).toBe('failed');
  });

  it('fails promptly when the connection closes before run() is called', async () => {
    const peer = createManualPeer();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(
      peer.channel,
      await importRawKey(await generateRawKey()),
      { size: 100n },
      sink, { fileIndex: FILE_INDEX },
    );

    peer.drop('remote');

    await expect(receiver.run()).rejects.toThrowError(/connection closed/i);
    expect(receiver.state).toBe('failed');
    expect(sink.aborts).toBe(1);
    expect(sink.closes).toBe(0);
  });

  it('reports the first close reason when the peer closes twice', async () => {
    const peer = createManualPeer();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(
      peer.channel,
      await importRawKey(await generateRawKey()),
      { size: 100n },
      sink, { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();

    peer.drop('transport-failure');
    peer.drop('remote');

    await expect(receiving).rejects.toThrowError(CLOSE_MESSAGES['transport-failure']);
    await expect(receiving).rejects.not.toThrowError(CLOSE_MESSAGES.remote);
    expect(receiver.state).toBe('failed');
    expect(sink.aborts).toBe(1);
  });

  it('refuses a stream whose tag names a different file index', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const seen = watch(a);
    const sink = new SpySink();
    const receiver = new ReceiverEngine(
      b,
      key,
      { size: 1000n },
      sink, { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();

    // The right key, a frame that fits the declared size, and an offer the
    // receiver has no reason to refuse: the tag is the only thing that knows
    // this stream was sealed for another file, so it has to be the gate.
    a.send(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    a.send(
      await encryptChunk(
        key,
        new Uint8Array(400),
        FILE_INDEX,
        0n,
        buildBinding(CHUNK_DOMAIN, FILE_INDEX + 1, 1000n),
      ),
    );

    await expect(receiving).rejects.toThrowError(DecryptionError);
    expect(sink.writes).toBe(0);
    expect(sink.aborts).toBe(1);
    expect(receiver.state).toBe('failed');
    expect(seen.controls).toEqual([{ t: 'accept' }]);
  });

  it('rejects an offer with an unsupported chunk size', async () => {
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverEngine(
      b,
      await importRawKey(await generateRawKey()),
      { size: 1000n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();
    a.send(serializeControl({ t: 'offer', chunkSize: 4096 }));
    await expect(receiving).rejects.toThrowError(/chunk size/i);
  });

  it('rejects an offer followed by more data than it declared', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverEngine(
      b,
      key,
      { size: 10n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();
    a.send(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    a.send(
      await encryptChunk(
        key,
        new Uint8Array(50),
        FILE_INDEX,
        0n,
        buildBinding(CHUNK_DOMAIN, FILE_INDEX, 10n),
      ),
    );
    await expect(receiving).rejects.toThrowError(/more data than it declared/i);
  });

  it('rejects an oversized frame on its ciphertext length, before decrypting it', async () => {
    const key = await importRawKey(await generateRawKey());
    const stranger = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverEngine(
      b,
      key,
      { size: 10n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      const receiving = receiver.run();
      a.send(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
      await settle();
      a.send(
        await encryptChunk(
          stranger,
          new Uint8Array(50),
          FILE_INDEX,
          0n,
          buildBinding(CHUNK_DOMAIN, FILE_INDEX, 10n),
        ),
      );

      await expect(receiving).rejects.toThrowError(/more data than it declared/i);
      expect(decrypt).not.toHaveBeenCalled();
    } finally {
      decrypt.mockRestore();
    }
  });

  it('closes the channel when the transfer fails', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const receiver = new ReceiverEngine(
      peer.channel,
      key,
      { size: 100n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );

    const receiving = receiver.run();
    peer.deliver(serializeControl({ t: 'error', message: 'The sender stopped sharing.' }));

    await expect(receiving).rejects.toThrowError('The sender stopped sharing.');
    expect(peer.closeCalls()).toBe(0);
    await settle();
    expect(peer.closeCalls()).toBe(1);
  });

  it('still delivers its reason to the peer before closing the channel', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const receiver = new ReceiverEngine(
      peer.channel,
      key,
      { size: 1000n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();

    // A refused offer is the one refusal that still has something to say: a
    // stream it cannot authenticate is not refused at all, it fails later.
    peer.deliver(serializeControl({ t: 'offer', chunkSize: 4096 }));

    await expect(receiving).rejects.toThrowError(/chunk size/i);
    await settle();
    expect(peer.sent).toEqual([
      serializeControl({ t: 'error', message: 'Unsupported chunk size 4096.' }),
    ]);
  });

  it('does not close the channel on the happy path', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    let closes = 0;
    b.onClose(() => {
      closes += 1;
    });
    const receiver = new ReceiverEngine(b, key,
      { size: 10n }, new MemorySink(), { fileIndex: FILE_INDEX });
    const receiving = receiver.run();
    await new SenderEngine(a, randomBlob(10), key, { fileIndex: FILE_INDEX, pollIntervalMs: 0 }).run();
    await receiving;
    await settle();

    expect(receiver.state).toBe('completed');
    expect(closes).toBe(0);
  });
});

describe('ReceiverEngine stall timeout', () => {
  it('is generous enough to outlast any plausible gap between chunks', () => {
    expect(DEFAULT_STALL_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it('fails with a labelled timeout when the sender goes quiet mid-transfer', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(
      peer.channel,
      key,
      { size: 1000n },
      sink,
      { fileIndex: FILE_INDEX, stallTimeoutMs: 10 },
    );

    const receiving = receiver.run();
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(
      await encryptChunk(
        key,
        new Uint8Array(400),
        FILE_INDEX,
        0n,
        buildBinding(CHUNK_DOMAIN, FILE_INDEX, 1000n),
      ),
    );
    await settle();

    await expect(receiving).rejects.toThrowError(TransferStalledError);
    await expect(receiving).rejects.toThrowError(/went quiet for 0s/i);
    expect(receiver.state).toBe('failed');
    expect(sink.aborts).toBe(1);
    expect(sink.closes).toBe(0);
  });

  it('fails with a timeout when the sender never offers at all', async () => {
    const peer = createManualPeer();
    const receiver = new ReceiverEngine(
      peer.channel,
      await importRawKey(await generateRawKey()),
      { size: 100n },
      new MemorySink(),
      { fileIndex: FILE_INDEX, stallTimeoutMs: 10 },
    );

    await expect(receiver.run()).rejects.toThrowError(TransferStalledError);
    expect(receiver.state).toBe('failed');
  });

  it('keeps waiting while chunks keep arriving inside the window', async () => {
    const key = await importRawKey(await generateRawKey());
    const size = CHUNK_SIZE + 1;
    const peer = createManualPeer();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(
      peer.channel,
      key,
      { size: BigInt(size) },
      sink,
      { fileIndex: FILE_INDEX, stallTimeoutMs: 500 },
    );

    const receiving = receiver.run();
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(
      await encryptChunk(
        key,
        new Uint8Array(CHUNK_SIZE),
        FILE_INDEX,
        0n,
        buildBinding(CHUNK_DOMAIN, FILE_INDEX, BigInt(size)),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    peer.deliver(
      await encryptChunk(
        key,
        new Uint8Array(1),
        FILE_INDEX,
        1n,
        buildBinding(CHUNK_DOMAIN, FILE_INDEX, BigInt(size)),
      ),
    );
    peer.deliver(serializeControl({ t: 'done' }));

    await receiving;
    expect(receiver.state).toBe('completed');
    expect(sink.byteLength).toBe(size);
  });

  it('reports the stall as a timeout rather than a misleading protocol error', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const receiver = new ReceiverEngine(
      peer.channel,
      key,
      { size: 1000n },
      new MemorySink(),
      { fileIndex: FILE_INDEX, stallTimeoutMs: 10 },
    );

    const receiving = receiver.run();
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();

    const outcome = await receiving.catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(TransferStalledError);
    expect(outcome).not.toBeInstanceOf(ProtocolError);
  });

  it('does not fire once the transfer has finished', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverEngine(b, key,
      { size: 10n }, new MemorySink(), { fileIndex: FILE_INDEX,
      stallTimeoutMs: 5,
    });
    const receiving = receiver.run();
    await new SenderEngine(a, randomBlob(10), key, { fileIndex: FILE_INDEX, pollIntervalMs: 0 }).run();
    await receiving;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receiver.state).toBe('completed');
  });
});

describe('ReceiverEngine failure reporting', () => {
  const failingSink = (message: string, failOn: number): Sink => {
    let writes = 0;
    return {
      write: () => {
        writes += 1;
        return writes === failOn ? Promise.reject(new Error(message)) : Promise.resolve();
      },
      close: () => Promise.resolve(),
      abort: () => {},
    };
  };

  it('tells the sender the disk filled up instead of leaving it to guess', async () => {
    const key = await importRawKey(await generateRawKey());
    const size = CHUNK_SIZE * 4;
    const { a, b } = createLoopbackPair();
    const seen = watch(a);
    const receiver = new ReceiverEngine(
      b,
      key,
      { size: BigInt(size) },
      failingSink('the disk is full', 2), { fileIndex: FILE_INDEX },
    );

    const receiving = receiver.run();
    const sending = new SenderEngine(a, randomBlob(size), key,
      { fileIndex: FILE_INDEX, pollIntervalMs: 0 }).run();

    await expect(receiving).rejects.toThrowError('the disk is full');
    await expect(sending).rejects.toThrowError(/disk is full/i);
    expect(seen.controls).toContainEqual({
      t: 'error',
      message: 'The receiver could not write the file to disk: the disk is full',
    });
  });

  it('surfaces the receiver reason on the sender even while it is still streaming', async () => {
    const key = await importRawKey(await generateRawKey());
    const size = CHUNK_SIZE * 4;
    const { a, b } = createLoopbackPair();
    const sender = new SenderEngine(a, randomBlob(size), key, { fileIndex: FILE_INDEX, pollIntervalMs: 0 });
    const receiver = new ReceiverEngine(
      b,
      key,
      { size: BigInt(size) },
      failingSink('no space left on device', 1), { fileIndex: FILE_INDEX },
    );

    const receiving = receiver.run();
    const sending = sender.run();

    await expect(receiving).rejects.toThrowError('no space left on device');
    await expect(sending).rejects.toThrowError(/no space left on device/);
    expect(sender.state).toBe('failed');
    expect(sender.state).not.toBe('aborted');
  });

  it('bounds a huge peer error so it cannot reach the UI unbounded', async () => {
    const key = await importRawKey(await generateRawKey());
    const size = CHUNK_SIZE * 40;
    const peer = createManualPeer();
    const sender = new SenderEngine(peer.channel, randomBlob(size), key, {
      fileIndex: FILE_INDEX,
      pollIntervalMs: 0,
    });

    const cause = sender.run().then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );
    await settle();
    peer.deliver(serializeControl({ t: 'accept' }));
    await settle();
    peer.deliver(serializeControl({ t: 'error', message: 'x'.repeat(2000000) }));
    await settle();

    const failure = await cause;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toHaveLength(MAX_PEER_TEXT);
  });

  it('tells the sender when the disk fails on the final flush', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const seen = watch(a);
    const receiver = new ReceiverEngine(
      b,
      key,
      { size: 10n },
      {
        write: () => Promise.resolve(),
        close: () => Promise.reject(new Error('the device went away')),
        abort: () => {},
      },
      { fileIndex: FILE_INDEX },
    );

    const receiving = receiver.run();
    const sending = new SenderEngine(a, randomBlob(10), key, { fileIndex: FILE_INDEX, pollIntervalMs: 0 }).run();

    await expect(receiving).rejects.toThrowError('the device went away');
    await sending.catch(() => undefined);
    expect(seen.controls).toContainEqual({
      t: 'error',
      message: 'The receiver could not finalise the file on disk: the device went away',
    });
  });

  it('sends the reason exactly once even though fail runs on two paths', async () => {
    const key = await importRawKey(await generateRawKey());
    const size = CHUNK_SIZE * 4;
    const { a, b } = createLoopbackPair();
    const seen = watch(a);
    const receiver = new ReceiverEngine(
      b,
      key,
      { size: BigInt(size) },
      failingSink('the disk is full', 1), { fileIndex: FILE_INDEX },
    );

    const receiving = receiver.run();
    const sending = new SenderEngine(a, randomBlob(size), key,
      { fileIndex: FILE_INDEX, pollIntervalMs: 0 }).run();
    await expect(receiving).rejects.toThrowError('the disk is full');
    await sending.catch(() => undefined);
    await settle();

    const reasons = seen.controls.filter((c) => c.t === 'error');
    expect(reasons).toHaveLength(1);
  });

  it('sends nothing past the accept when the stream is bound to another file size', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(
      peer.channel,
      key,
      { size: 1000n },
      sink, { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();

    // Right key, right file index, a frame that fits what this link expects,
    // and a total in the binding that says the stream is a different file. The
    // receiver has committed the accept and has nothing to report but the
    // failure: it never writes the bytes, and it does not accuse the peer.
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(
      await encryptChunk(
        key,
        new Uint8Array(400),
        FILE_INDEX,
        0n,
        buildBinding(CHUNK_DOMAIN, FILE_INDEX, 2000n),
      ),
    );

    await expect(within(2000, receiving)).rejects.toThrowError(DecryptionError);
    await settle();
    expect(peer.sent).toEqual([serializeControl({ t: 'accept' })]);
    expect(sink.writes).toBe(0);
    expect(sink.aborts).toBe(1);
  });

  it('does not blame the receiver for a close it did not cause', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const seen = watch(a);
    const receiver = new ReceiverEngine(b, key,
      { size: 100n }, new MemorySink(), { fileIndex: FILE_INDEX });

    const receiving = receiver.run();
    a.close();

    await expect(receiving).rejects.toThrowError(/connection closed/i);
    await settle();
    expect(seen.controls.filter((c) => c.t === 'error')).toEqual([]);
  });
});

describe('SenderEngine stall timeout', () => {
  it('shares the generous default with the receiver', () => {
    expect(DEFAULT_STALL_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it('fails with a labelled timeout when the receiver never accepts', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE * 2),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, stallTimeoutMs: 10 },
    );

    const running = engine.run();

    await expect(running).rejects.toThrowError(SenderStalledError);
    await expect(running).rejects.toThrowError(/receiver went quiet/i);
    expect(engine.state).toBe('failed');
    expect(peer.frames()).toHaveLength(0);
  });

  it('fails with a timeout when the receiver never acknowledges', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE * 2),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, stallTimeoutMs: 10 },
    );

    const running = engine.run();
    await settle();
    peer.deliver(serializeControl({ t: 'accept' }));
    await settle();

    await expect(running).rejects.toThrowError(SenderStalledError);
    expect(engine.state).toBe('failed');
  });

  it('measures inactivity rather than total elapsed time', async () => {
    const key = await importRawKey(await generateRawKey());
    const chunks = 6;
    const size = CHUNK_SIZE * chunks;
    const gapMs = 60;
    const peer = createManualPeer();
    const progress: bigint[] = [];
    const engine = new SenderEngine(peer.channel, pacedBlob(size, gapMs), key, { fileIndex: FILE_INDEX,
      stallTimeoutMs: 200,
      pollIntervalMs: 0,
      onProgress: (sent) => progress.push(sent),
    });

    const running = engine.run();
    await settle();
    peer.deliver(serializeControl({ t: 'accept' }));
    peer.deliver(serializeControl({ t: 'done' }));

    const started = Date.now();
    await running;
    const elapsed = Date.now() - started;

    expect(progress).toHaveLength(chunks);
    expect(engine.state).toBe('completed');
    expect(elapsed, 'the transfer outlives several stall windows').toBeGreaterThan(200);
  });

  it('does not fire once the transfer has completed', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    playAcceptingReceiver(b);
    const engine = new SenderEngine(a, randomBlob(10), key, { fileIndex: FILE_INDEX,
      stallTimeoutMs: 5,
      pollIntervalMs: 0,
    });

    await engine.run();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(engine.state).toBe('completed');
  });

  it('is cancelled by abort() rather than firing afterwards', async () => {
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE * 2),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, stallTimeoutMs: 10 },
    );

    const running = engine.run();
    await settle();
    engine.abort();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(engine.state).toBe('aborted');
  });
});

describe('engine file index passthrough', () => {
  const NON_ZERO = 3;
  const SIZE = CHUNK_SIZE + 40;

  const share = async (senderIndex: number, receiverIndex: number) => {
    const key = await importRawKey(await generateRawKey());
    const secret = randomBlob(SIZE);
    const { a, b } = createLoopbackPair();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(b, key, { size: BigInt(SIZE) }, sink, {
      fileIndex: receiverIndex,
    });
    const sender = new SenderEngine(a, secret, key, {
      fileIndex: senderIndex,
      pollIntervalMs: 0,
    });
    const receiving = receiver.run();
    const sending = sender.run();
    const failure = await receiving.then(
      () => null,
      (cause: unknown) => cause,
    );
    await sending.then(
      () => undefined,
      () => undefined,
    );
    return { receiver, sending, sink, secret, failure };
  };

  it('completes when both engines sit on the same non-zero file index', async () => {
    const { receiver, sending, sink, secret, failure } = await share(NON_ZERO, NON_ZERO);

    expect(failure).toBeNull();
    expect(receiver.state).toBe('completed');
    expect(await sending).toBeUndefined();
    expect(sink.byteLength).toBe(SIZE);
    expect(sink.toUint8Array()).toEqual(new Uint8Array(await secret.arrayBuffer()));
  });

  it('fails on the integrity check when only the receiver drifts to index 0', async () => {
    const { receiver, sink, failure } = await share(NON_ZERO, 0);

    expect(failure).toBeInstanceOf(DecryptionError);
    expect(receiver.state).toBe('failed');
    expect(sink.aborts).toBe(1);
  });

  it('fails on the integrity check when only the sender stays at index 0', async () => {
    const { receiver, sink, failure } = await share(0, NON_ZERO);

    expect(failure).toBeInstanceOf(DecryptionError);
    expect(receiver.state).toBe('failed');
    expect(sink.aborts).toBe(1);
  });

  it('encrypts every captured frame under its own non-zero file index and no other', async () => {
    const key = await importRawKey(await generateRawKey());
    const size = CHUNK_SIZE + 100;
    const secret = randomBlob(size);
    const expected = new Uint8Array(await secret.arrayBuffer());
    const { a, b } = createLoopbackPair();
    const seen = watch(b);
    playAcceptingReceiver(b);

    await new SenderEngine(a, secret, key, { fileIndex: 2, pollIntervalMs: 0 }).run();
    await settle();

    expect(seen.frames).toHaveLength(2);
    for (let i = 0; i < seen.frames.length; i += 1) {
      const frame = seen.frames[i] as ArrayBuffer;
      const sealed = buildBinding(CHUNK_DOMAIN, 2, BigInt(size));
      const got = await decryptChunk(key, frame, 2, BigInt(i), sealed);
      expect(got).toEqual(expected.subarray(i * CHUNK_SIZE, i * CHUNK_SIZE + got.length));
      await expect(decryptChunk(key, frame, 0, BigInt(i), sealed)).rejects.toThrowError(DecryptionError);
    }
  });

  it('gives one key a different ciphertext for the same chunk at two file indices', async () => {
    const key = await importRawKey(await generateRawKey());
    const secret = randomBlob(4096);
    const { a, b } = createLoopbackPair();
    const first = watch(b);
    playAcceptingReceiver(b);
    await new SenderEngine(a, secret, key, { fileIndex: 1, pollIntervalMs: 0 }).run();
    await settle();

    const { a: a2, b: b2 } = createLoopbackPair();
    const second = watch(b2);
    playAcceptingReceiver(b2);
    await new SenderEngine(a2, secret, key, { fileIndex: 2, pollIntervalMs: 0 }).run();
    await settle();

    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(1);
    const fromFileOne = new Uint8Array(first.frames[0] as ArrayBuffer);
    const fromFileTwo = new Uint8Array(second.frames[0] as ArrayBuffer);
    expect(fromFileOne).not.toEqual(fromFileTwo);
  });
});

describe('a sender streaming the wrong file', () => {
  const NAME = 'a.bin';

  it('fails on the first chunk when the stream is shorter than the link declares', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const sink = new SpySink();
    // Same name, same key, same file index, and a first frame that fits inside
    // what the receiver declared: nothing on the wire says 1000 is not 2000.
    const sender = new SenderEngine(a, new File([new Uint8Array(1000)], NAME), key, {
      fileIndex: FILE_INDEX,
      pollIntervalMs: 0,
    });
    const receiver = new ReceiverEngine(b, key, { size: 2000n }, sink, {
      fileIndex: FILE_INDEX,
    });

    const receiving = receiver.run();
    const sending = sender.run();
    // A size disagreement has to be a failure and not a hang, and it has to be
    // the integrity check rather than the truncation check: a sender that
    // under-delivers would otherwise sail through as a short file.
    await expect(within(2000, receiving)).rejects.toThrowError(DecryptionError);
    await sending.catch(() => undefined);

    expect(sink.writes).toBe(0);
    expect(sink.aborts).toBe(1);
    expect(sink.closes).toBe(0);
    expect(receiver.state).toBe('failed');
    expect(sender.state).not.toBe('completed');
  });

  it('fails when the stream is longer than the link declares', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const sink = new SpySink();
    const sender = new SenderEngine(a, new File([new Uint8Array(2000)], NAME), key, {
      fileIndex: FILE_INDEX,
      pollIntervalMs: 0,
    });
    const receiver = new ReceiverEngine(b, key, { size: 1000n }, sink, {
      fileIndex: FILE_INDEX,
    });

    const receiving = receiver.run();
    const sending = sender.run();
    // The same disagreement from the other side is caught on the declared
    // length, before anything is decrypted or written.
    await expect(within(2000, receiving)).rejects.toThrowError(/more data than it declared/i);
    await sending.catch(() => undefined);

    expect(sink.writes).toBe(0);
    expect(sink.aborts).toBe(1);
    expect(receiver.state).toBe('failed');
  });
});

describe('a cancelled transfer', () => {
  // Not FILE_INDEX: the cancel frame has to carry the index this engine was
  // built with, and a distinct one keeps a frame built from the wrong constant
  // from passing.
  const WIRE_INDEX = 4;

  const firstChunk = (key: CryptoKey, size: bigint, length: number, index = 0n) =>
    encryptChunk(
      key,
      new Uint8Array(length),
      WIRE_INDEX,
      index,
      buildBinding(CHUNK_DOMAIN, WIRE_INDEX, size),
    );

  it('stops on the signal, aborts the sink, and leaves the channel open', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const seen = watch(a);
    let closes = 0;
    a.onClose(() => {
      closes += 1;
    });
    b.onClose(() => {
      closes += 1;
    });
    const size = CHUNK_SIZE * 40;
    const sink = new SpySink();
    const states: ReceiverState[] = [];
    const controller = new AbortController();
    const receiver = new ReceiverEngine(b, key, { size: BigInt(size) }, sink, {
      fileIndex: WIRE_INDEX,
      onStateChange: (state) => states.push(state),
      onProgress: () => controller.abort(),
    });
    const sending = new SenderEngine(a, randomBlob(size), key, {
      fileIndex: WIRE_INDEX,
      pollIntervalMs: 0,
      // Short, because the wait this test now ends in is a wait for an
      // acknowledgement that is never coming, and the default ceiling for that
      // is a minute.
      stallTimeoutMs: 200,
    });

    const receiving = receiver.run(controller.signal);
    const streamed = sending.run();
    // Held from the start: the sender meets the cancel long before this test
    // gets round to looking at it, and an unwatched rejection in between is
    // noise that hides a real one.
    const senderFailure = streamed.then(
      () => null,
      (cause: unknown) => cause,
    );

    await expect(receiving).rejects.toThrowError(TransferCancelledError);
    expect(sink.aborts, 'the partial file is discarded, not finalised').toBe(1);
    expect(sink.closes).toBe(0);
    expect(states).toEqual(['idle', 'awaiting-offer', 'receiving', 'cancelled']);
    expect(seen.controls).toContainEqual({ t: 'cancel', index: WIRE_INDEX });
    expect(seen.controls.filter((c) => c.t === 'error')).toEqual([]);
    expect(seen.controls).toContainEqual({ t: 'accept' });
    // Nothing else in this test closes the channel, so any close at all would be
    // the receiver's. The setTimeout in fail() is why this waits a turn.
    await settle();
    expect(closes).toBe(0);

    // Nothing on this channel is going to answer that cancel: the sender's half
    // of one is SenderSession's, and there is no session here. So the engine
    // steps over the frame and goes on waiting for the receiver's own done,
    // which the stall timer ends. Documented, not endorsed: what it must not do
    // is read the cancel as a broken acknowledgement and fail the transfer over
    // a file the receiver chose to skip. The session that would have answered
    // it is exercised in session.test.ts.
    const failure = await senderFailure;
    expect(failure).toBeInstanceOf(SenderStalledError);
    expect((failure as Error).message).not.toMatch(/acknowledgement/);
    expect(sending.state, 'a frame it cannot use is not a failure').toBe('failed');
  });

  it('cancels before the offer arrives, without ever accepting', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const sink = new SpySink();
    const controller = new AbortController();
    const receiver = new ReceiverEngine(
      peer.channel,
      key,
      { size: 1000n },
      sink,
      { fileIndex: WIRE_INDEX },
    );

    const running = receiver.run(controller.signal);
    await settle();
    controller.abort();

    await expect(running).rejects.toThrowError(TransferCancelledError);
    expect(peer.controls()).toEqual([{ t: 'cancel', index: WIRE_INDEX }]);
    expect(sink.writes).toBe(0);
    expect(sink.aborts, 'a destination opened and never used is still released').toBe(1);
    // A close is deferred by a turn, so the assertion has to outlast the turn
    // it is looking for.
    await settle();
    expect(peer.closeCalls()).toBe(0);
    expect(receiver.state).toBe('cancelled');
  });

  it('still cancels when the abort lands as the last chunk arrives', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = 400;
    const sink = new SpySink();
    const controller = new AbortController();
    const receiver = new ReceiverEngine(peer.channel, key, { size: BigInt(size) }, sink, {
      fileIndex: WIRE_INDEX,
      onProgress: () => controller.abort(),
    });

    const running = receiver.run(controller.signal);
    await settle();
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(await firstChunk(key, BigInt(size), size));
    // The file is complete and the sender's done is already in the receiver's
    // hands when the abort fires from the write that finished it.
    peer.deliver(serializeControl({ t: 'done' }));

    await expect(running).rejects.toThrowError(TransferCancelledError);
    expect(receiver.state).toBe('cancelled');
    expect(sink.closes, 'a file the receiver stopped is not kept').toBe(0);
    expect(sink.aborts).toBe(1);
    await settle();
    expect(peer.closeCalls()).toBe(0);
  });

  it('a cancel outranks a stall that has already fired', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = BigInt(CHUNK_SIZE * 2);
    const held = new SpySink();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const receiver = new ReceiverEngine(
      peer.channel,
      key,
      { size },
      {
        write: (chunk) => gate.then(() => held.write(chunk)),
        close: () => held.close(),
        abort: () => held.abort(),
      },
      { fileIndex: WIRE_INDEX, stallTimeoutMs: 30 },
    );

    const running = receiver.run(controller.signal);
    await settle();
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(await firstChunk(key, size, CHUNK_SIZE));
    // Parked in the write with the stall already expired behind it.
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    release();

    await expect(running).rejects.toThrowError(TransferCancelledError);
    // One abort, one cancel, no close: the user asked for this, so it must not
    // also be reported as a stall the sender has to be told off about.
    expect(held.aborts).toBe(1);
    expect(peer.controls()).toContainEqual({ t: 'cancel', index: WIRE_INDEX });
    expect(peer.controls().filter((c) => c.t === 'error')).toEqual([]);
    await settle();
    expect(peer.closeCalls()).toBe(0);
    expect(receiver.state).toBe('cancelled');
  });

  // Cancels a receiver part-way through the file and hands back the engine,
  // which is now waiting to hear that the sender has stopped sending that file.
  // Every drain test needs that state, and building it by hand each time is how
  // the part that matters gets left out.
  const cancelledInFlight = async (
    peer: ReturnType<typeof createManualPeer>,
    key: CryptoKey,
    size: bigint,
  ): Promise<{ receiver: ReceiverEngine; sink: SpySink }> => {
    const sink = new SpySink();
    const controller = new AbortController();
    const receiver = new ReceiverEngine(peer.channel, key, { size }, sink, {
      fileIndex: WIRE_INDEX,
    });

    const running = receiver.run(controller.signal);
    await settle();
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(await firstChunk(key, size, CHUNK_SIZE));
    await settle();
    controller.abort();

    await expect(running).rejects.toThrowError(TransferCancelledError);
    expect(sink.aborts).toBe(1);
    return { receiver, sink };
  };

  // What a sender cannot take back. It cannot run faster than the round trip, so
  // a cancel always lands with some of the file still on its way.
  const inFlight = async (
    key: CryptoKey,
    size: bigint,
    count: number,
    from = 1n,
  ): Promise<ArrayBuffer[]> =>
    Promise.all(
      Array.from({ length: count }, (_unused, i) =>
        firstChunk(key, size, CHUNK_SIZE, from + BigInt(i)),
      ),
    );

  // Resolves 'held' if the engine is still waiting and 'free' once it lets go,
  // after a turn for a promise that is already settled to win the race.
  const holdState = async (released: Promise<unknown>): Promise<'held' | 'free'> => {
    const settled = released.then(() => 'free' as const);
    await settle();
    return Promise.race([settled, settle().then(() => 'held' as const)]);
  };

  // Runs a file all the way out and leaves the engine in the one slot a frame
  // it cannot use can land in: sent, waiting for the receiver's acknowledgement.
  const sentAndWaiting = async (
    key: CryptoKey,
  ): Promise<{
    peer: ReturnType<typeof createManualPeer>;
    engine: SenderEngine;
    running: Promise<unknown>;
  }> => {
    const peer = createManualPeer();
    const engine = new SenderEngine(peer.channel, randomBlob(CHUNK_SIZE + 3), key, {
      fileIndex: WIRE_INDEX,
    });
    // Held from the start: a frame read as a protocol error rejects this while
    // the test is still watching the engine, and an unwatched rejection is
    // noise that hides a real one.
    const running = engine.run().then(
      () => null,
      (cause: unknown) => cause,
    );
    await settle();
    peer.deliver(serializeControl({ t: 'accept' }));
    await settle();
    expect(engine.state, 'the file is out and unacknowledged').toBe('sent');
    return { peer, engine, running };
  };

  it('reads a cancel for a file it is not serving as no answer at all', async () => {
    // A cancel the session ignored -- one naming a file that is not in flight --
    // still reaches this engine, because a channel hands every frame to every
    // subscriber and has no way to detach one. It lands in the one slot the
    // engine cannot use it in: where the receiver's own done is due. Failing
    // there ends the share over a file the receiver never asked to stop, and
    // taking it for the answer would call a delivered file unconfirmed.
    const key = await importRawKey(await generateRawKey());
    const { peer, engine, running } = await sentAndWaiting(key);

    peer.deliver(serializeControl({ t: 'cancel', index: WIRE_INDEX + 1 }));
    // And a terminator the peer has no standing to send, which the session drops
    // for the same reason and this engine must not mistake for its answer.
    peer.deliver(serializeControl({ t: 'cancelled', index: WIRE_INDEX + 1 }));
    expect(await holdState(running), 'a frame it cannot use must not settle the wait').toBe('held');

    // What the peer really owed is behind them, and is still read.
    peer.deliver(serializeControl({ t: 'done' }));
    expect(await within(1000, running), 'the acknowledgement behind them is the answer').toBeNull();
    expect(engine.state).toBe('completed');
    expect(
      peer.controls().filter((c) => c.t === 'error'),
      'nothing was wrong with this transfer, so nothing was reported',
    ).toEqual([]);
  });

  it('fails a transfer on a peer that sprays cancels, rather than waiting on it', async () => {
    // The bound on the leniency above. Each frame the engine steps over re-arms
    // the stall timer as it comes in, so without a ceiling a peer could hold a
    // transfer open -- and the share with it -- for as long as it kept sending.
    // One transfer has one cancel in it, so no honest peer produces this.
    const key = await importRawKey(await generateRawKey());
    const { peer, engine, running } = await sentAndWaiting(key);
    for (let i = 0; i <= MAX_STEPPED_FRAMES; i += 1) {
      peer.deliver(serializeControl({ t: 'cancel', index: WIRE_INDEX + 1 }));
    }
    // A spray is not a transfer, so what follows it changes nothing.
    peer.deliver(serializeControl({ t: 'done' }));

    const failure = await within(1000, running);
    expect(failure).toBeInstanceOf(ProtocolError);
    expect((failure as Error).message).toMatch(/cancel frames/i);
    expect(engine.state).toBe('failed');
  });

  it('still refuses a select where the acknowledgement goes', async () => {
    // The leniency is for the two frames the session answers and for nothing
    // else. A select is the session's to act on and names no file this engine
    // could answer, and the peer that sent it owes an acknowledgement, not a
    // request: stepping over it would leave the engine waiting on a peer that
    // has stopped speaking to it.
    const key = await importRawKey(await generateRawKey());
    const { peer, engine, running } = await sentAndWaiting(key);
    peer.deliver(serializeControl({ t: 'select', index: WIRE_INDEX + 1 }));

    const failure = await within(1000, running);
    expect(failure).toBeInstanceOf(ProtocolError);
    expect((failure as Error).message).toMatch(/acknowledgement but received "select"/);
    expect(engine.state).toBe('failed');
  });

  it('still refuses a malformed frame where the consent goes', async () => {
    // A frame that is not a control message at all is nobody's to answer, and
    // parsing it leniently -- as the session does to spot a cancel -- would be
    // how a broken peer turned into a cancel. It fails the transfer instead.
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const engine = new SenderEngine(peer.channel, randomBlob(CHUNK_SIZE), key, {
      fileIndex: WIRE_INDEX,
    });
    const running = engine.run().then(
      () => null,
      (cause: unknown) => cause,
    );
    await settle();
    peer.deliver('{not a control message');

    const failure = await within(1000, running);
    expect(failure).toBeInstanceOf(ProtocolError);
    expect((failure as Error).message).toMatch(/malformed control message/i);
    expect(engine.state).toBe('failed');
  });

  it('still refuses file data where the acknowledgement goes', async () => {
    // The leniency is for two control frames, not for bytes. A chunk arriving
    // here is a leftover from a file this engine was not sending -- the drain
    // exists because a channel cannot detach a subscriber -- and treating it as
    // a frame to step over would be a file's worth of silence read as consent.
    const key = await importRawKey(await generateRawKey());
    const { peer, engine, running } = await sentAndWaiting(key);
    peer.deliver(await firstChunk(key, BigInt(CHUNK_SIZE + 3), CHUNK_SIZE));

    const failure = await within(1000, running);
    expect(failure).toBeInstanceOf(ProtocolError);
    expect((failure as Error).message).toMatch(/received file data/);
    expect(engine.state).toBe('failed');
  });

  it('holds the channel until the sender says the last of the file has gone', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = BigInt(CHUNK_SIZE * 8);
    const { receiver, sink } = await cancelledInFlight(peer, key, size);

    // A sender that keeps going regardless: the chunks it had already put on
    // the wire when the cancel was sent, and the file's own done, which it had
    // earned by finishing just before the cancel arrived.
    for (const frame of await inFlight(key, size, 3)) peer.deliver(frame);
    await settle();
    expect(sink.writes, 'a discarded chunk is never written').toBe(1);
    expect(receiver.state, 'a leftover must not turn a skip into a failure').toBe('cancelled');

    peer.deliver(serializeControl({ t: 'cancelled', index: WIRE_INDEX }));
    expect(
      await holdState(receiver.released),
      'the sender said the last one had gone and the engine went on listening',
    ).toBe('free');
  });

  it('goes on holding while the sender is still sending, terminator or not', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = BigInt(CHUNK_SIZE * 8);
    const { receiver } = await cancelledInFlight(peer, key, size);

    for (const frame of await inFlight(key, size, 2)) peer.deliver(frame);
    expect(
      await holdState(receiver.released),
      'the engine let the next file in while the sender was still sending this one',
    ).toBe('held');

    peer.deliver(serializeControl({ t: 'cancelled', index: WIRE_INDEX }));
    expect(await holdState(receiver.released)).toBe('free');
  });

  it('gives the drain up when the terminator never comes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const key = await importRawKey(await generateRawKey());
      const peer = createManualPeer();
      const size = BigInt(CHUNK_SIZE * 4);
      const { receiver } = await cancelledInFlight(peer, key, size);
      expect(await holdState(receiver.released), 'nothing was sent after the cancel').toBe('held');

      // A sender that never says so must not leave this engine subscribed for
      // the rest of the share. The race is the assertion: without the deadline
      // the engine is still holding when the clock runs out.
      const outcome = await Promise.race([
        receiver.released.then(() => 'released' as const),
        vi.advanceTimersByTimeAsync(DEFAULT_STALL_TIMEOUT_MS + 1).then(
          () => 'deadline' as const,
        ),
      ]);

      expect(outcome).toBe('released');
      expect(receiver.state).toBe('cancelled');
      expect(peer.closeCalls(), 'a drain that gave up still does not end the share').toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets go when the peer leaves mid-drain', async () => {
    // A channel that has closed has nothing left to come, so the drain is over
    // whether the sender said so or not -- and a session waiting on this must
    // not wait out a deadline for a peer that has already gone.
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = BigInt(CHUNK_SIZE * 4);
    const { receiver } = await cancelledInFlight(peer, key, size);
    expect(await holdState(receiver.released)).toBe('held');

    peer.drop('remote');

    expect(await holdState(receiver.released)).toBe('free');
  });

  it('holds nothing back for a transfer that was never cancelled', async () => {
    // The wait is on every file, not only the skipped ones: an engine that only
    // released itself from a cancel would make the second file of an ordinary
    // share wait out a drain that was never started.
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = 400;
    const sink = new SpySink();
    const receiver = new ReceiverEngine(peer.channel, key, { size: BigInt(size) }, sink, {
      fileIndex: WIRE_INDEX,
    });

    const running = receiver.run();
    await settle();
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(await firstChunk(key, BigInt(size), size));
    await settle();
    peer.deliver(serializeControl({ t: 'done' }));
    await running;

    expect(receiver.state).toBe('completed');
    expect(await holdState(receiver.released)).toBe('free');
  });

  it('holds nothing back for a transfer that failed', async () => {
    // The same wait, the other way round: a failure closes the channel, and a
    // released that never came would leave the next select waiting out a
    // deadline for a file that is already over.
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(peer.channel, key, { size: 1000n }, sink, {
      fileIndex: WIRE_INDEX,
    });

    const running = receiver.run();
    await settle();
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    // More than the file declared, which fails before anything is written.
    peer.deliver(await firstChunk(key, 1000n, 2000));

    await expect(running).rejects.toThrowError(/more data than it declared/i);
    expect(receiver.state).toBe('failed');
    expect(await holdState(receiver.released)).toBe('free');
  });

  it('fails the next file on a frame that outlived the drain, without writing it', async () => {
    // The limit of the drain, recorded rather than solved: a sender that never
    // sends the terminator has told the receiver, by its silence, that nothing
    // was coming. A frame that turns up after the drain has ended is the other
    // case, and the next engine is subscribed by then, so it meets a chunk it
    // was never offered. What it must not do is write it.
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = BigInt(CHUNK_SIZE * 4);
    await cancelledInFlight(peer, key, size);
    peer.deliver(serializeControl({ t: 'cancelled', index: WIRE_INDEX }));
    await settle();

    const kept = new SpySink();
    const second = new ReceiverEngine(peer.channel, key, { size }, kept, {
      fileIndex: WIRE_INDEX + 1,
    });
    const keeping = second.run();
    peer.deliver((await inFlight(key, size, 1))[0] as ArrayBuffer);

    await expect(keeping).rejects.toThrowError(/file data/i);
    expect(kept.writes, 'a chunk of another file is not written into this one').toBe(0);
    expect(second.state).toBe('failed');
  });

  it('drains the leftovers away before the next engine subscribes', async () => {
    // The engine cannot end the share on its own, because a channel hands every
    // frame to every subscriber and has no way to detach one -- so this test
    // passes with or without the drain, and guards only against a future fix
    // that makes a settled engine swallow everything that follows. The test
    // that carries the property is in session.test.ts: 'sends a cancel for the
    // wire index, and keeps the channel for the next file'.
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = BigInt(CHUNK_SIZE + 40);
    const { receiver: stopped } = await cancelledInFlight(peer, key, size);
    expect(stopped.state).toBe('cancelled');

    // A sender in no hurry to oblige: the rest of the cancelled file, its done,
    // and only then the news that there is nothing more coming.
    for (const frame of await inFlight(key, size, 2)) peer.deliver(frame);
    peer.deliver(serializeControl({ t: 'done' }));
    peer.deliver(serializeControl({ t: 'cancelled', index: WIRE_INDEX }));
    await settle();

    const kept = new SpySink();
    const second = new ReceiverEngine(
      peer.channel,
      key,
      { size },
      kept,
      { fileIndex: WIRE_INDEX + 1 },
    );
    const keeping = second.run();
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(
      await encryptChunk(
        key,
        new Uint8Array(Number(size)),
        WIRE_INDEX + 1,
        0n,
        buildBinding(CHUNK_DOMAIN, WIRE_INDEX + 1, size),
      ),
    );
    peer.deliver(serializeControl({ t: 'done' }));
    await keeping;

    expect(second.state).toBe('completed');
    expect(kept.byteLength).toBe(Number(size));
    expect(peer.closeCalls(), 'the whole share turned on this').toBe(0);
  });

  it('steps over a terminator that lands after the drain has let the next file in', async () => {
    // The drain ends on any control frame, and a sender that finished the file
    // just as the cancel was in flight puts its own done on the wire first. So a
    // terminator can legitimately turn up at the next file's engine, which is
    // already waiting for an offer. It is a statement about the file that has
    // gone, and the session drops it as well; failing here would end a share
    // that is only beginning over a frame that says nothing about this file.
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = BigInt(CHUNK_SIZE + 40);
    await cancelledInFlight(peer, key, size);
    // The file's own done, which the sender had earned by finishing as the
    // cancel went out, and which ends the drain ahead of the terminator.
    peer.deliver(serializeControl({ t: 'done' }));
    await settle();

    const kept = new SpySink();
    const second = new ReceiverEngine(peer.channel, key, { size }, kept, {
      fileIndex: WIRE_INDEX + 1,
    });
    const receiving = second.run();
    peer.deliver(serializeControl({ t: 'cancelled', index: WIRE_INDEX }));
    await settle();
    expect(
      await holdState(receiving),
      'a terminator for a file that has gone must not settle the next one',
    ).toBe('held');

    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(
      await encryptChunk(
        key,
        new Uint8Array(Number(size)),
        WIRE_INDEX + 1,
        0n,
        buildBinding(CHUNK_DOMAIN, WIRE_INDEX + 1, size),
      ),
    );
    peer.deliver(serializeControl({ t: 'done' }));
    await receiving;

    expect(second.state).toBe('completed');
    expect(kept.byteLength).toBe(Number(size));
    expect(peer.closeCalls()).toBe(0);
  });

  it('fails a transfer on a peer that sprays terminators before the offer', async () => {
    // The bound on that leniency. Every frame stepped over re-arms the stall
    // timer as it comes in, so a peer that kept sending them would hold this
    // engine -- and the file after it with it -- for as long as it cared to.
    // One transfer has one cancel in it, so no honest peer produces this.
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = BigInt(CHUNK_SIZE + 40);
    const sink = new SpySink();
    const receiver = new ReceiverEngine(peer.channel, key, { size }, sink, {
      fileIndex: WIRE_INDEX,
    });

    const receiving = receiver.run();
    for (let i = 0; i <= MAX_STEPPED_FRAMES; i += 1) {
      peer.deliver(serializeControl({ t: 'cancelled', index: WIRE_INDEX }));
    }
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));

    await expect(receiving).rejects.toThrowError(ProtocolError);
    await expect(receiving).rejects.toThrowError(/terminator frames/i);
    expect(receiver.state).toBe('failed');
    expect(sink.writes).toBe(0);
  });

  it('still refuses a frame that is not a terminator where the offer goes', async () => {
    // The leniency is for the one frame that is a late answer to a question
    // about a file that has gone, and for nothing else. A done is the sender
    // announcing a file this engine was never offered, and reading it as nothing
    // in particular would be a receiver that never learned whether a transfer
    // had started.
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(peer.channel, key, { size: 1000n }, sink, {
      fileIndex: WIRE_INDEX,
    });

    const receiving = receiver.run();
    peer.deliver(serializeControl({ t: 'done' }));

    await expect(receiving).rejects.toThrowError(ProtocolError);
    await expect(receiving).rejects.toThrowError(/Expected an offer but received "done"/);
    expect(receiver.state).toBe('failed');
  });

  it('still refuses a terminator where a chunk of the transfer goes', async () => {
    // The receiver steps over a late terminator only where the OFFER goes. Once
    // a transfer is under way it owns every frame that arrives, and a terminator
    // there is a sender talking about a file this one is not -- the same widening
    // that would make the offer lenient would make this lenient too, and
    // nothing would fail.
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(b, key, { size: BigInt(CHUNK_SIZE * 4) }, sink, {
      fileIndex: WIRE_INDEX,
    });
    // Held from the start: it rejects while the sender below is still being
    // awaited, and an unwatched rejection in between is an unhandled one.
    const receiving = receiver.run();
    const outcome = receiving.then(
      () => null,
      (cause: unknown) => cause,
    );

    // A real sender, so the offer and the accept are genuine, interrupted once
    // the transfer is under way.
    let interrupted = false;
    const sending = new SenderEngine(
      a,
      randomBlob(CHUNK_SIZE * 4),
      key,
      {
        fileIndex: WIRE_INDEX,
        pollIntervalMs: 0,
        onProgress: (sent) => {
          if (interrupted || sent === 0n) return;
          interrupted = true;
          a.send(serializeControl({ t: 'cancelled', index: WIRE_INDEX }));
        },
      },
    ).run();
    await sending.catch(() => undefined);

    const thrown = await outcome;
    expect(thrown).toBeInstanceOf(ProtocolError);
    expect(String(thrown)).toMatch(/Unexpected "cancelled" during transfer/);
    expect(sink.writes, 'no chunk had been offered to write before this').toBeLessThan(4);
  });

  it('a stall with no signal is still an ordinary failure', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const sink = new SpySink();
    const controller = new AbortController();
    const receiver = new ReceiverEngine(peer.channel, key, { size: 1000n }, sink, {
      fileIndex: WIRE_INDEX,
      stallTimeoutMs: 5,
    });

    const running = receiver.run(controller.signal);
    // Watched from the start: the stall can fire before this test has finished
    // settling, and a rejection nobody is holding yet is reported as unhandled.
    const failure = running.then(
      () => null,
      (cause: unknown) => cause,
    );
    await settle();

    expect(await failure).toBeInstanceOf(TransferStalledError);
    expect(await failure).not.toBeInstanceOf(TransferCancelledError);
    expect(receiver.state).toBe('failed');
    expect(sink.aborts).toBe(1);
    expect(peer.controls().filter((c) => c.t === 'cancel')).toEqual([]);
    await settle();
    expect(peer.closeCalls(), 'a stall still ends the connection').toBe(1);
  });

  it('hands its abort listener back on every chunk it parks on', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const size = BigInt(CHUNK_SIZE * 6);
    const signal = countingSignal();
    const sink = new SpySink();
    const receiver = new ReceiverEngine(peer.channel, key, { size }, sink, {
      fileIndex: WIRE_INDEX,
    });

    const running = receiver.run(signal.signal);
    await settle();
    peer.deliver(serializeControl({ t: 'offer', chunkSize: CHUNK_SIZE }));
    await settle();
    for (let i = 0; i < 6; i += 1) {
      peer.deliver(await firstChunk(key, size, CHUNK_SIZE, BigInt(i)));
      await settle();
    }
    peer.deliver(serializeControl({ t: 'done' }));
    await running;

    expect(receiver.state).toBe('completed');
    expect(signal.added(), 'the engine really did park on the signal').toBeGreaterThan(1);
    expect(signal.removed(), 'a listener per chunk outlives the transfer').toBe(signal.added());
  });
});

// The frame this exists for is the sender engine's, and it is asserted here
// rather than in session.test.ts because what matters is the whole sequence the
// sender put on the wire, terminator included. The session's own half -- that it
// intercepts the cancel and answers it -- is covered there.
describe('a cancel before the receiver accepts', () => {
  it('says nothing about the sender having stopped, and answers the cancel', async () => {
    // The window where a cancel costs the least: the file is offered and not yet
    // taken, so there is nothing on the wire to drain and nothing half-written.
    // It is also where the sender is most tempted to talk, because cutting the
    // wait short looks exactly like a sender that has given up. "The sender
    // stopped sharing." is false here -- the share carries on to the next file
    // on the same connection -- and a receiver that is not this one would read
    // it as the share ending. It is also the frame the receiver's own drain is
    // meant to end on instead.
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const files = [
      new File([new Uint8Array(CHUNK_SIZE + 5)], 'a.bin'),
      new File([new Uint8Array(64)], 'b.bin'),
    ];
    const failures: string[] = [];
    const completed: number[] = [];
    const sender = new SenderSession(peer.channel, key, files, {
      pollIntervalMs: 0,
      onError: (_index, message) => failures.push(message),
      onComplete: (index) => completed.push(index),
    });
    const serving = sender.run();
    await settle();
    // The manifest is a binary frame of its own, so the file's frames are
    // counted from here rather than from an empty channel.
    const beforeSelect = peer.frames().length;
    peer.deliver(serializeControl({ t: 'select', index: FIRST_FILE_INDEX }));
    await settle();

    // The offer is out and no accept has come: this is the consent window.
    expect(peer.frames().length, 'nothing of the file is on the wire yet').toBe(beforeSelect);
    peer.deliver(serializeControl({ t: 'cancel', index: FIRST_FILE_INDEX }));
    await settle();

    // The whole sequence, in order, so the frame cannot come back in another
    // position: the offer, and the one frame the receiver is waiting for.
    expect(peer.controls()).toEqual([
      { t: 'offer', chunkSize: CHUNK_SIZE },
      { t: 'cancelled', index: FIRST_FILE_INDEX },
    ]);
    expect(failures, 'the receiver asked for this, so it is not a failure').toEqual([]);
    expect(completed, 'a file that was declined is not a delivery').toEqual([]);

    peer.deliver(serializeControl({ t: 'select', index: FIRST_FILE_INDEX + 1 }));
    await settle();
    peer.deliver(serializeControl({ t: 'accept' }));
    await settle();
    peer.deliver(serializeControl({ t: 'done' }));
    await settle();

    expect(completed, 'the share goes on to the next file').toEqual([1]);
    peer.deliver(serializeControl({ t: 'finish' }));
    await expect(serving).resolves.toBeUndefined();
  });
});

// A wire the test drives: a send puts a frame on it and nothing arrives until
// the test says so, and the sender is held in its backpressure wait until it is
// released. Loopback hands a frame over in the same tick as the send, so frames a
// peer has to read in the opposite order can pass there and fail over a real
// connection, where the second is a round trip behind the first.
const createDeferredPair = () => {
  const inbound: ((msg: ChannelMessage) => void)[][] = [[], []];
  const closers: ((reason: CloseReason) => void)[][] = [[], []];
  // Addressed to that end, so a send is a put on the wire and a delivery is a
  // read of the far end's box.
  const addressed: ChannelMessage[][] = [[], []];
  const closed = [false, false];
  let held = true;

  const end = (self: number): Channel => ({
    send: (msg) => {
      if (closed[self] === true) return;
      addressed[1 - self]?.push(msg);
    },
    onMessage: (cb) => {
      inbound[self]?.push(cb);
    },
    onClose: (cb) => {
      closers[self]?.push(cb);
    },
    close: () => {
      const remote = 1 - self;
      if (closed[self] === true || closed[remote] === true) return;
      closed[self] = true;
      closed[remote] = true;
      for (const cb of closers[self] ?? []) cb('local');
      for (const cb of closers[remote] ?? []) cb('remote');
    },
    get bufferedAmount() {
      return held ? Number.MAX_SAFE_INTEGER : 0;
    },
  });

  return {
    a: end(0),
    b: end(1),
    // One frame per end, because that is what a wire hands over: the second of a
    // pair is a round trip behind the first, which is the whole difference here.
    // A frame a handler sends while this runs waits for the next round.
    deliver: (): void => {
      for (const to of [0, 1]) {
        const msg = addressed[to]?.shift();
        if (msg === undefined) continue;
        for (const cb of inbound[to] ?? []) cb(msg);
      }
    },
    release: (): void => {
      held = false;
    },
  };
};

// A turn of the event loop between deliveries, which is what lets each engine
// reach its next await before the next frame lands.
const pump = async (rounds: number, deliver: () => void): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    await settle();
    deliver();
  }
};

const fileOf = async (size: number, name: string): Promise<File> =>
  new File([await randomBlob(size).arrayBuffer()], name);

// The frames the sender puts on the wire, as one session's peer sees them.
const fromSender = (channel: Channel): ControlMessage[] => {
  const controls: ControlMessage[] = [];
  channel.onMessage((msg) => {
    if (typeof msg === 'string') controls.push(parseControl(msg));
  });
  return controls;
};

describe('a sender that is cut short', () => {
  it('says nothing at all, and the next file still arrives', async () => {
    // The whole round trip, over a real channel, with the sender's own frames
    // counted. "The sender stopped sharing." is the one frame the receiver's
    // drain is meant to end on, so putting it out on this path is what ends the
    // drain early and hands the terminator behind it to the next file.
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const seen = fromSender(b);
    const files = [await fileOf(CHUNK_SIZE * 40, 'skipped.bin'), await fileOf(64, 'next.bin')];
    const failures: string[] = [];
    const completed: number[] = [];
    const controller = new AbortController();
    const sender = new SenderSession(a, key, files, {
      pollIntervalMs: 0,
      onError: (_index, message) => failures.push(message),
      onComplete: (index) => completed.push(index),
    });
    const sinks: SpySink[] = [];
    const receiver = new ReceiverSession(b, key, {
      openSink: async () => {
        const sink = new SpySink();
        sinks.push(sink);
        return sink;
      },
      onManifest: () => {},
      onProgress: (_index, received) => {
        if (received > 0n) controller.abort();
      },
    });
    const serving = sender.run();
    await receiver.run();
    await settle();

    await expect(receiver.select(0, controller.signal)).rejects.toThrowError(
      TransferCancelledError,
    );
    await receiver.select(1);
    await receiver.finish();
    await expect(serving).resolves.toBeUndefined();

    expect(seen.filter((control) => control.t === 'error')).toEqual([]);
    expect(seen.map((control) => control.t)).toEqual([
      'offer',
      'cancelled',
      'offer',
      'done',
    ]);
    expect(completed).toEqual([1]);
    expect(failures).toEqual([]);
    expect(sinks).toHaveLength(2);
  });

  it('keeps the share when the terminator is a round trip behind the cancel', async () => {
    // The hazard, with the wire in the shape that has it. The sender's own
    // answer to a cancel is the terminator, and it goes out after everything the
    // engine had already sent -- so on a real connection it arrives long after
    // the receiver has stopped discarding. Anything the sender says on the way
    // out ends the drain first, and the terminator then belongs to the next
    // file's engine, which has no reason to expect it and closes the channel.
    const key = await importRawKey(await generateRawKey());
    const wire = createDeferredPair();
    const seen = fromSender(wire.b);
    const files = [await fileOf(CHUNK_SIZE * 4, 'skipped.bin'), await fileOf(64, 'next.bin')];
    const failures: string[] = [];
    const completed: number[] = [];
    const sender = new SenderSession(wire.a, key, files, {
      pollIntervalMs: 0,
      onError: (_index, message) => failures.push(message),
      onComplete: (index) => completed.push(index),
    });
    const sinks: SpySink[] = [];
    const controller = new AbortController();
    const receiver = new ReceiverSession(wire.b, key, {
      openSink: async () => {
        const sink = new SpySink();
        sinks.push(sink);
        return sink;
      },
      onManifest: () => {},
      onProgress: (_index, received) => {
        if (received > 0n) controller.abort();
      },
    });
    const serving = sender.run();
    const connecting = receiver.run();
    await pump(2, wire.deliver);
    await connecting;

    const skipping = receiver.select(0, controller.signal);
    const cancelled = skipping.then(
      () => null,
      (cause: unknown) => cause,
    );
    await pump(8, wire.deliver);
    expect(await within(1000, cancelled)).toBeInstanceOf(TransferCancelledError);
    expect(
      seen.filter((control) => control.t === 'cancelled'),
      'the cancel is on the wire and the sender has not read it yet',
    ).toEqual([]);

    // Read now, while the sender is still parked mid-file with three chunks of
    // it to go. This is the common cancel path, and the one that used to put an
    // error frame on the wire ahead of the terminator.
    await settle();
    wire.deliver();
    await settle();
    expect(
      seen.filter((control) => control.t === 'cancelled'),
      'the sender has been asked to stop and has said nothing yet',
    ).toEqual([]);

    // Asked for at once, so it is waiting on the drain when the sender's answer
    // is still in flight, and the sender is still holding the rest of the file.
    const second = receiver.select(1);
    // Held from the start: the failure this test exists to catch arrives a whole
    // round trip before the assertion that reads it, and an unwatched rejection
    // in between is noise that hides a real one.
    const secondOutcome = second.then(
      () => null,
      (cause: unknown) => cause,
    );
    wire.release();
    await pump(60, wire.deliver);

    expect(
      seen.filter((control) => control.t === 'error'),
      'a cancel is not the sender stopping, and the frame that says so ends the share',
    ).toEqual([]);
    await expect(secondOutcome).resolves.toBeNull();
    expect(completed).toEqual([1]);
    expect(failures).toEqual([]);
    expect(sinks[1]?.byteLength).toBe(64);

    await receiver.finish();
    await pump(3, wire.deliver);
    await expect(serving).resolves.toBeUndefined();
  });

  it('still tells the peer the sender stopped when the peer reports a failure', async () => {
    // The one wait where the sender is not the party that asked to stop. The peer
    // has said the transfer failed, so it will be waiting for whatever comes
    // next, and silence would leave it to time out.
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE * 4),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX },
    );

    const running = engine.run();
    await settle();
    // Whatever the peer said, verbatim. The text is the peer's to choose, so
    // there is nothing here to match against production wording.
    peer.deliver(serializeControl({ t: 'error', message: 'peer said no (arbitrary text)' }));

    await expect(running).resolves.toBeUndefined();
    expect(peer.controls().at(-1)).toEqual({
      t: 'error',
      message: 'The sender stopped sharing.',
    });
    expect(engine.state).toBe('aborted');
  });

  it('still fails and says so when the receiver goes quiet', async () => {
    // A stall is the sender stopping, and it is a failure with a reason the peer
    // can show. Going quiet about it would leave the peer to time out on its own
    // timer and blame itself.
    const peer = createManualPeer();
    const engine = new SenderEngine(
      peer.channel,
      randomBlob(CHUNK_SIZE + 3),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, stallTimeoutMs: 30 },
    );

    const running = engine.run();
    await settle();
    peer.deliver(serializeControl({ t: 'accept' }));
    await settle();

    await expect(running).rejects.toThrowError(SenderStalledError);
    expect(peer.controls().at(-1)).toMatchObject({ t: 'error' });
    expect(peer.controls().at(-1)).toMatchObject({ message: expect.stringMatching(/went quiet/i) });
    expect(engine.state).toBe('failed');
  });

  it('says nothing to a peer that has already gone', async () => {
    // The third case that is a real stop, and the reason the sender's own report
    // is not sent on the abort path either: a closed channel has nowhere to put
    // it, and what the peer gets instead is the close it already knows about.
    const { a, b } = createLoopbackPair();
    const seen = fromSender(b);
    playAcceptingReceiver(b);
    const engine = new SenderEngine(
      a,
      randomBlob(CHUNK_SIZE * 500),
      await importRawKey(await generateRawKey()),
      { fileIndex: FILE_INDEX, onProgress: () => b.close(), pollIntervalMs: 0 },
    );

    await engine.run();

    expect(engine.state).toBe('aborted');
    expect(seen.filter((control) => control.t === 'error')).toEqual([]);
    expect(seen.map((control) => control.t)).toEqual(['offer']);
  });
});
