import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../crypto/chunks';
import {
  isControlMessage,
  MAX_PEER_TEXT,
  parseControl,
  ProtocolError,
  serializeControl,
} from './messages';

const offer = { t: 'offer', chunkSize: CHUNK_SIZE } as const;

describe('control messages', () => {
  it('round-trips an offer', () => {
    expect(parseControl(serializeControl(offer))).toEqual(offer);
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
    ['an offer with a non-integer chunk size', '{"t":"offer","chunkSize":1.5}'],
    ['a zero chunk size', '{"t":"offer","chunkSize":0}'],
    ['a negative chunk size', '{"t":"offer","chunkSize":-1}'],
    ['a non-numeric chunk size', '{"t":"offer","chunkSize":"65536"}'],
    ['an offer missing chunkSize', '{"t":"offer"}'],
    ['an offer carrying the old name', '{"t":"offer","name":"a.bin","size":"1","chunkSize":65536}'],
    ['an offer carrying the old size', '{"t":"offer","size":"1","chunkSize":65536}'],
    ['an offer carrying an extra field', '{"t":"offer","chunkSize":65536,"surprise":1}'],
    ['a done carrying an extra field', '{"t":"done","surprise":1}'],
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

describe('the offer frame', () => {
  it('accepts a frame carrying only the chunk size', () => {
    expect(parseControl('{"t":"offer","chunkSize":65536}')).toEqual({
      t: 'offer',
      chunkSize: 65536,
    });
  });

  it('refuses an offer that still carries a name, so an old sender cannot leak one', () => {
    expect(() =>
      parseControl('{"t":"offer","name":"secret.pdf","size":"10","chunkSize":65536}'),
    ).toThrowError(ProtocolError);
  });

  it('refuses an offer that still carries a size', () => {
    expect(() => parseControl('{"t":"offer","size":"10","chunkSize":65536}')).toThrowError(
      ProtocolError,
    );
  });

  it('names the version mismatch when a stale sender offers, since a name is diagnostic', () => {
    expect(() => parseControl('{"t":"offer","name":"secret.pdf","size":"10","chunkSize":65536}'))
      .toThrowError(
        'This sender is running a different version. If they have had this page open for a while, they should reload it.',
      );
  });

  it('still refuses an offer carrying only an old size, with the unrecognised error', () => {
    expect(() => parseControl('{"t":"offer","size":"10","chunkSize":65536}')).toThrowError(
      'Received an unrecognised control message.',
    );
  });

  it('keeps the guard total: a stale offer is a false, not a throw', () => {
    expect(isControlMessage({ t: 'offer', name: 'secret.pdf', size: '10', chunkSize: 65536 })).toBe(
      false,
    );
  });

  it('still parses a valid offer after the diagnostic moved to parseControl', () => {
    expect(parseControl('{"t":"offer","chunkSize":65536}')).toEqual({
      t: 'offer',
      chunkSize: 65536,
    });
  });

  it('keeps the version message offer-specific: a name elsewhere is not a version', () => {
    expect(() => parseControl('{"t":"select","index":1,"name":"secret.pdf"}')).toThrowError(
      'Received an unrecognised control message.',
    );
  });
});

describe('the cancel frame', () => {
  it('round-trips an index through the wire', () => {
    // A cancel always follows an accepted offer. If the stale-offer check
    // matched on anything but t === 'offer', this would report a version
    // mismatch for a frame that is perfectly current. It carries no name, so
    // the name-gated check cannot reach it; keeping the frame off the
    // disjunction is what fails here, and the test below says the same thing.
    expect(parseControl(serializeControl({ t: 'cancel', index: 3 }))).toEqual({
      t: 'cancel',
      index: 3,
    });
  });

  it('refuses a cancel carrying a name, without calling it a version mismatch', () => {
    expect(() => parseControl('{"t":"cancel","index":3,"name":"secret.pdf"}')).toThrowError(
      'Received an unrecognised control message.',
    );
  });

  it('refuses a cancel with no index', () => {
    expect(() => parseControl('{"t":"cancel"}')).toThrowError(ProtocolError);
  });

  it('refuses index zero, which is the manifest and never a file', () => {
    expect(() => parseControl('{"t":"cancel","index":0}')).toThrowError(ProtocolError);
  });

  it('refuses a fractional index', () => {
    expect(() => parseControl('{"t":"cancel","index":1.5}')).toThrowError(ProtocolError);
  });
});

describe('the cancelled frame', () => {
  // The sender's answer to a cancel, and a different message from it: a sender
  // that got all of a file out before the cancel arrived has already sent its
  // own done, so a receiver that read either frame as the other would be
  // stopping on the wrong boundary.
  it('round-trips an index through the wire', () => {
    // Two frames, one index, opposite meanings: a request to stop and the
    // answer that the last of that file has gone. That they stay apart is
    // pinned behaviourally in session.test.ts -- a terminator from a peer
    // cancels nothing -- rather than here, where parsing either already yields
    // its own tag.
    expect(parseControl(serializeControl({ t: 'cancelled', index: 3 }))).toEqual({
      t: 'cancelled',
      index: 3,
    });
  });

  it('refuses index zero, which is the manifest and never a file', () => {
    expect(() => parseControl('{"t":"cancelled","index":0}')).toThrowError(ProtocolError);
  });

  it('refuses a fractional index', () => {
    expect(() => parseControl('{"t":"cancelled","index":1.5}')).toThrowError(ProtocolError);
  });

  it('refuses a cancelled carrying anything else', () => {
    expect(() => parseControl('{"t":"cancelled","index":3,"name":"a.bin"}')).toThrowError(
      'Received an unrecognised control message.',
    );
  });

  it('refuses a cancelled with no index, which would end a drain the receiver never started', () => {
    expect(() => parseControl('{"t":"cancelled"}')).toThrowError(ProtocolError);
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
