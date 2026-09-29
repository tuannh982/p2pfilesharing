export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export type ControlMessage =
  | { t: 'offer'; name: string; size: string; chunkSize: number }
  | { t: 'accept' }
  | { t: 'reject'; reason: string }
  | { t: 'done' }
  | { t: 'select'; index: number }
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

const isOffer = (v: unknown): v is ControlMessage =>
  isRecord(v) &&
  v['t'] === 'offer' &&
  hasExactKeys(v, ['t', 'name', 'size', 'chunkSize']) &&
  typeof v['name'] === 'string' &&
  typeof v['size'] === 'string' &&
  /^\d+$/.test(v['size']) &&
  typeof v['chunkSize'] === 'number' &&
  Number.isInteger(v['chunkSize']) &&
  (v['chunkSize'] as number) > 0;

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
  if (!isControlMessage(parsed)) {
    throw new ProtocolError('Received an unrecognised control message.');
  }
  if (parsed.t === 'error') return { t: 'error', message: clampPeerText(parsed.message) };
  if (parsed.t === 'reject') return { t: 'reject', reason: clampPeerText(parsed.reason) };
  return parsed;
}
