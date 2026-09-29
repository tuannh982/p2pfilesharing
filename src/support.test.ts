import { describe, expect, it } from 'vitest';
import { detectSupport, unsupportedReason } from './support';

const ALL_GOOD = { secureContext: true, webRtc: true, fileSystemAccess: true } as const;

describe('unsupportedReason', () => {
  it('says nothing when the environment can do everything', () => {
    expect(unsupportedReason(ALL_GOOD)).toBeNull();
  });

  it('explains that the page is not on HTTPS', () => {
    expect(unsupportedReason({ ...ALL_GOOD, secureContext: false })).toMatch(/https/i);
  });

  it('explains that the browser cannot do peer-to-peer', () => {
    expect(unsupportedReason({ ...ALL_GOOD, webRtc: false })).toMatch(/peer-to-peer/i);
  });

  it('treats a missing File System Access API as a degradation, not a blocker', () => {
    expect(unsupportedReason({ ...ALL_GOOD, fileSystemAccess: false })).toBeNull();
  });
});

describe('detectSupport', () => {
  it('reports booleans rather than throwing in a bare environment', () => {
    const support = detectSupport();
    expect(typeof support.secureContext).toBe('boolean');
    expect(typeof support.webRtc).toBe('boolean');
    expect(typeof support.fileSystemAccess).toBe('boolean');
  });
});
