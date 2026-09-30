import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENABLED,
  DEFAULT_RELAY,
  ICE_SERVERS,
  isKnownIndex,
  resolveEnabled,
  resolveRelay,
} from './iceServers';

const urlsOf = (server: RTCIceServer): string[] =>
  Array.isArray(server.urls) ? server.urls : [server.urls as string];

const firstIndexThatCannotRelay = (): number => ICE_SERVERS.findIndex((entry) => !entry.relay);

describe('ICE_SERVERS', () => {
  it('gives every entry at least one URL', () => {
    for (const entry of ICE_SERVERS) {
      expect(urlsOf(entry.server).length, `${entry.name} has URLs`).toBeGreaterThan(0);
    }
  });

  it('gives every relay entry the credentials a TURN server requires', () => {
    for (const entry of ICE_SERVERS.filter((candidate) => candidate.relay)) {
      expect(entry.server.username, `${entry.name} has a username`).toBeTruthy();
      expect(entry.server.credential, `${entry.name} has a credential`).toBeTruthy();
    }
  });

  it('marks exactly which entries can relay and which only discover an address', () => {
    for (const entry of ICE_SERVERS.filter((candidate) => !candidate.relay)) {
      for (const url of urlsOf(entry.server)) {
        expect(url.startsWith('stun:'), `${entry.name} is STUN only`).toBe(true);
      }
    }
    for (const entry of ICE_SERVERS.filter((candidate) => candidate.relay)) {
      expect(urlsOf(entry.server).some((url) => url.startsWith('turn'))).toBe(true);
    }
  });

  it('has no duplicate names, so a picker can label entries unambiguously', () => {
    const names = ICE_SERVERS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps every already-shared index pointing at the entry it has always named', () => {
    // A share token encodes a relay as its index in this table, so index 1 has
    // meant 'PeerJS EU' in every build that ever shared one. Every other test in
    // this file passes with the entries reordered, which would repoint every
    // link already shared. Appending is safe and needs no edit here, so only
    // the published prefix is pinned; toEqual also fails if one is removed.
    expect(ICE_SERVERS.slice(0, 3).map((entry) => entry.name)).toEqual([
      'Google STUN',
      'PeerJS EU',
      'PeerJS US',
    ]);
  });

  it('offers a Google STUN address, and only ever as STUN', () => {
    const google = ICE_SERVERS.filter((entry) => entry.name.startsWith('Google'));
    expect(google.length).toBeGreaterThan(0);
    for (const entry of google) {
      expect(entry.relay, 'Google publishes no TURN server').toBe(false);
      expect(urlsOf(entry.server).some((url) => url.includes('.l.google.com'))).toBe(true);
    }
  });

  it('offers no relay on a port other than 3478, so nothing looks reachable that is not', () => {
    for (const entry of ICE_SERVERS.filter((candidate) => candidate.relay)) {
      for (const url of urlsOf(entry.server)) {
        expect(url, `${url} is a relay this app can actually use`).toContain(':3478');
      }
    }
  });
});

describe('resolving a selection', () => {
  it('defaults to exactly the servers the app uses today', () => {
    const selected = resolveEnabled(DEFAULT_ENABLED)
      .concat(resolveRelay(DEFAULT_RELAY))
      .flatMap(urlsOf);
    expect(selected.some((url) => url === 'stun:stun.l.google.com:19302')).toBe(true);
    expect(selected.some((url) => url === 'stun:stun1.l.google.com:19302')).toBe(true);
    expect(selected.some((url) => url === 'turn:eu-0.turn.peerjs.com:3478')).toBe(true);
    expect(selected.some((url) => url === 'turn:us-0.turn.peerjs.com:3478')).toBe(true);
  });

  it('defaults the relay to PeerJS EU, which is what the app uses today', () => {
    expect(urlsOf(resolveRelay(DEFAULT_RELAY))).toContain('turn:eu-0.turn.peerjs.com:3478');
  });

  it('points the default relay at a named entry, so a moved default is visible', () => {
    expect(ICE_SERVERS[DEFAULT_RELAY]?.name).toBe('PeerJS EU');
  });

  it('points the default relay at a real relay entry', () => {
    expect(ICE_SERVERS[DEFAULT_RELAY]?.relay).toBe(true);
  });

  it('returns nothing for an empty or unknown selection, rather than a broken config', () => {
    expect(resolveEnabled([])).toEqual([]);
    expect(resolveEnabled([9999, -1])).toEqual([]);
  });

  it('falls back to the default relay when the index is not in this build', () => {
    expect(resolveRelay(9999)).toEqual(resolveRelay(DEFAULT_RELAY));
    expect(resolveRelay(-1)).toEqual(resolveRelay(DEFAULT_RELAY));
  });

  it('falls back to the default relay when the index names a server that cannot relay', () => {
    const stunIndex = firstIndexThatCannotRelay();
    expect(stunIndex, 'the table has a STUN-only entry to mis-point at').toBeGreaterThanOrEqual(0);
    expect(resolveRelay(stunIndex)).toEqual(resolveRelay(DEFAULT_RELAY));
  });

  it('reports which indices this build understands', () => {
    expect(isKnownIndex(0)).toBe(true);
    expect(isKnownIndex(ICE_SERVERS.length - 1)).toBe(true);
    expect(isKnownIndex(ICE_SERVERS.length)).toBe(false);
    expect(isKnownIndex(-1)).toBe(false);
    expect(isKnownIndex(1.5)).toBe(false);
  });
});
