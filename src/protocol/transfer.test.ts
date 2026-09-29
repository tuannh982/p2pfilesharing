import { describe, expect, it, vi } from 'vitest';
import {
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
import {
  CLOSE_MESSAGES,
  DEFAULT_STALL_TIMEOUT_MS,
  DeliveryUnconfirmedError,
  ReceiverEngine,
  SenderEngine,
  SenderStalledError,
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
      { t: 'offer', name: '', size: '0', chunkSize: CHUNK_SIZE },
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
      const got = await decryptChunk(key, seen.frames[i] as ArrayBuffer, FILE_INDEX, BigInt(i));
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

  it('stops and tells the peer when aborted mid-transfer', async () => {
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
    expect(seen.controls.at(-1)).toEqual({ t: 'error', message: 'The sender stopped sharing.' });
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

  it('sends the stopped message exactly once and never a done', async () => {
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

    const stopped = seen.controls.filter(
      (c) => c.t === 'error' && c.message === 'The sender stopped sharing.',
    );
    expect(stopped).toHaveLength(1);
    expect(seen.controls).not.toContainEqual({ t: 'done' });
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
      { t: 'offer', name: '', size: String(size), chunkSize: CHUNK_SIZE },
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
    peer.deliver(serializeControl({ t: 'error', message: 'This transfer does not match this link.' }));

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
      { name: '', size: BigInt(size) },
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
      { name: '', size: BigInt(size) }, sink, { fileIndex: FILE_INDEX });

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
    expectedName = '',
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
      { name: expectedName, size: BigInt(size) },
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
    const receiver = new ReceiverEngine(b, key, { name: '', size: BigInt(size) }, sink, { fileIndex: FILE_INDEX,
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
      { t: 'offer', name: '', size: String(size), chunkSize: CHUNK_SIZE },
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
    const receiver = new ReceiverEngine(b, key, { name: '', size: 500n }, sink, { fileIndex: FILE_INDEX });

    a.send(serializeControl({ t: 'offer', name: '', size: '500', chunkSize: CHUNK_SIZE }));
    await settle();
    a.send(await encryptChunk(key, plain, FILE_INDEX, 0n));
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
      { name: '', size: BigInt(size) },
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
      { name: '', size: BigInt(size) },
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
      transfer(CHUNK_SIZE + 100, await generateRawKey(), '', (frame, i) => {
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
      { name: '', size: BigInt(size) },
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
      { name: 'file.bin', size: 10n },
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
      { name: 'file.bin', size: 1000n }, sink, { fileIndex: FILE_INDEX });
    const receiving = receiver.run();

    a.send(
      serializeControl({ t: 'offer', name: 'file.bin', size: '1000', chunkSize: CHUNK_SIZE }),
    );
    await settle();
    a.send(await encryptChunk(key, new Uint8Array(400), FILE_INDEX, 0n));
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
      { name: 'file.bin', size: 100n },
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
      { name: 'file.bin', size: 1000n },
      sink, { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();

    peer.deliver(
      serializeControl({ t: 'offer', name: 'file.bin', size: '1000', chunkSize: CHUNK_SIZE }),
    );
    await settle();
    peer.deliver(await encryptChunk(key, new Uint8Array(400), FILE_INDEX, 0n));
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
      { name: 'file.bin', size: 100n },
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
      { name: 'file.bin', size: 100n },
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

  it('rejects an offer that disagrees with the token', async () => {
    const { a, b } = createLoopbackPair();
    const seen = watch(a);
    const receiver = new ReceiverEngine(
      b,
      await importRawKey(await generateRawKey()),
      { name: 'expected.bin', size: 1000n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();
    a.send(serializeControl({ t: 'offer', name: 'other.bin', size: '1000', chunkSize: CHUNK_SIZE }));
    await expect(receiving).rejects.toThrowError(/does not match this link/i);
    await settle();
    expect(seen.controls).toEqual([
      { t: 'error', message: 'This transfer does not match this link.' },
    ]);
    expect(seen.controls).not.toContainEqual({ t: 'accept' });
  });

  it('rejects an offer with an unsupported chunk size', async () => {
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverEngine(
      b,
      await importRawKey(await generateRawKey()),
      { name: 'file.bin', size: 1000n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();
    a.send(serializeControl({ t: 'offer', name: 'file.bin', size: '1000', chunkSize: 4096 }));
    await expect(receiving).rejects.toThrowError(/chunk size/i);
  });

  it('rejects an offer followed by more data than it declared', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverEngine(
      b,
      key,
      { name: 'file.bin', size: 10n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();
    a.send(serializeControl({ t: 'offer', name: 'file.bin', size: '10', chunkSize: CHUNK_SIZE }));
    await settle();
    a.send(await encryptChunk(key, new Uint8Array(50), FILE_INDEX, 0n));
    await expect(receiving).rejects.toThrowError(/more data than it declared/i);
  });

  it('rejects an oversized frame on its ciphertext length, before decrypting it', async () => {
    const key = await importRawKey(await generateRawKey());
    const stranger = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverEngine(
      b,
      key,
      { name: 'file.bin', size: 10n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      const receiving = receiver.run();
      a.send(serializeControl({ t: 'offer', name: 'file.bin', size: '10', chunkSize: CHUNK_SIZE }));
      await settle();
      a.send(await encryptChunk(stranger, new Uint8Array(50), FILE_INDEX, 0n));

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
      { name: 'file.bin', size: 100n },
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
      { name: 'expected.bin', size: 1000n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();

    peer.deliver(
      serializeControl({ t: 'offer', name: 'other.bin', size: '1000', chunkSize: CHUNK_SIZE }),
    );

    await expect(receiving).rejects.toThrowError(/does not match this link/i);
    await settle();
    expect(peer.sent).toEqual([
      serializeControl({ t: 'error', message: 'This transfer does not match this link.' }),
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
      { name: '', size: 10n }, new MemorySink(), { fileIndex: FILE_INDEX });
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
      { name: 'file.bin', size: 1000n },
      sink,
      { fileIndex: FILE_INDEX, stallTimeoutMs: 10 },
    );

    const receiving = receiver.run();
    peer.deliver(
      serializeControl({ t: 'offer', name: 'file.bin', size: '1000', chunkSize: CHUNK_SIZE }),
    );
    await settle();
    peer.deliver(await encryptChunk(key, new Uint8Array(400), FILE_INDEX, 0n));
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
      { name: 'file.bin', size: 100n },
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
      { name: '', size: BigInt(size) },
      sink,
      { fileIndex: FILE_INDEX, stallTimeoutMs: 500 },
    );

    const receiving = receiver.run();
    peer.deliver(serializeControl({ t: 'offer', name: '', size: String(size), chunkSize: CHUNK_SIZE }));
    await settle();
    peer.deliver(await encryptChunk(key, new Uint8Array(CHUNK_SIZE), FILE_INDEX, 0n));
    await new Promise((resolve) => setTimeout(resolve, 150));
    peer.deliver(await encryptChunk(key, new Uint8Array(1), FILE_INDEX, 1n));
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
      { name: 'file.bin', size: 1000n },
      new MemorySink(),
      { fileIndex: FILE_INDEX, stallTimeoutMs: 10 },
    );

    const receiving = receiver.run();
    peer.deliver(
      serializeControl({ t: 'offer', name: 'file.bin', size: '1000', chunkSize: CHUNK_SIZE }),
    );
    await settle();

    const outcome = await receiving.catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(TransferStalledError);
    expect(outcome).not.toBeInstanceOf(ProtocolError);
  });

  it('does not fire once the transfer has finished', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const receiver = new ReceiverEngine(b, key,
      { name: '', size: 10n }, new MemorySink(), { fileIndex: FILE_INDEX,
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
      { name: '', size: BigInt(size) },
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
      { name: '', size: BigInt(size) },
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
      { name: '', size: 10n },
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
      { name: '', size: BigInt(size) },
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

  it('still sends exactly one reason when the offer does not match the link', async () => {
    const key = await importRawKey(await generateRawKey());
    const peer = createManualPeer();
    const receiver = new ReceiverEngine(
      peer.channel,
      key,
      { name: 'expected.bin', size: 1000n },
      new MemorySink(), { fileIndex: FILE_INDEX },
    );
    const receiving = receiver.run();

    peer.deliver(
      serializeControl({ t: 'offer', name: 'other.bin', size: '1000', chunkSize: CHUNK_SIZE }),
    );

    await expect(receiving).rejects.toThrowError(/does not match this link/i);
    await settle();
    expect(peer.sent).toEqual([
      serializeControl({ t: 'error', message: 'This transfer does not match this link.' }),
    ]);
  });

  it('does not blame the receiver for a close it did not cause', async () => {
    const key = await importRawKey(await generateRawKey());
    const { a, b } = createLoopbackPair();
    const seen = watch(a);
    const receiver = new ReceiverEngine(b, key,
      { name: '', size: 100n }, new MemorySink(), { fileIndex: FILE_INDEX });

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
    const receiver = new ReceiverEngine(b, key, { name: '', size: BigInt(SIZE) }, sink, {
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
      const got = await decryptChunk(key, frame, 2, BigInt(i));
      expect(got).toEqual(expected.subarray(i * CHUNK_SIZE, i * CHUNK_SIZE + got.length));
      await expect(decryptChunk(key, frame, 0, BigInt(i))).rejects.toThrowError(DecryptionError);
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
