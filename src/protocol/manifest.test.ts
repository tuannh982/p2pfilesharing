import { describe, expect, it } from 'vitest';
import {
  BINDING_BYTES,
  buildBinding,
  CHUNK_DOMAIN,
  decryptChunk,
  DecryptionError,
  deriveNonce,
  encryptChunk,
  MANIFEST_DOMAIN,
  SIZE_BYTES,
  TAG_BYTES,
} from '../crypto/chunks';
import { generateRawKey, importRawKey } from '../crypto/keys';
import {
  decodeManifest,
  decryptManifest,
  encodeManifest,
  encryptManifest,
  FIRST_FILE_INDEX,
  MANIFEST_CHUNK_INDEX,
  MANIFEST_FILE_INDEX,
  ManifestError,
  manifestBinding,
  MAX_FILES,
  MAX_MANIFEST_BYTES,
  MAX_NAME_BYTES,
  manifestFromFiles,
  type ManifestEntry,
  validateManifest,
} from './manifest';

const sizeField = (binding: Uint8Array<ArrayBuffer>): number[] =>
  Array.from(binding.slice(BINDING_BYTES - SIZE_BYTES));

const entries: ManifestEntry[] = [
  { name: 'photo.jpg', size: 1048576n },
  { name: 'zdjęcie-🌞-テスト.txt', size: 0n },
  { name: 'archive.tar.gz', size: 9007199254740993n },
];

const lenientDecoder = new TextDecoder('utf-8', { fatal: false });

describe('manifest encoding', () => {
  it('round-trips every entry, including a size beyond 2^53 and a zero-byte file', () => {
    expect(decodeManifest(encodeManifest(entries))).toEqual(entries);
  });

  it('preserves order, so an index means the same thing to both peers', () => {
    const decoded = decodeManifest(encodeManifest(entries));
    expect(decoded.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
  });

  it('refuses a share with no files', () => {
    expect(() => encodeManifest([])).toThrowError(ManifestError);
  });

  it('refuses more files than one frame can carry, naming the limit', () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      name: `f${i}.bin`,
      size: 1n,
    }));
    expect(() => encodeManifest(many)).toThrowError(new RegExp(String(MAX_FILES)));
  });

  it('refuses a name longer than the byte limit', () => {
    expect(() => encodeManifest([{ name: 'a'.repeat(MAX_NAME_BYTES + 1), size: 1n }])).toThrowError(
      ManifestError,
    );
  });

  it('refuses an empty name', () => {
    expect(() => encodeManifest([{ name: '', size: 1n }])).toThrowError(ManifestError);
  });

  it('refuses a negative size', () => {
    expect(() => encodeManifest([{ name: 'a.bin', size: -1n }])).toThrowError(ManifestError);
  });

  it('rejects malformed JSON loudly', () => {
    expect(() => decodeManifest(new TextEncoder().encode('not json'))).toThrowError(ManifestError);
  });

  it('rejects a manifest with no files array', () => {
    expect(() => decodeManifest(new TextEncoder().encode('{"files":{}}'))).toThrowError(
      ManifestError,
    );
  });

  it('rejects a file entry missing its size', () => {
    expect(() =>
      decodeManifest(new TextEncoder().encode('{"files":[{"name":"a"}]}')),
    ).toThrowError(ManifestError);
  });

  it('rejects a numeric size, which would silently lose precision above 2^53', () => {
    expect(() =>
      decodeManifest(new TextEncoder().encode('{"files":[{"name":"a","size":9007199254740993}]}')),
    ).toThrowError(ManifestError);
  });

  it('rejects an empty name sent by a peer', () => {
    expect(() =>
      decodeManifest(new TextEncoder().encode('{"files":[{"name":"","size":"1"}]}')),
    ).toThrowError(ManifestError);
  });

  it('rejects an over-long name sent by a peer', () => {
    const long = 'a'.repeat(MAX_NAME_BYTES + 1);
    expect(() =>
      decodeManifest(
        new TextEncoder().encode(JSON.stringify({ files: [{ name: long, size: '1' }] })),
      ),
    ).toThrowError(ManifestError);
  });

  it('rejects a negative size sent by a peer', () => {
    expect(() =>
      decodeManifest(new TextEncoder().encode('{"files":[{"name":"a","size":"-1"}]}')),
    ).toThrowError(ManifestError);
  });

  it('rejects an empty file list sent by a peer', () => {
    expect(() => decodeManifest(new TextEncoder().encode('{"files":[]}'))).toThrowError(
      ManifestError,
    );
  });

  it('rejects a frame over the manifest byte limit, even when the manifest inside it is readable', () => {
    const padded = `{"files":[{"name":"a","size":"1"}]}${' '.repeat(MAX_MANIFEST_BYTES)}`;
    const bytes = new TextEncoder().encode(padded);
    expect(bytes.byteLength).toBeGreaterThan(MAX_MANIFEST_BYTES);
    expect(() => decodeManifest(bytes)).toThrowError(ManifestError);
  });

  it('rejects a frame over the manifest byte limit, so a huge size cannot be turned into a huge BigInt', () => {
    const bytes = new TextEncoder().encode(
      `{"files":[{"name":"a","size":"${'9'.repeat(200000)}"}]}`,
    );
    expect(bytes.byteLength).toBeGreaterThan(MAX_MANIFEST_BYTES);
    expect(() => decodeManifest(bytes)).toThrowError(ManifestError);
  });

  it('rejects a payload that is not an object at all', () => {
    expect(() => decodeManifest(new TextEncoder().encode('null'))).toThrowError(ManifestError);
  });

  it('rejects a payload that is a bare array', () => {
    expect(() => decodeManifest(new TextEncoder().encode('[]'))).toThrowError(ManifestError);
  });

  it('rejects a file entry that is not an object', () => {
    expect(() =>
      decodeManifest(new TextEncoder().encode('{"files":[null]}')),
    ).toThrowError(ManifestError);
  });

  it('rejects a frame listing more files than the limit, built by hand past the encoder', () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `f${i}`, size: '1' }));
    const bytes = new TextEncoder().encode(JSON.stringify({ files: many }));
    expect(bytes.byteLength).toBeLessThan(MAX_MANIFEST_BYTES);
    expect(() => decodeManifest(bytes)).toThrowError(new RegExp(String(MAX_FILES)));
  });
});

