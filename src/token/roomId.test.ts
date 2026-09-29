import { describe, expect, it } from 'vitest';
import { generateRoomId, isValidRoomId, ROOM_ID_LENGTH, ROOM_ID_PATTERN } from './roomId';

describe('generateRoomId', () => {
  it('returns 20 alphanumeric characters, the only form PeerJS accepts as an id', () => {
    const id = generateRoomId();
    expect(id).toHaveLength(ROOM_ID_LENGTH);
    expect(id).toMatch(ROOM_ID_PATTERN);
  });

  it('never repeats across many draws', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateRoomId()));
    expect(ids.size).toBe(500);
  });
});

describe('isValidRoomId', () => {
  it('rejects anything PeerJS would refuse', () => {
    expect(isValidRoomId('a'.repeat(20))).toBe(true);
    expect(isValidRoomId('short')).toBe(false);
    expect(isValidRoomId('a'.repeat(19))).toBe(false);
    expect(isValidRoomId(`${'a'.repeat(19)}-`)).toBe(false);
    expect(isValidRoomId(`${'a'.repeat(19)}/`)).toBe(false);
  });
});
