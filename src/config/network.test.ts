import { afterEach, describe, expect, it, vi } from 'vitest';
import { NETWORK, parsePort } from './network';

const urls = (server: RTCIceServer): string[] =>
  Array.isArray(server.urls) ? server.urls : [server.urls];

const turnServer = (): RTCIceServer => {
  const found = NETWORK.iceServers.find((s) => urls(s).some((u) => u.startsWith('turn:')));
  expect(found).toBeDefined();
  return found as RTCIceServer;
};

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
  it('targets the PeerJS cloud broker by default', () => {
    expect(NETWORK.broker).toEqual({ host: '0.peerjs.com', port: 443, path: '/', secure: true });
  });

  it('includes a STUN server so a direct peer route is attempted', () => {
    const all = NETWORK.iceServers.flatMap(urls);
    expect(all.some((u) => u.startsWith('stun:'))).toBe(true);
  });

  it('includes a TURN relay with credentials so strict firewalls still connect', () => {
    expect(turnServer().username).toBe('peerjs');
    expect(turnServer().credential).toBe('peerjsp');
  });

  it('lists more than one TURN relay so one outage is not fatal', () => {
    expect(urls(turnServer()).length).toBeGreaterThan(1);
  });

  it('ignores a partial TURN override rather than emitting a relay browsers will reject', async () => {
    vi.stubEnv('VITE_TURN_URL', 'turn:turn.example.com:3478');
    vi.resetModules();
    const { NETWORK: overridden } = await import('./network');
    const turn = overridden.iceServers.find((s) =>
      urls(s).some((u) => u.startsWith('turn:')),
    ) as RTCIceServer;
    expect(urls(turn).length).toBeGreaterThan(1);
    expect(turn.credential).toBe('peerjsp');
  });

  it('honours a complete TURN override', async () => {
    vi.stubEnv('VITE_TURN_URL', 'turn:turn.example.com:3478');
    vi.stubEnv('VITE_TURN_USERNAME', 'user');
    vi.stubEnv('VITE_TURN_CREDENTIAL', 'secret');
    vi.resetModules();
    const { NETWORK: overridden } = await import('./network');
    const turn = overridden.iceServers.find((s) =>
      urls(s).some((u) => u.startsWith('turn:')),
    ) as RTCIceServer;
    expect(urls(turn)).toEqual(['turn:turn.example.com:3478']);
    expect(turn.username).toBe('user');
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
