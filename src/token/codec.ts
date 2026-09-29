import { bech32m } from 'bech32';
import { KEY_BYTES } from '../crypto/keys';
import { isValidRoomId, ROOM_ID_LENGTH } from './roomId';

export const HRP = 'p2fs';
export const BECH32_LIMIT = 1000;

export type TokenErrorCode = 'malformed';

export class TokenError extends Error {
  readonly code: TokenErrorCode;

  constructor(code: TokenErrorCode, message: string) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
  }
}

export interface SharePayload {
  roomId: string;
  key: Uint8Array;
}

const MALFORMED =
  "That doesn't look like a valid share link - check for a missing or extra character.";

const MAX_ECHOED_PREFIX_CHARS = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodePayload(p: SharePayload): Uint8Array {
  if (!isValidRoomId(p.roomId)) {
    throw new TokenError('malformed', 'The share link contains an invalid room code.');
  }
  if (p.key.length !== KEY_BYTES) {
    throw new TokenError('malformed', `The share link must carry a ${KEY_BYTES}-byte key.`);
  }

  const buffer = new ArrayBuffer(1 + ROOM_ID_LENGTH + 1 + KEY_BYTES);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, ROOM_ID_LENGTH);
  bytes.set(encoder.encode(p.roomId), 1);
  view.setUint8(1 + ROOM_ID_LENGTH, KEY_BYTES);
  bytes.set(p.key, 2 + ROOM_ID_LENGTH);

  return bytes;
}

function decodePayload(bytes: Uint8Array): SharePayload {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const require = (count: number, label: string): void => {
    if (offset + count > bytes.length) {
      throw new TokenError('malformed', `The share link is incomplete - the ${label} is missing.`);
    }
  };

  require(1, 'room code length');
  const roomIdLength = view.getUint8(offset);
  offset += 1;
  require(roomIdLength, 'room code');
  const roomId = decoder.decode(bytes.subarray(offset, offset + roomIdLength));
  offset += roomIdLength;
  if (!isValidRoomId(roomId)) {
    throw new TokenError('malformed', 'The share link contains an invalid room code.');
  }

  require(1, 'key length');
  const keyLength = view.getUint8(offset);
  offset += 1;
  require(keyLength, 'encryption key');
  if (keyLength !== KEY_BYTES) {
    throw new TokenError('malformed', `The share link must carry a ${KEY_BYTES}-byte key.`);
  }
  const key = bytes.slice(offset, offset + keyLength);
  offset += keyLength;

  if (offset !== bytes.length) {
    throw new TokenError('malformed', 'The share link has unexpected trailing data.');
  }

  return { roomId, key };
}

export function encodeShare(payload: SharePayload): string {
  return bech32m.encode(HRP, bech32m.toWords(encodePayload(payload)), BECH32_LIMIT);
}

export function decodeShare(token: string): SharePayload {
  const trimmed = token.trim();
  const separator = trimmed.lastIndexOf('1');
  if (separator < 1) {
    throw new TokenError('malformed', MALFORMED);
  }
  if (trimmed.slice(0, separator).toLowerCase() !== HRP) {
    const found = trimmed.slice(0, separator);
    const echo =
      found.length > MAX_ECHOED_PREFIX_CHARS
        ? `${found.slice(0, MAX_ECHOED_PREFIX_CHARS)}...`
        : found;
    throw new TokenError('malformed', `This link should start with "${HRP}", not "${echo}".`);
  }
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32m.decode(trimmed, BECH32_LIMIT);
  } catch {
    throw new TokenError('malformed', MALFORMED);
  }
  try {
    return decodePayload(new Uint8Array(bech32m.fromWords(decoded.words)));
  } catch (e) {
    if (e instanceof TokenError) throw e;
    throw new TokenError('malformed', MALFORMED);
  }
}
