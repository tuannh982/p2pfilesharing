export const ROOM_ID_LENGTH = 20;
export const ROOM_ID_PATTERN = /^[A-Za-z0-9]{20}$/;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const REJECTION_LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

export function generateRoomId(): string {
  const chars: string[] = [];
  while (chars.length < ROOM_ID_LENGTH) {
    const random = new Uint8Array(ROOM_ID_LENGTH);
    crypto.getRandomValues(random);
    for (const byte of random) {
      if (chars.length === ROOM_ID_LENGTH) break;
      if (byte >= REJECTION_LIMIT) continue;
      chars.push(ALPHABET[byte % ALPHABET.length] as string);
    }
  }
  return chars.join('');
}

export function isValidRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}
