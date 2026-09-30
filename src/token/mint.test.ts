import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAY, isKnownIndex } from '../config/iceServers';
import { decodeShare, encodeShare } from './codec';
import { mintSharePayload } from './mint';
import { ROOM_ID_PATTERN } from './roomId';

describe('mintSharePayload', () => {
  it('produces a payload with a 32-byte key and a valid room id', async () => {
    const payload = await mintSharePayload();
    expect(payload.key).toHaveLength(32);
    expect(payload.roomId).toMatch(ROOM_ID_PATTERN);
  });

  it('produces a fresh key and room id for every share', async () => {
    const a = await mintSharePayload();
    const b = await mintSharePayload();
    expect(a.key).not.toEqual(b.key);
    expect(a.roomId).not.toBe(b.roomId);
  });

  it('names the default relay when the caller names none', async () => {
    expect((await mintSharePayload()).relay).toBe(DEFAULT_RELAY);
    expect(isKnownIndex(DEFAULT_RELAY)).toBe(true);
  });

  it('names the relay the sender picked, and the receiver reads it back', async () => {
    const payload = await mintSharePayload(2);
    expect(payload.relay).toBe(2);
    const decoded = decodeShare(encodeShare(payload));
    expect(decoded.relay).toBe(2);
    expect(decoded.roomId).toBe(payload.roomId);
    expect(decoded.key).toEqual(payload.key);
  });
});
