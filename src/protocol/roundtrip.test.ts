import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, DecryptionError, TAG_BYTES } from '../crypto/chunks';
import { importRawKey } from '../crypto/keys';
import { MemorySink } from '../sink/memory';
import type { ChannelMessage } from '../transport/channel';
import { createLoopbackPair } from '../transport/loopback';
import { decodeShare, encodeShare } from '../token/codec';
import { mintSharePayload } from '../token/mint';
import { parseControl } from './messages';
import { ReceiverEngine, SenderEngine } from './transfer';

const RANDOM_LIMIT = 65536;
const FILE_INDEX = 1;

const randomBytes = (size: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += RANDOM_LIMIT) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + RANDOM_LIMIT, size)));
  }
  return bytes;
};

const randomFile = (name: string, size: number): File => new File([randomBytes(size)], name);

const isFrame = (msg: ChannelMessage): msg is ArrayBuffer => msg instanceof ArrayBuffer;

const isControl = (msg: ChannelMessage): msg is string => typeof msg === 'string';

const firstDifference = (got: Uint8Array, want: Uint8Array): number => {
  if (got.length !== want.length) return Math.min(got.length, want.length);
  for (let i = 0; i < want.length; i += 1) {
    if (got[i] !== want[i]) return i;
  }
  return -1;
};

const containsBytes = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  if (needle.length === 0) return true;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let match = true;
    for (let i = 0; i < needle.length; i += 1) {
      if (haystack[start + i] !== needle[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
};

const roundTrip = async (
  name: string,
  size: number,
  senderIndex: number = FILE_INDEX,
  receiverIndex: number = FILE_INDEX,
) => {
  const minted = await mintSharePayload();
  const decoded = decodeShare(encodeShare(minted));
  const secret = randomFile(name, size);

  const { a, b } = createLoopbackPair();
  const sink = new MemorySink();
  const wire: ChannelMessage[] = [];
  const reply: ChannelMessage[] = [];
  b.onMessage((m) => wire.push(m));
  a.onMessage((m) => reply.push(m));

  const receiver = new ReceiverEngine(
    b,
    await importRawKey(decoded.key),
    { size: BigInt(size) },
    sink,
    { fileIndex: receiverIndex },
  );
  const receiving = receiver.run();
  const sender = new SenderEngine(a, secret, await importRawKey(minted.key), {
    fileIndex: senderIndex,
    pollIntervalMs: 0,
  });
  const sending = sender.run();
  const failure = await receiving.then(
    () => null,
    (cause: unknown) => cause,
  );
  await sending.then(
    () => undefined,
    () => undefined,
  );

  return { sender, receiver, sink, wire, reply, secret, failure };
};

describe('end-to-end round trip', () => {
  it('delivers a multi-chunk file byte for byte on the decoded share key', async () => {
    const size = CHUNK_SIZE * 3 + 777;
    const { sender, receiver, sink, wire, secret } = await roundTrip('roundtrip.bin', size);

    expect(sender.state).toBe('completed');
    expect(receiver.state).toBe('completed');
    expect(sink.byteLength).toBe(size);
    expect(firstDifference(sink.toUint8Array(), new Uint8Array(await secret.arrayBuffer()))).toBe(-1);
    expect(wire.filter(isFrame).map((f) => f.byteLength)).toEqual([
      CHUNK_SIZE + TAG_BYTES,
      CHUNK_SIZE + TAG_BYTES,
      CHUNK_SIZE + TAG_BYTES,
      777 + TAG_BYTES,
    ]);
  });

  it('carries a zero-byte file through offer, accept and done with no frames', async () => {
    const { sender, receiver, sink, wire, reply } = await roundTrip('empty.bin', 0);

    expect(sender.state).toBe('completed');
    expect(receiver.state).toBe('completed');
    expect(sink.byteLength).toBe(0);
    expect(sink.toUint8Array()).toEqual(new Uint8Array(0));
    expect(wire.filter(isFrame)).toHaveLength(0);
    expect(wire.filter(isControl).map(parseControl)).toEqual([
      { t: 'offer', chunkSize: CHUNK_SIZE },
      { t: 'done' },
    ]);
    expect(reply.filter(isControl).map(parseControl)).toEqual([{ t: 'accept' }, { t: 'done' }]);
  });

  it('puts no plaintext frame on the wire', async () => {
    const size = 2048;
    const { wire, secret } = await roundTrip('secret.bin', size);
    const plain = new Uint8Array(await secret.arrayBuffer());
    const frames = wire.filter(isFrame);

    expect(frames).toHaveLength(1);
    for (const frame of frames) {
      const bytes = new Uint8Array(frame);
      expect(bytes.byteLength).toBe(size + TAG_BYTES);
      expect(bytes).not.toEqual(plain);
      expect(containsBytes(bytes, plain)).toBe(false);
    }
  });

  it('fails a share whose sender and receiver sit on different file indices', async () => {
    const size = 2048;
    const { sender, receiver, sink, failure } = await roundTrip('secret.bin', size, 2, 0);

    expect(failure).toBeInstanceOf(DecryptionError);
    expect(receiver.state).toBe('failed');
    expect(sender.state).not.toBe('completed');
    expect(sink.byteLength).toBe(0);
  });
});
