import { describe, expect, it } from 'vitest';
import { generateRawKey, importRawKey, KEY_BYTES } from './keys';

const PLAINTEXT = 'the quick brown fox jumps over the lazy dog';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('generateRawKey', () => {
  it('returns a 32-byte raw key', async () => {
    expect((await generateRawKey()).length).toBe(KEY_BYTES);
  });

  it('never repeats across draws', async () => {
    const keys = await Promise.all(Array.from({ length: 10 }, () => generateRawKey()));
    expect(new Set(keys.map(hex)).size).toBe(keys.length);
  });
});

describe('importRawKey', () => {
  it('produces a usable AES-GCM key that round-trips a known plaintext', async () => {
    const raw = await generateRawKey();
    const key = await importRawKey(raw);

    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.usages).toEqual(['encrypt', 'decrypt']);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(PLAINTEXT)),
    );

    expect(hex(ciphertext)).not.toBe(hex(new TextEncoder().encode(PLAINTEXT)));

    const recovered = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    );
    expect(new TextDecoder().decode(recovered)).toBe(PLAINTEXT);
  });

  it('imports the bytes generateRawKey produced into a matching AES-GCM key', async () => {
    const sender = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      sender,
      new TextEncoder().encode(PLAINTEXT),
    );

    const imported = await importRawKey(new Uint8Array(await crypto.subtle.exportKey('raw', sender)));
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, imported, sealed);

    expect(new TextDecoder().decode(opened)).toBe(PLAINTEXT);
  });
});
