import { describe, expect, it } from 'vitest';
import {
  CHUNK_DOMAIN,
  CHUNK_SIZE,
  DecryptionError,
  MANIFEST_DOMAIN,
  ProtocolRangeError,
  TAG_BYTES,
  buildBinding,
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

const binding = (fileIndex = 1, totalSize = 0n): Uint8Array<ArrayBuffer> =>
  buildBinding(CHUNK_DOMAIN, fileIndex, totalSize);

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
    const frame = await encryptChunk(key, plain, 0, 7n, binding(0));
    expect(frame.byteLength).toBe(CHUNK_SIZE + TAG_BYTES);
    expect(await decryptChunk(key, frame, 0, 7n, binding(0))).toEqual(plain);
  });

  it('round-trips a short final chunk', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = bytes(1234);
    const frame = await encryptChunk(key, plain, 0, 0n, binding(0));
    expect(frame.byteLength).toBe(1234 + TAG_BYTES);
    expect(await decryptChunk(key, frame, 0, 0n, binding(0))).toEqual(plain);
  });

  it('round-trips an empty chunk, which a zero-byte file produces', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, new Uint8Array(0), 0, 0n, binding(0));
    expect(await decryptChunk(key, frame, 0, 0n, binding(0))).toEqual(new Uint8Array(0));
  });

  it('fails when the chunk index does not match, catching a desynced stream', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(64), 0, 3n, binding(0));
    await expect(decryptChunk(key, frame, 0, 4n, binding(0))).rejects.toThrowError(DecryptionError);
  });

  it('reports an out-of-range index as a range failure, not a decryption failure', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(64), 0, 0n, binding(0));
    await expect(decryptChunk(key, frame, 0, -1n, binding(0))).rejects.toThrowError(
      ProtocolRangeError,
    );
    await expect(decryptChunk(key, frame, 2 ** 32, 0n, binding(0))).rejects.toThrowError(
      ProtocolRangeError,
    );
  });

  it('fails when one ciphertext bit is flipped', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = new Uint8Array(await encryptChunk(key, bytes(256), 0, 0n, binding(0)));
    await expect(decryptChunk(key, flip(frame, 10, 0x01), 0, 0n, binding(0))).rejects.toThrowError(
      DecryptionError,
    );
  });

  it('fails when one tag bit is flipped', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = new Uint8Array(await encryptChunk(key, bytes(256), 0, 0n, binding(0)));
    const tampered = flip(frame, frame.length - 1, 0x80);
    await expect(decryptChunk(key, tampered, 0, 0n, binding(0))).rejects.toThrowError(
      DecryptionError,
    );
  });

  it('fails when decrypted with the wrong key', async () => {
    const frame = await encryptChunk(
      await importRawKey(await generateRawKey()),
      bytes(256),
      0,
      0n,
      binding(0),
    );
    const other = await importRawKey(await generateRawKey());
    await expect(decryptChunk(other, frame, 0, 0n, binding(0))).rejects.toThrowError(
      DecryptionError,
    );
  });

  it('fails on a truncated or all-zero frame that never came from encryptChunk', async () => {
    const key = await importRawKey(await generateRawKey());
    const truncated = new Uint8Array(4);
    await expect(decryptChunk(key, truncated.buffer, 0, 0n, binding(0))).rejects.toThrowError(
      DecryptionError,
    );
    const allZero = new Uint8Array(CHUNK_SIZE + TAG_BYTES);
    await expect(decryptChunk(key, allZero.buffer, 0, 0n, binding(0))).rejects.toThrowError(
      DecryptionError,
    );
  });

  it('names the likely cause without accusing the sender', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(64), 1, 0n, binding(1, 64n));
    // Models a build that sealed this frame under a different binding: the
    // chunk index is unchanged, so only the binding disagrees. A wrong key and
    // a tampered frame reach the same catch, so neither may be asserted.
    const failure = await decryptChunk(key, frame, 1, 0n, binding(2, 64n)).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(DecryptionError);
    const message = (failure as Error).message;
    expect(message).toMatch(/reload/i);
    expect(message).not.toMatch(/out of date|is stale|tampered/i);
  });
});