describe('encrypted manifest frame', () => {
  it('round-trips through the token key at the reserved manifest nonce', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptManifest(key, entries);
    expect(await decryptManifest(key, frame)).toEqual(entries);
  });

  it('is the first frame a receiver sees, encrypted at file index 0 chunk 0', async () => {
    const key = await importRawKey(await generateRawKey());
    const frame = await encryptManifest(key, entries);
    const plain = new TextDecoder().decode(
      await decryptChunk(
        key,
        frame,
        MANIFEST_FILE_INDEX,
        MANIFEST_CHUNK_INDEX,
        manifestBinding(),
      ),
    );
    expect(JSON.parse(plain).files).toHaveLength(entries.length);
  });

  it('never collides with the first real file, which is file index 1', () => {
    expect(MANIFEST_FILE_INDEX).toBe(0);
    expect(FIRST_FILE_INDEX).toBe(1);
    expect(MANIFEST_CHUNK_INDEX).toBe(0n);
    expect(Array.from(deriveNonce(MANIFEST_FILE_INDEX, MANIFEST_CHUNK_INDEX))).not.toEqual(
      Array.from(deriveNonce(FIRST_FILE_INDEX, 0n)),
    );
  });

  it('puts no filename in the clear on the wire', async () => {
    const key = await importRawKey(await generateRawKey());
    const plain = encodeManifest(entries);
    const frame = new Uint8Array(await encryptManifest(key, entries));
    expect(frame.byteLength).toBe(plain.byteLength + TAG_BYTES);
    expect(Array.from(frame)).not.toEqual(Array.from(plain));
    const text = lenientDecoder.decode(frame);
    for (const entry of entries) {
      expect(text).not.toContain(entry.name);
    }
  });

  it('would catch a manifest that was never encrypted', () => {
    const leaked = lenientDecoder.decode(encodeManifest(entries));
    for (const entry of entries) {
      expect(leaked).toContain(entry.name);
    }
  });

  it('fails under the wrong key', async () => {
    const frame = await encryptManifest(await importRawKey(await generateRawKey()), entries);
    await expect(
      decryptManifest(await importRawKey(await generateRawKey()), frame),
    ).rejects.toThrow();
  });

  it('fails when handed a frame encrypted at a real file index', async () => {
    const key = await importRawKey(await generateRawKey());
    const body = new TextEncoder().encode('{"files":[]}');
    const fileFrame = await encryptChunk(
      key,
      body,
      FIRST_FILE_INDEX,
      0n,
      buildBinding(CHUNK_DOMAIN, FIRST_FILE_INDEX, BigInt(body.byteLength)),
    );
    await expect(decryptManifest(key, fileFrame)).rejects.toThrow();
  });
});

