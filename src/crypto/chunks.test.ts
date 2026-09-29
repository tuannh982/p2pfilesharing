import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  DecryptionError,
  ProtocolRangeError,
  TAG_BYTES,
  decryptChunk,
  deriveNonce,
  encryptChunk,
} from './chunks';
import { generateRawKey, importRawKey } from './keys';

const bytes = (length: number, seed = 1): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

const flip = (target: Uint8Array<ArrayBuffer>, index: number, mask: number): ArrayBuffer => {
  const copy = new Uint8Array(target);
  copy[index] = (copy[index] ?? 0) ^ mask;
  return copy.buffer;
};

describe('deriveNonce', () => {
  it('produces a 12-byte nonce of a 4-byte file index then an 8-byte chunk index', () => {
    const nonce = deriveNonce(3, 258n);
    expect(nonce).toHaveLength(12);
    expect(new DataView(nonce.buffer).getUint32(0)).toBe(3);
    expect(new DataView(nonce.buffer).getBigUint64(4)).toBe(258n);
  });

  it('pins the full 8-byte chunk index write, so an index above 2^32 cannot be truncated', () => {
    const nonce = deriveNonce(1, 2n ** 40n);
    expect(new DataView(nonce.buffer).getBigUint64(4)).toBe(2n ** 40n);
  });

  it('gives two files the same chunk index different nonces, which is the whole point', () => {
    expect(deriveNonce(1, 0n)).not.toEqual(deriveNonce(2, 0n));
    expect(deriveNonce(1, 7n)).not.toEqual(deriveNonce(2, 7n));
  });

  it('never repeats across the file and chunk space', () => {
    const seen = new Set<string>();
    for (let file = 0; file < 40; file += 1) {
      for (let chunk = 0; chunk < 125; chunk += 1) {
        seen.add(deriveNonce(file, BigInt(chunk)).join(','));
      }
    }
    expect(seen.size).toBe(40 * 125);
  });

  it('refuses a file index that does not fit in four bytes', () => {
    expect(() => deriveNonce(2 ** 32, 0n)).toThrowError(ProtocolRangeError);
    expect(() => deriveNonce(-1, 0n)).toThrowError(ProtocolRangeError);
  });

  it('refuses a chunk index that does not fit in eight bytes', () => {
    expect(() => deriveNonce(0, 2n ** 64n)).toThrowError(ProtocolRangeError);
    expect(() => deriveNonce(0, -1n)).toThrowError(ProtocolRangeError);
  });

  it('accepts the largest chunk index it can encode, so the guard is not off by one', () => {
    expect(deriveNonce(0, 2n ** 64n - 1n)).toHaveLength(12);
  });
});

describe('chunk encryption', () => {
  it('round-trips a full 64 KiB chunk', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = bytes(CHUNK_SIZE);
    const frame = await encryptChunk(key, plain, 0, 7n);
    expect(frame.byteLength).toBe(CHUNK_SIZE + TAG_BYTES);
    expect(await decryptChunk(key, frame, 0, 7n)).toEqual(plain);
  });

  it('round-trips a short final chunk', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = bytes(1234);
    const frame = await encryptChunk(key, plain, 0, 0n);
    expect(frame.byteLength).toBe(1234 + TAG_BYTES);
    expect(await decryptChunk(key, frame, 0, 0n)).toEqual(plain);
  });

  it('round-trips an empty chunk, which a zero-byte file produces', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, new Uint8Array(0), 0, 0n);
    expect(await decryptChunk(key, frame, 0, 0n)).toEqual(new Uint8Array(0));
  });

  it('fails when the chunk index does not match, catching a desynced stream', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(64), 0, 3n);
    await expect(decryptChunk(key, frame, 0, 4n)).rejects.toThrowError(DecryptionError);
  });

  it('reports an out-of-range index as a range failure, not a decryption failure', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(64), 0, 0n);
    await expect(decryptChunk(key, frame, 0, -1n)).rejects.toThrowError(ProtocolRangeError);
    await expect(decryptChunk(key, frame, 2 ** 32, 0n)).rejects.toThrowError(ProtocolRangeError);
  });

  it('fails when one ciphertext bit is flipped', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = new Uint8Array(await encryptChunk(key, bytes(256), 0, 0n));
    await expect(decryptChunk(key, flip(frame, 10, 0x01), 0, 0n)).rejects.toThrowError(
      DecryptionError,
    );
  });

  it('fails when one tag bit is flipped', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = new Uint8Array(await encryptChunk(key, bytes(256), 0, 0n));
    const tampered = flip(frame, frame.length - 1, 0x80);
    await expect(decryptChunk(key, tampered, 0, 0n)).rejects.toThrowError(DecryptionError);
  });

  it('fails when decrypted with the wrong key', async () => {
    const frame = await encryptChunk(await importRawKey(await generateRawKey()), bytes(256), 0, 0n);
    const other = await importRawKey(await generateRawKey());
    await expect(decryptChunk(other, frame, 0, 0n)).rejects.toThrowError(DecryptionError);
  });

  it('fails on a truncated or all-zero frame that never came from encryptChunk', async () => {
    const key = await importRawKey(await generateRawKey());
    const truncated = new Uint8Array(4);
    await expect(decryptChunk(key, truncated.buffer, 0, 0n)).rejects.toThrowError(DecryptionError);
    const allZero = new Uint8Array(CHUNK_SIZE + TAG_BYTES);
    await expect(decryptChunk(key, allZero.buffer, 0, 0n)).rejects.toThrowError(DecryptionError);
  });
});

describe('multi-file nonce safety', () => {
  it('round-trips the same chunk index under two different file indices', async () => {
    const key = await importRawKey(await generateRawKey());
    const first = bytes(512, 3);
    const second = bytes(512, 9);

    const a = await encryptChunk(key, first, 1, 0n);
    const b = await encryptChunk(key, second, 2, 0n);

    expect(await decryptChunk(key, a, 1, 0n)).toEqual(first);
    expect(await decryptChunk(key, b, 2, 0n)).toEqual(second);
  });

  it('fails when a frame is decrypted under the wrong file index', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(256), 1, 0n);
    await expect(decryptChunk(key, frame, 2, 0n)).rejects.toThrowError(DecryptionError);
  });

  it('fails when a frame is decrypted under the wrong chunk index in the same file', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(256), 1, 4n);
    await expect(decryptChunk(key, frame, 1, 5n)).rejects.toThrowError(DecryptionError);
  });

  it('leaves the reserved manifest index disjoint from the first real file', async () => {
    const key = await importRawKey(await generateRawKey());
    const manifestPlain = bytes(64, 3);
    const firstFilePlain = bytes(64, 9);
    const manifest = await encryptChunk(key, manifestPlain, 0, 0n);
    const firstFile = await encryptChunk(key, firstFilePlain, 1, 0n);

    expect(deriveNonce(0, 0n)).not.toEqual(deriveNonce(1, 0n));
    expect(await decryptChunk(key, manifest, 0, 0n)).toEqual(manifestPlain);
    expect(await decryptChunk(key, firstFile, 1, 0n)).toEqual(firstFilePlain);
    await expect(decryptChunk(key, manifest, 1, 0n)).rejects.toThrowError(DecryptionError);
    await expect(decryptChunk(key, firstFile, 0, 0n)).rejects.toThrowError(DecryptionError);
  });
});
