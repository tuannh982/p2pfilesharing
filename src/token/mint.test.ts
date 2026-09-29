import { describe, expect, it } from 'vitest';
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
});