describe('the manifest binding', () => {
  it('seals under the manifest domain, not the file-chunk domain', async () => {
    const key = await importRawKey(await generateRawKey());
    const files = [{ name: 'a.bin', size: 100n }];
    const frame = await encryptManifest(key, files);
    await expect(
      decryptChunk(
        key,
        frame,
        MANIFEST_FILE_INDEX,
        MANIFEST_CHUNK_INDEX,
        buildBinding(CHUNK_DOMAIN, 0, 0n),
      ),
    ).rejects.toThrowError(DecryptionError);
  });

  it('still round-trips through the manifest helpers', async () => {
    const key = await importRawKey(await generateRawKey());
    const files = [
      { name: 'a.bin', size: 100n },
      { name: 'b.bin', size: 200n },
    ];
    await expect(decryptManifest(key, await encryptManifest(key, files))).resolves.toEqual(files);
  });

  it('binds a zero size, not the length the manifest turned out to be', () => {
    const plain = encodeManifest([{ name: 'a.bin', size: 100n }]);
    expect(plain.byteLength).toBeGreaterThan(0);
    expect(sizeField(manifestBinding())).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(new Uint8Array(manifestBinding())).not.toEqual(
      new Uint8Array(
        buildBinding(MANIFEST_DOMAIN, MANIFEST_FILE_INDEX, BigInt(plain.byteLength)),
      ),
    );
  });

  it('takes no size, so a caller cannot hand it a length it does not have yet', () => {
    expect(manifestBinding.length).toBe(0);
  });

  it('will not open a frame sealed under a binding that carries the real manifest length', async () => {
    const key = await importRawKey(await generateRawKey());
    const files = [{ name: 'a.bin', size: 100n }];
    const frame = await encryptManifest(key, files);
    const length = BigInt(encodeManifest(files).byteLength);
    await expect(
      decryptChunk(
        key,
        frame,
        MANIFEST_FILE_INDEX,
        MANIFEST_CHUNK_INDEX,
        buildBinding(MANIFEST_DOMAIN, MANIFEST_FILE_INDEX, length),
      ),
    ).rejects.toThrowError(DecryptionError);
  });
});

describe('manifestFromFiles', () => {
  it('reads the name and size off a picked File', () => {
    const file = new File([new Uint8Array(2048)], 'notes.txt');
    expect(manifestFromFiles([file])).toEqual([{ name: 'notes.txt', size: 2048n }]);
  });

  it('keeps the order the sender picked', () => {
    const files = [new File([], 'b.bin'), new File([], 'a.bin')];
    expect(manifestFromFiles(files).map((entry) => entry.name)).toEqual(['b.bin', 'a.bin']);
  });
});

describe('validateManifest', () => {
  it('accepts a share at the count limit', () => {
    const many = Array.from({ length: MAX_FILES }, (_, i) => ({ name: `f${i}.bin`, size: 1n }));
    expect(() => validateManifest(many)).not.toThrow();
  });

  it('refuses a share over the count limit, naming both the limit and the count', () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      name: `f${i}.bin`,
      size: 1n,
    }));
    expect(() => validateManifest(many)).toThrowError(
      `A share can carry at most ${MAX_FILES} files; this one has ${MAX_FILES + 1}.`,
    );
  });

  it('refuses an empty share', () => {
    expect(() => validateManifest([])).toThrowError(ManifestError);
  });

  it('refuses a name over the byte limit', () => {
    expect(() => validateManifest([{ name: 'a'.repeat(MAX_NAME_BYTES + 1), size: 1n }])).toThrowError(
      ManifestError,
    );
  });

  it('accepts a share at every other limit at once', () => {
    const full = Array.from({ length: MAX_FILES }, () => ({
      name: 'a'.repeat(MAX_NAME_BYTES),
      size: 1n,
    }));
    expect(() => validateManifest(full)).not.toThrow();
  });

  it('rejects exactly what encodeManifest rejects, so a share cannot pass one and fail the other', () => {
    const cases: ManifestEntry[][] = [
      [],
      Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `f${i}.bin`, size: 1n })),
      [{ name: '', size: 1n }],
      [{ name: 'a'.repeat(MAX_NAME_BYTES + 1), size: 1n }],
      [{ name: 'a.bin', size: -1n }],
    ];
    for (const files of cases) {
      expect(() => validateManifest(files)).toThrowError(ManifestError);
      expect(() => encodeManifest(files)).toThrowError(ManifestError);
    }
  });
});