describe('multi-file nonce safety', () => {
  it('round-trips the same chunk index under two different file indices', async () => {
    const key = await importRawKey(await generateRawKey());
    const first = bytes(512, 3);
    const second = bytes(512, 9);

    const a = await encryptChunk(key, first, 1, 0n, binding(1));
    const b = await encryptChunk(key, second, 2, 0n, binding(2));

    expect(await decryptChunk(key, a, 1, 0n, binding(1))).toEqual(first);
    expect(await decryptChunk(key, b, 2, 0n, binding(2))).toEqual(second);
  });

  it('fails when a frame is decrypted under the wrong file index', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(256), 1, 0n, binding(1));
    await expect(decryptChunk(key, frame, 2, 0n, binding(1))).rejects.toThrowError(
      DecryptionError,
    );
  });

  it('fails when a frame is decrypted under the wrong chunk index in the same file', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(256), 1, 4n, binding(1));
    await expect(decryptChunk(key, frame, 1, 5n, binding(1))).rejects.toThrowError(
      DecryptionError,
    );
  });

  it('leaves the reserved manifest index disjoint from the first real file', async () => {
    const key = await importRawKey(await generateRawKey());
    const manifestPlain = bytes(64, 3);
    const firstFilePlain = bytes(64, 9);
    const manifest = await encryptChunk(key, manifestPlain, 0, 0n, binding(0));
    const firstFile = await encryptChunk(key, firstFilePlain, 1, 0n, binding(1));

    expect(deriveNonce(0, 0n)).not.toEqual(deriveNonce(1, 0n));
    expect(await decryptChunk(key, manifest, 0, 0n, binding(0))).toEqual(manifestPlain);
    expect(await decryptChunk(key, firstFile, 1, 0n, binding(1))).toEqual(firstFilePlain);
    await expect(decryptChunk(key, manifest, 1, 0n, binding(0))).rejects.toThrowError(
      DecryptionError,
    );
    await expect(decryptChunk(key, firstFile, 0, 0n, binding(1))).rejects.toThrowError(
      DecryptionError,
    );
  });
});

describe('buildBinding', () => {
  it('separates a file chunk from the manifest, so the reserved index cannot be confused', () => {
    // Same file index and same total size on both sides, so the domain byte is
    // the only thing that can make these two differ.
    const chunk = buildBinding(CHUNK_DOMAIN, 0, 0n);
    const manifest = buildBinding(MANIFEST_DOMAIN, 0, 0n);
    expect(new Uint8Array(chunk)).not.toEqual(new Uint8Array(manifest));
  });

  it('changes with the file index and with the total size', () => {
    const base = buildBinding(CHUNK_DOMAIN, 1, 100n);
    expect(new Uint8Array(buildBinding(CHUNK_DOMAIN, 2, 100n))).not.toEqual(new Uint8Array(base));
    expect(new Uint8Array(buildBinding(CHUNK_DOMAIN, 1, 101n))).not.toEqual(new Uint8Array(base));
  });

  it('is thirteen bytes: one domain, four index, eight size', () => {
    expect(buildBinding(CHUNK_DOMAIN, 1, 100n).byteLength).toBe(13);
  });

  it('lays the fields out big-endian, so the binding is one canonical encoding', () => {
    const view = new DataView(buildBinding(CHUNK_DOMAIN, 0x01020304, 0x0a0b0c0d0e0f1011n).buffer);
    expect(view.getUint8(0)).toBe(CHUNK_DOMAIN);
    expect(view.getUint32(1)).toBe(0x01020304);
    expect(view.getBigUint64(5)).toBe(0x0a0b0c0d0e0f1011n);
  });

  it('carries a manifest total size of zero, which is what the manifest always binds', () => {
    expect(buildBinding(MANIFEST_DOMAIN, 0, 0n).byteLength).toBe(13);
    expect(new DataView(buildBinding(MANIFEST_DOMAIN, 0, 0n).buffer).getBigUint64(5)).toBe(0n);
  });

  it('refuses a domain that is not a whole byte', () => {
    expect(() => buildBinding(-1, 0, 0n)).toThrowError(ProtocolRangeError);
    expect(() => buildBinding(0x100, 0, 0n)).toThrowError(ProtocolRangeError);
    expect(() => buildBinding(1.5, 0, 0n)).toThrowError(ProtocolRangeError);
  });

  it('refuses a file index or a total size that does not fit its field', () => {
    expect(() => buildBinding(CHUNK_DOMAIN, 2 ** 32, 0n)).toThrowError(ProtocolRangeError);
    expect(() => buildBinding(CHUNK_DOMAIN, -1, 0n)).toThrowError(ProtocolRangeError);
    expect(() => buildBinding(CHUNK_DOMAIN, 0, 2n ** 64n)).toThrowError(ProtocolRangeError);
    expect(() => buildBinding(CHUNK_DOMAIN, 0, -1n)).toThrowError(ProtocolRangeError);
  });

  it('accepts the largest index and size it can encode, so the guards are not off by one', () => {
    expect(buildBinding(CHUNK_DOMAIN, 2 ** 32 - 1, 2n ** 64n - 1n).byteLength).toBe(13);
  });
});

