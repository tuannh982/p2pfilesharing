import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../crypto/chunks';
import {
  isControlMessage,
  MAX_PEER_TEXT,
  parseControl,
  ProtocolError,
  serializeControl,
} from './messages';

const offer = { t: 'offer', name: 'a.bin', size: '10737418240', chunkSize: CHUNK_SIZE } as const;

describe('control messages', () => {
  it('round-trips an offer', () => {
    expect(parseControl(serializeControl(offer))).toEqual(offer);
  });

  it('round-trips a size beyond 2^53, which a JSON number could not carry', () => {
    const huge = { ...offer, size: '9007199254740993' };
    const parsed = parseControl(serializeControl(huge));
    expect(parsed.t).toBe('offer');
    if (parsed.t !== 'offer') throw new Error('expected an offer');
    expect(BigInt(parsed.size)).toBe(9007199254740993n);
    expect(parsed).toEqual(huge);
  });

  it('carries a zero-byte file, which is a legitimate offer', () => {
    const empty = parseControl(serializeControl({ ...offer, size: '0' }));
    expect(empty).toEqual({ ...offer, size: '0' });
  });

  it.each([
    { t: 'accept' } as const,
    { t: 'reject', reason: 'no thanks' } as const,
    { t: 'done' } as const,
    { t: 'error', message: 'boom' } as const,
    { t: 'select', index: 3 } as const,
    { t: 'finish' } as const,
  ])('round-trips $t', (message) => {
    expect(parseControl(serializeControl(message))).toEqual(message);
  });

  it('accepts file index 0, leaving the range check to the session', () => {
    expect(parseControl('{"t":"select","index":0}')).toEqual({ t: 'select', index: 0 });
  });

  it.each([
    ['text that is not JSON', 'nope'],
    ['a JSON array', '[]'],
    ['a JSON number', '42'],
    ['an unknown type tag', '{"t":"launch"}'],
    ['an offer missing size', '{"t":"offer","name":"a","chunkSize":65536}'],
    ['an offer with a numeric size', '{"t":"offer","name":"a","size":1,"chunkSize":65536}'],
    ['an offer with a non-integer chunk size', '{"t":"offer","name":"a","size":"1","chunkSize":1.5}'],
    ['a done carrying an extra field', '{"t":"done","surprise":1}'],
    ['a negative size', '{"t":"offer","name":"a","size":"-1","chunkSize":65536}'],
    ['a fractional size', '{"t":"offer","name":"a","size":"1.5","chunkSize":65536}'],
    ['an exponent-notation size', '{"t":"offer","name":"a","size":"1e3","chunkSize":65536}'],
    ['a zero chunk size', '{"t":"offer","name":"a","size":"1","chunkSize":0}'],
    ['a negative chunk size', '{"t":"offer","name":"a","size":"1","chunkSize":-1}'],
    ['an offer missing chunkSize', '{"t":"offer","name":"a","size":"1"}'],
    ['an offer missing name', '{"t":"offer","size":"1","chunkSize":65536}'],
    ['a reject missing its reason', '{"t":"reject"}'],
    ['an error whose message is not a string', '{"t":"error","message":42}'],
    ['a select with no index', '{"t":"select"}'],
    ['a select with a string index', '{"t":"select","index":"1"}'],
    ['a select with a fractional index', '{"t":"select","index":1.5}'],
    ['a select with a negative index', '{"t":"select","index":-1}'],
    ['a select carrying an extra field', '{"t":"select","index":1,"name":"x"}'],
    ['a finish carrying an extra field', '{"t":"finish","now":true}'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseControl(raw)).toThrowError(ProtocolError);
  });

  it('exposes a guard that rejects non-messages', () => {
    expect(isControlMessage({ t: 'accept' })).toBe(true);
    expect(isControlMessage({ t: 'launch' })).toBe(false);
    expect(isControlMessage(null)).toBe(false);
    expect(isControlMessage('accept')).toBe(false);
  });
});

describe('peer-supplied text', () => {
  it('leaves a legitimate long error alone', () => {
    const reason = 'The receiver could not write the file to disk: the disk is full.';
    expect(reason.length).toBeLessThanOrEqual(MAX_PEER_TEXT);
    const parsed = parseControl(serializeControl({ t: 'error', message: reason }));
    expect(parsed).toEqual({ t: 'error', message: reason });
  });

  it('clamps an error message to the bound, so no peer can put a huge string in the DOM', () => {
    const parsed = parseControl(
      serializeControl({ t: 'error', message: 'x'.repeat(2000000) }),
    );
    expect(parsed.t).toBe('error');
    if (parsed.t !== 'error') throw new Error('expected an error');
    expect(parsed.message).toHaveLength(MAX_PEER_TEXT);
    expect(parsed.message.endsWith('...')).toBe(true);
  });

  it('clamps a reject reason to the bound', () => {
    const parsed = parseControl(serializeControl({ t: 'reject', reason: 'y'.repeat(500) }));
    expect(parsed.t).toBe('reject');
    if (parsed.t !== 'reject') throw new Error('expected a reject');
    expect(parsed.reason).toHaveLength(MAX_PEER_TEXT);
  });

  it('leaves text at exactly the bound untouched', () => {
    const message = 'z'.repeat(MAX_PEER_TEXT);
    const parsed = parseControl(serializeControl({ t: 'error', message }));
    expect(parsed.t).toBe('error');
    if (parsed.t !== 'error') throw new Error('expected an error');
    expect(parsed.message).toBe(message);
  });
});
