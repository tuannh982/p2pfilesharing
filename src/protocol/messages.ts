export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export type ControlMessage =
  | { t: 'offer'; chunkSize: number }
  | { t: 'accept' }
  | { t: 'reject'; reason: string }
  | { t: 'done' }
  | { t: 'select'; index: number }
  | { t: 'cancel'; index: number }
  | { t: 'cancelled'; index: number }
  | { t: 'finish' }
  | { t: 'error'; message: string };

export const MAX_PEER_TEXT = 200;

const clampPeerText = (text: string): string =>
  text.length > MAX_PEER_TEXT ? `${text.slice(0, MAX_PEER_TEXT - 3)}...` : text;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => key in value);
};

// hasExactKeys, not a check for the keys we want: an offer that still carries
// a name or a size must be refused outright, because those fields would have
// gone out over the wire whatever this app did with them afterwards.
const isOffer = (v: unknown): v is ControlMessage =>
  isRecord(v) &&
  v['t'] === 'offer' &&
  hasExactKeys(v, ['t', 'chunkSize']) &&
  typeof v['chunkSize'] === 'number' &&
  Number.isInteger(v['chunkSize']) &&
  (v['chunkSize'] as number) > 0;

// A name in an offer is diagnostic on its own: no other peer would put one
// there, so it means a sender on the old wire format. The check lives in
// parseControl rather than in isOffer because isControlMessage is exported and
// a type guard should answer with a boolean; the refusal itself is unchanged
// either way, since isOffer's hasExactKeys rejects the frame regardless.
const isStaleOffer = (v: unknown): boolean =>
  isRecord(v) && v['t'] === 'offer' && Object.hasOwn(v, 'name');

const isAccept = (v: unknown): v is ControlMessage =>
  isRecord(v) && v['t'] === 'accept' && hasExactKeys(v, ['t']);

const isReject = (v: unknown): v is ControlMessage =>
  isRecord(v) && v['t'] === 'reject' && hasExactKeys(v, ['t', 'reason']) && typeof v['reason'] === 'string';

const isDone = (v: unknown): v is ControlMessage =>
  isRecord(v) && v['t'] === 'done' && hasExactKeys(v, ['t']);

const isSelect = (v: unknown): v is ControlMessage =>
  isRecord(v) &&
  v['t'] === 'select' &&
  hasExactKeys(v, ['t', 'index']) &&
  typeof v['index'] === 'number' &&
  Number.isInteger(v['index']) &&
  (v['index'] as number) >= 0;

// 1, not 0, unlike select: zero is the manifest's slot, so no file is there to cancel.
const isCancel = (v: unknown): v is ControlMessage =>
  isRecord(v) &&
  v['t'] === 'cancel' &&
  hasExactKeys(v, ['t', 'index']) &&
  typeof v['index'] === 'number' &&
  Number.isInteger(v['index']) &&
  (v['index'] as number) >= 1;

// The sender's answer to a cancel: everything it had already put on the wire
// for this file has now been sent. Its own tag rather than a reused one, because
// both frames that could otherwise mark that boundary are ambiguous -- a sender
// that finished file N just before the cancel arrived has already sent its done,
// and the control frame after the leftovers is the next file's offer, which is a
// frame to begin with rather than to end on.
const isCancelled = (v: unknown): v is ControlMessage =>
  isRecord(v) &&
  v['t'] === 'cancelled' &&
  hasExactKeys(v, ['t', 'index']) &&
  typeof v['index'] === 'number' &&
  Number.isInteger(v['index']) &&
  (v['index'] as number) >= 1;

const isFinish = (v: unknown): v is ControlMessage =>
  isRecord(v) && v['t'] === 'finish' && hasExactKeys(v, ['t']);

const isError = (v: unknown): v is ControlMessage =>
  isRecord(v) &&
  v['t'] === 'error' &&
  hasExactKeys(v, ['t', 'message']) &&
  typeof v['message'] === 'string';

export function isControlMessage(value: unknown): value is ControlMessage {
  return (
    isOffer(value) ||
    isAccept(value) ||
    isReject(value) ||
    isDone(value) ||
    isSelect(value) ||
    isCancel(value) ||
    isCancelled(value) ||
    isFinish(value) ||
    isError(value)
  );
}

export function serializeControl(message: ControlMessage): string {
  return JSON.stringify(message);
}

export function parseControl(raw: string): ControlMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError('Received a malformed control message.');
  }
  if (isStaleOffer(parsed)) {
    throw new ProtocolError(
      'This sender is running a different version. If they have had this page open for a while, they should reload it.',
    );
  }
  if (!isControlMessage(parsed)) {
    throw new ProtocolError('Received an unrecognised control message.');
  }
  if (parsed.t === 'error') return { t: 'error', message: clampPeerText(parsed.message) };
  if (parsed.t === 'reject') return { t: 'reject', reason: clampPeerText(parsed.reason) };
  return parsed;
}