describe('chunk binding', () => {
  it('round-trips when the binding matches', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = bytes(1024);
    const binding = buildBinding(CHUNK_DOMAIN, 1, 1024n);
    const frame = await encryptChunk(key, plain, 1, 0n, binding);
    const opened = await decryptChunk(key, frame, 1, 0n, binding);
    expect(new Uint8Array(opened)).toEqual(plain);
  });

  it('refuses a frame bound to a different file index', async () => {
    const key = await importRawKey(await generateRawKey());
    const binding = buildBinding(CHUNK_DOMAIN, 1, 1024n);
    const frame = await encryptChunk(key, bytes(1024), 1, 0n, binding);
    await expect(
      decryptChunk(key, frame, 1, 0n, buildBinding(CHUNK_DOMAIN, 2, 1024n)),
    ).rejects.toThrowError(DecryptionError);
  });

  it('refuses a frame bound to a different total size', async () => {
    const key = await importRawKey(await generateRawKey());
    const binding = buildBinding(CHUNK_DOMAIN, 1, 1024n);
    const frame = await encryptChunk(key, bytes(1024), 1, 0n, binding);
    await expect(
      decryptChunk(key, frame, 1, 0n, buildBinding(CHUNK_DOMAIN, 1, 2048n)),
    ).rejects.toThrowError(DecryptionError);
  });

  it('refuses a frame presented as the other kind of frame', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(
      key,
      bytes(64),
      0,
      0n,
      buildBinding(MANIFEST_DOMAIN, 0, 0n),
    );
    await expect(
      decryptChunk(key, frame, 0, 0n, buildBinding(CHUNK_DOMAIN, 0, 0n)),
    ).rejects.toThrowError(DecryptionError);
  });

  it('does not put the binding in the ciphertext, so it is not recoverable from the wire', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = bytes(64);
    const frame = new Uint8Array(
      await encryptChunk(key, plain, 1, 0n, buildBinding(CHUNK_DOMAIN, 1, 64n)),
    );
    // TAG_BYTES of authentication plus one byte of ciphertext, so the frame
    // length is unchanged by the binding.
    expect(frame.byteLength).toBe(plain.byteLength + TAG_BYTES);
  });

  it('leaves the frame length identical across every binding, which is what "not on the wire" means', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = bytes(64);
    const lengths = await Promise.all(
      [
        buildBinding(CHUNK_DOMAIN, 1, 64n),
        buildBinding(CHUNK_DOMAIN, 2, 64n),
        buildBinding(CHUNK_DOMAIN, 1, 65n),
        buildBinding(MANIFEST_DOMAIN, 0, 0n),
        new Uint8Array(0),
        new Uint8Array(9999),
      ].map(async (b) => (await encryptChunk(key, plain, 1, 0n, b)).byteLength),
    );
    expect(new Set(lengths).size).toBe(1);
    expect(lengths[0]).toBe(64 + TAG_BYTES);
  });

  it('does not leak the binding bytes anywhere in the frame, so they are not readable off the wire', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = bytes(64);
    const binding = buildBinding(CHUNK_DOMAIN, 0x01020304, 0x0a0b0c0d0e0f1011n);
    const frame = new Uint8Array(await encryptChunk(key, plain, 1, 0n, binding));
    for (let i = 0; i + binding.byteLength <= frame.byteLength; i += 1) {
      expect(new Uint8Array(frame.subarray(i, i + binding.byteLength))).not.toEqual(binding);
    }
  });

  it('still fails authentication when only the size changes and the index is right', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(64), 1, 0n, buildBinding(CHUNK_DOMAIN, 1, 0n));
    await expect(
      decryptChunk(key, frame, 1, 0n, buildBinding(CHUNK_DOMAIN, 1, 1n)),
    ).rejects.toThrowError(DecryptionError);
  });

  it('keeps two files that differ only in total size from decrypting each other', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = bytes(64);
    const small = await encryptChunk(key, plain, 1, 0n, buildBinding(CHUNK_DOMAIN, 1, 64n));
    const large = await encryptChunk(key, plain, 1, 0n, buildBinding(CHUNK_DOMAIN, 1, 65n));
    await expect(
      decryptChunk(key, small, 1, 0n, buildBinding(CHUNK_DOMAIN, 1, 65n)),
    ).rejects.toThrowError(DecryptionError);
    await expect(
      decryptChunk(key, large, 1, 0n, buildBinding(CHUNK_DOMAIN, 1, 64n)),
    ).rejects.toThrowError(DecryptionError);
  });
});

