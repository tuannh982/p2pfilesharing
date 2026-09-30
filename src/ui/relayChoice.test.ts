import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAY } from '../config/iceServers';
import { chooseRelay } from './relayChoice';

describe('chooseRelay', () => {
  it('falls back to the default relay when the token names none', () => {
    expect(chooseRelay(null)).toBe(DEFAULT_RELAY);
  });

  // The case that separates `??` from `||`, and the reason this function
  // exists. Index 0 is Google STUN, so a truthiness check would silently turn
  // it into the default. Nothing downstream can catch that: `resolveRelay(0)`
  // redirects the non-relay index to the default entry anyway, which makes
  // both operators produce a byte-identical ICE config and an identical test
  // result. Here the index is observed before any resolution, so the
  // difference is visible.
  it('keeps index 0, which is falsy, rather than falling back', () => {
    expect(chooseRelay(0)).toBe(0);
  });

  it('keeps a normal relay index as it is', () => {
    expect(chooseRelay(1)).toBe(1);
    expect(chooseRelay(2)).toBe(2);
  });

  it('passes an out-of-range index through, leaving the fallback to the resolver', () => {
    // Not `DEFAULT_RELAY` even though that is where it would end up: whether an
    // index is usable is `resolveRelay`'s decision, not this one's.
    expect(chooseRelay(99)).toBe(99);
    expect(chooseRelay(-1)).toBe(-1);
  });
});
