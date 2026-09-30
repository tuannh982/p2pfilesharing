import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICE_SERVERS } from './iceServers';
import { NETWORK, discoveryServers, parsePort, turnOverride } from './network';

const urls = (server: RTCIceServer): string[] =>
  Array.isArray(server.urls) ? server.urls : [server.urls];

// The relays in a list, one array element per entry. Credential assertions read
// every element rather than the first: a config is ordered by the table, so a
// single-element read pins one relay and leaves the rest free to drift.
const relayServers = (servers: readonly RTCIceServer[]): RTCIceServer[] =>
  servers.filter((s) => urls(s).some((u) => u.startsWith('turn:')));

// The credentials PeerJS publishes, which are the pair this app has shipped
// since its first commit and therefore the pair every relay in the table has to
// carry. Spelled out here as well as in `iceServers.ts` on purpose: a relay
// with a different credential is bundled into the client and readable by anyone,
// so a drift would ship a relay no peer can authenticate against. This is
// asserted against the table because that is what the browser is offered - the
// entries are handed out by identity, and `iceConfigFor` only ever appends a
// table entry to a selection.
const PEERJS_CREDENTIALS = { username: 'peerjs', credential: 'peerjsp' } as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('parsePort', () => {
  it('accepts a valid port', () => {
    expect(parsePort('9000')).toBe(9000);
  });

  it('falls back to 443 for missing or nonsensical input instead of yielding NaN', () => {
    expect(parsePort(undefined)).toBe(443);
    expect(parsePort('abc')).toBe(443);
    expect(parsePort('0')).toBe(443);
    expect(parsePort('70000')).toBe(443);
    expect(parsePort('80.5')).toBe(443);
  });
});

describe('NETWORK', () => {
  // The broker is the only thing here, and it is read: `PeerSession.open` hands
  // these four values to `new Peer` on every session it opens.
  it('targets the PeerJS cloud broker by default', () => {
    expect(NETWORK.broker).toEqual({ host: '0.peerjs.com', port: 443, path: '/', secure: true });
  });

  it('honours a broker override', async () => {
    vi.stubEnv('VITE_BROKER_HOST', 'localhost');
    vi.stubEnv('VITE_BROKER_PORT', '9000');
    vi.resetModules();
    const { NETWORK: overridden } = await import('./network');
    expect(overridden.broker).toEqual({ host: 'localhost', port: 9000, path: '/', secure: true });
  });

  it('ignores a nonsensical broker port', async () => {
    vi.stubEnv('VITE_BROKER_PORT', 'abc');
    vi.resetModules();
    const { NETWORK: overridden } = await import('./network');
    expect(overridden.broker.port).toBe(443);
  });

  it('drops to a plain-HTTP broker when the secure override is the string false', async () => {
    vi.stubEnv('VITE_BROKER_HOST', 'localhost');
    vi.stubEnv('VITE_BROKER_PORT', '9000');
    vi.stubEnv('VITE_BROKER_SECURE', 'false');
    vi.resetModules();
    const { NETWORK: overridden } = await import('./network');
    expect(overridden.broker).toEqual({ host: 'localhost', port: 9000, path: '/', secure: false });
  });

  it('keeps wss for any secure override other than the exact string false', async () => {
    vi.stubEnv('VITE_BROKER_SECURE', 'true');
    vi.resetModules();
    const { NETWORK: overridden } = await import('./network');
    expect(overridden.broker.secure).toBe(true);
    vi.stubEnv('VITE_BROKER_SECURE', '0');
    vi.resetModules();
    const { NETWORK: again } = await import('./network');
    expect(again.broker.secure).toBe(true);
  });
});

describe('turnOverride', () => {
  it('is absent with no VITE_TURN_* set at all, so the table is used', () => {
    expect(turnOverride()).toBeNull();
  });

  it('ignores a URL with no credentials, rather than emitting a relay browsers will reject', () => {
    // A TURN entry without a username and credential is not a usable TURN
    // server: the browser throws InvalidAccessError constructing the
    // RTCPeerConnection, which lands on the screen as a raw message naming none
    // of the variables the operator half-set. Returning null instead means
    // `PeerSession.open` takes its ordinary branch and the table's public
    // relays, resilience and all.
    vi.stubEnv('VITE_TURN_URL', 'turn:turn.example.com:3478');
    expect(turnOverride()).toBeNull();
  });

  it('ignores credentials with no URL, and keeps them off everything it hands out', () => {
    // `urls` is a required member of RTCIceServer, so the credentials on their
    // own are not a server at all. The leak this rule exists to prevent is the
    // operator's credential reaching a config, so the assertion is on the only
    // list this module still hands out.
    vi.stubEnv('VITE_TURN_USERNAME', 'user');
    vi.stubEnv('VITE_TURN_CREDENTIAL', 'secret');
    expect(turnOverride()).toBeNull();
    const offered = discoveryServers();
    expect(offered.map((s) => s.username)).not.toContain('user');
    expect(offered.map((s) => s.credential)).not.toContain('secret');
  });

  it('honours all three together', () => {
    vi.stubEnv('VITE_TURN_URL', 'turn:turn.example.com:3478');
    vi.stubEnv('VITE_TURN_USERNAME', 'user');
    vi.stubEnv('VITE_TURN_CREDENTIAL', 'secret');
    expect(turnOverride()).toEqual({
      urls: ['turn:turn.example.com:3478'],
      username: 'user',
      credential: 'secret',
    });
  });
});

describe('discoveryServers', () => {
  // This is the discovery half `PeerSession.open` composes a relay override
  // with (`src/transport/peerjs.ts`), and it is the only ICE list this module
  // exports. The composition itself - that the override replaces the table's
  // relays and the STUN half stays - is asserted where it is built, in
  // `src/transport/peerjs.test.ts`.
  it('offers no relay, because a relay cannot discover an address on its own', () => {
    expect(relayServers(discoveryServers())).toEqual([]);
  });

  it('hands out the table entries by identity, not copies of them', () => {
    // Exported for a caller composing its own override, which means the returned
    // entries escape this module. They are the live objects, and iceServers.ts
    // asks in three lines that they be treated as read-only; this asserts the
    // identity that makes that contract necessary, and the identity the
    // duplicate check in `iceConfigFor` relies on.
    for (const server of discoveryServers()) {
      expect(ICE_SERVERS.some((entry) => entry.server === server), 'a table entry').toBe(true);
    }
  });
});

describe('the relays in the table', () => {
  it('gives every relay the exact credentials a strict firewall needs', () => {
    const relays = relayServers(ICE_SERVERS.map((entry) => entry.server));
    expect(relays.length, 'the table offers a relay to check').toBeGreaterThan(0);
    for (const relay of relays) {
      expect(relay.username, 'relay username').toBe(PEERJS_CREDENTIALS.username);
      expect(relay.credential, 'relay credential').toBe(PEERJS_CREDENTIALS.credential);
    }
  });
});