describe('an absent binding', () => {
  // The signature already forbids these, so a cast stands in for the caller
  // the typechecker cannot catch: a stale bundle, or plain JavaScript.
  const missing = undefined as unknown as Uint8Array<ArrayBuffer>;
  const wrongType = 'not bytes' as unknown as Uint8Array<ArrayBuffer>;

  it('refuses to seal a frame with no binding, rather than sealing it unbound', async () => {
    const key = await importRawKey(await generateRawKey());
    await expect(encryptChunk(key, bytes(64), 1, 0n, missing)).rejects.toThrowError(
      ProtocolRangeError,
    );
  });

  it('refuses to open a frame with no binding', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(64), 1, 0n, binding(1));
    await expect(decryptChunk(key, frame, 1, 0n, missing)).rejects.toThrowError(
      ProtocolRangeError,
    );
  });

  it('reports the missing binding as a range failure, not a decryption failure', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptChunk(key, bytes(64), 1, 0n, binding(1));
    // The class is the claim: `not.toThrowError(DecryptionError)` alone would pass
    // for a rejection of any other shape, including a plain Error, which is what
    // a frame reported as corrupt would raise. A binding the caller never passed
    // is an argument out of range, checked before the cipher is reached.
    const rejected = decryptChunk(key, frame, 1, 0n, missing);
    await expect(rejected).rejects.toThrowError(ProtocolRangeError);
    await expect(rejected).rejects.not.toThrowError(DecryptionError);
  });

  it('refuses a binding that is not a Uint8Array, which WebCrypto would also accept', async () => {
    const key = await importRawKey(await generateRawKey());
    await expect(encryptChunk(key, bytes(64), 1, 0n, wrongType)).rejects.toThrowError(
      ProtocolRangeError,
    );
  });

  it('accepts an empty binding, so the guard checks presence and not length', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = bytes(64);
    const frame = await encryptChunk(key, plain, 1, 0n, new Uint8Array(0));
    expect(new Uint8Array(await decryptChunk(key, frame, 1, 0n, new Uint8Array(0)))).toEqual(
      plain,
    );
  });

  it('accepts a binding far longer than the binding layout, for the same reason', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = bytes(64);
    const oversized = bytes(9999);
    const frame = await encryptChunk(key, plain, 1, 0n, oversized);
    expect(new Uint8Array(await decryptChunk(key, frame, 1, 0n, oversized))).toEqual(plain);
  });
});
