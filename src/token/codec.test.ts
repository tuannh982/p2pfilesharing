import { bech32m } from 'bech32';
import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, HRP, TokenError } from './codec';
import { mintSharePayload } from './mint';

const sample = () => mintSharePayload();

const payloadBytes = (token: string): Uint8Array => {
  const { words } = bech32m.decode(token, 1000);
  return new Uint8Array(bech32m.fromWords(words));
};

const forgeToken = (bytes: Uint8Array): string =>
  bech32m.encode(HRP, bech32m.toWords(bytes), 1000);

const roomPrefix = (roomId: string): Uint8Array => {
  const bytes = new Uint8Array(1 + roomId.length);
  bytes[0] = roomId.length;
  bytes.set(new TextEncoder().encode(roomId), 1);
  return bytes;
};

const messageOf = (token: string): string => {
  try {
    decodeShare(token);
  } catch (e) {
    return (e as TokenError).message;
  }
  throw new Error('decodeShare should have thrown');
};

describe('encodeShare and decodeShare', () => {
  it('round-trips the room id and the key', async () => {
    const original = await sample();
    const decoded = decodeShare(encodeShare(original));
    expect(decoded.roomId).toBe(original.roomId);
    expect(decoded.key).toEqual(original.key);
  });

  it('encodes to 98 characters, so a share link stays well under 200', async () => {
    const token = encodeShare(await sample());
    expect(token.startsWith(`${HRP}1`)).toBe(true);
    expect(token.length).toBe(98);
    expect(token.length).toBeLessThan(200);
  });

  it('lays the payload out as a room length, a room, a key length, and a key', async () => {
    const payload = await sample();
    const bytes = payloadBytes(encodeShare(payload));
    expect(bytes.byteLength).toBe(54);
    expect(bytes[0]).toBe(20);
    expect(new TextDecoder().decode(bytes.subarray(1, 21))).toBe(payload.roomId);
    expect(bytes[21]).toBe(32);
    expect(bytes.subarray(22)).toEqual(payload.key);
  });

  it('tolerates whitespace from a paste', async () => {
    const original = await sample();
    const decoded = decodeShare(`  ${encodeShare(original)}\n`);
    expect(decoded.roomId).toBe(original.roomId);
  });

  it('rejects a single corrupted character as a malformed link', async () => {
    const token = encodeShare(await sample());
    const last = token[token.length - 1] as string;
    const corrupted = token.slice(0, -1) + (last === 'q' ? 'p' : 'q');
    expect(() => decodeShare(corrupted)).toThrowError(TokenError);
    try {
      decodeShare(corrupted);
    } catch (e) {
      expect((e as TokenError).code).toBe('malformed');
      expect((e as TokenError).message).toMatch(/valid share link/i);
    }
  });

  it('rejects a truncated token', async () => {
    const token = encodeShare(await sample());
    expect(() => decodeShare(token.slice(0, token.length - 20))).toThrowError(TokenError);
  });

  it('rejects a link with the wrong human-readable prefix', async () => {
    const token = encodeShare(await sample());
    expect(() => decodeShare(`bcrt${token.slice(4)}`)).toThrowError(/should start with "p2fs"/);
  });

  it('clamps the echoed prefix so a huge paste cannot inflate the error message', async () => {
    try {
      decodeShare(`${'a'.repeat(5000)}1`);
      throw new Error('decodeShare should have thrown');
    } catch (e) {
      expect((e as TokenError).code).toBe('malformed');
      expect((e as TokenError).message.length).toBeLessThan(120);
      expect((e as TokenError).message).toMatch(/\.\.\."\.$/);
    }
  });

  it('falls back to the generic message when the paste has no separator', async () => {
    try {
      decodeShare('not-a-share-link');
      throw new Error('decodeShare should have thrown');
    } catch (e) {
      expect((e as TokenError).code).toBe('malformed');
      expect((e as TokenError).message).toMatch(/valid share link/i);
      expect((e as TokenError).message).not.toMatch(/should start with/);
    }
  });

  it('rejects trailing name and size bytes, so a manifest cannot hide in a token', async () => {
    const original = await sample();
    const encoder = new TextEncoder();
    const name = encoder.encode('secret.txt');
    const payload = new Uint8Array(22 + 32 + name.length + 8);
    payload[0] = 20;
    payload.set(encoder.encode(original.roomId), 1);
    payload[21] = 32;
    payload.set(original.key, 22);
    payload.set(name, 54);
    const forged = bech32m.encode('p2fs', bech32m.toWords(payload), 1000);

    expect(() => decodeShare(forged)).toThrowError(TokenError);
    try {
      decodeShare(forged);
    } catch (e) {
      expect((e as TokenError).message).toMatch(/unexpected trailing data/i);
    }
  });

  it('refuses to encode a key that is not 32 bytes', async () => {
    const payload = await sample();
    expect(() => encodeShare({ ...payload, key: new Uint8Array(16) })).toThrowError(TokenError);
  });

  it('refuses to encode a malformed room id', async () => {
    const payload = await sample();
    expect(() => encodeShare({ ...payload, roomId: 'short' })).toThrowError(TokenError);
    expect(() => encodeShare({ ...payload, roomId: 'a'.repeat(21) })).toThrowError(TokenError);
  });

  it('rejects a checksum-valid token that carries no room code length byte', () => {
    const forged = forgeToken(new Uint8Array(0));
    expect(() => decodeShare(forged)).toThrowError(TokenError);
    expect(messageOf(forged)).toMatch(/incomplete/i);
    expect(messageOf(forged)).toMatch(/room code length/i);
  });

  it('rejects a checksum-valid token that declares a room code it does not carry', async () => {
    const { roomId } = await sample();
    const forged = forgeToken(new Uint8Array([roomId.length]));
    expect(() => decodeShare(forged)).toThrowError(TokenError);
    expect(messageOf(forged)).toMatch(/incomplete/i);
    expect(messageOf(forged)).toMatch(/room code/i);
    expect(messageOf(forged)).not.toMatch(/invalid room code/i);
  });

  it('rejects a checksum-valid token that carries no key length byte', async () => {
    const { roomId } = await sample();
    const forged = forgeToken(roomPrefix(roomId));
    expect(() => decodeShare(forged)).toThrowError(TokenError);
    expect(messageOf(forged)).toMatch(/incomplete/i);
    expect(messageOf(forged)).toMatch(/key length/i);
  });

  it('rejects a checksum-valid token that declares a key it does not carry', async () => {
    const { roomId } = await sample();
    const prefix = roomPrefix(roomId);
    const payload = new Uint8Array(prefix.length + 1);
    payload.set(prefix);
    payload[prefix.length] = 32;
    const forged = forgeToken(payload);
    expect(() => decodeShare(forged)).toThrowError(TokenError);
    expect(messageOf(forged)).toMatch(/incomplete/i);
    expect(messageOf(forged)).toMatch(/key/i);
    expect(messageOf(forged)).not.toMatch(/trailing data/i);
  });

  it('rejects a checksum-valid token that decodes to an invalid room code', async () => {
    const { key } = await sample();
    const roomId = '!'.repeat(20);
    const prefix = roomPrefix(roomId);
    const payload = new Uint8Array(54);
    payload.set(prefix);
    payload[21] = 32;
    payload.set(key, 22);
    const forged = forgeToken(payload);
    expect(payload.byteLength).toBe(54);
    expect(() => decodeShare(forged)).toThrowError(TokenError);
    expect(messageOf(forged)).toMatch(/invalid room code/i);
  });

  it('rejects a checksum-valid token that declares a key shorter than 32 bytes', async () => {
    const { roomId, key } = await sample();
    const prefix = roomPrefix(roomId);
    const payload = new Uint8Array(prefix.length + 1 + 16);
    payload.set(prefix);
    payload[prefix.length] = 16;
    payload.set(key.subarray(0, 16), prefix.length + 1);
    const forged = forgeToken(payload);
    expect(() => decodeShare(forged)).toThrowError(TokenError);
    expect(messageOf(forged)).toMatch(/32-byte key/i);
    expect(messageOf(forged)).not.toMatch(/trailing data/i);
  });

  it('surfaces a checksum-valid short payload as a TokenError, never a RangeError', async () => {
    const { roomId } = await sample();
    const short = [new Uint8Array(0), new Uint8Array([20]), roomPrefix(roomId)];
    for (const bytes of short) {
      const forged = forgeToken(bytes);
      let thrown: unknown;
      try {
        decodeShare(forged);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(TokenError);
      expect(thrown).not.toBeInstanceOf(RangeError);
      expect((thrown as TokenError).code).toBe('malformed');
    }
  });
});
