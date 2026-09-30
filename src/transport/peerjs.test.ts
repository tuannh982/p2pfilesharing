import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionFailedError, describePeerError, errorCloseReason, iceConfigFor, isSessionFatal, PeerChannel, PeerSession } from './peerjs';
import type { CloseReason } from './channel';
import {
  DEFAULT_ENABLED,
  DEFAULT_RELAY,
  ICE_SERVERS,
  resolveEnabled,
  resolveRelay,
} from '../config/iceServers';
import { discoveryServers, NETWORK } from '../config/network';
import type { SharePayload } from '../token/codec';

type Listener = (...args: unknown[]) => void;
type Entry = { fn: Listener; handler: Listener };

const fakes = vi.hoisted(() => {
  class FakeEmitter {
    private readonly listeners = new Map<string, Entry[]>();

    on(event: string, handler: Listener): this {
      const existing = this.listeners.get(event);
      if (existing === undefined) this.listeners.set(event, [{ fn: handler, handler }]);
      else existing.push({ fn: handler, handler });
      return this;
    }

    once(event: string, handler: Listener): this {
      const entry: Entry = {
        fn: handler,
        handler: (...args: unknown[]): void => {
          this.drop(event, entry);
          handler(...args);
        },
      };
      const existing = this.listeners.get(event);
      if (existing === undefined) this.listeners.set(event, [entry]);
      else existing.push(entry);
      return this;
    }

    removeListener(event: string, handler: Listener): this {
      return this.drop(event, { fn: handler, handler });
    }

    listenerCount(event: string): number {
      return (this.listeners.get(event) ?? []).length;
    }

    fire(event: string, ...args: unknown[]): void {
      for (const entry of [...(this.listeners.get(event) ?? [])]) entry.handler(...args);
    }

    private drop(event: string, match: Entry): this {
      const existing = this.listeners.get(event);
      if (existing === undefined) return this;
      const index = existing.findIndex(
        (entry) => entry.fn === match.fn || entry.handler === match.handler,
      );
      if (index >= 0) existing.splice(index, 1);
      return this;
    }
  }

  class FakeDataConnection extends FakeEmitter {
    sent: unknown[] = [];
    notOpenYet = 0;
    closed = false;
    isOpen = false;
    dataChannel: { bufferedAmount: number } | null = { bufferedAmount: 0 };

    get open(): boolean {
      return this.isOpen;
    }

    send(msg: unknown): void {
      if (!this.isOpen) {
        this.notOpenYet += 1;
        this.fire('error', { type: 'not-open-yet' });
        return;
      }
      this.sent.push(msg);
    }

    close(): void {
      this.closed = true;
      this.isOpen = false;
      this.dataChannel = null;
    }

    override fire(event: string, ...args: unknown[]): void {
      if (event === 'open') this.isOpen = true;
      super.fire(event, ...args);
    }
  }

  const peers: FakePeer[] = [];

  class FakePeer extends FakeEmitter {
    destroyed = false;
    readonly options: unknown[] = [];
    connectOptions: unknown[] = [];
    readonly conns: FakeDataConnection[] = [];

    // PeerJS is constructed either as `new Peer(options)` or as
    // `new Peer(id, options)`, so the options are the second argument whenever
    // there is one - recording only the first would capture a room id.
    constructor(idOrOptions: unknown, maybeOptions?: unknown) {
      super();
      this.options.push(maybeOptions ?? idOrOptions);
      peers.push(this);
    }

    connect(_peerId: string, options?: unknown): FakeDataConnection {
      this.connectOptions.push(options);
      const conn = new FakeDataConnection();
      this.conns.push(conn);
      return conn;
    }

    destroy(): void {
      this.destroyed = true;
    }
  }

  return { FakeDataConnection, FakePeer, peers };
});

vi.mock('peerjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('peerjs')>();
  return { ...actual, default: fakes.FakePeer };
});

// `turnOverride` reads the env at call time, so the only way to exercise the
// override branch of the ICE config is to swap the function; stubbing the env
// would only move the module-scope `NETWORK` snapshot, which is built at import
// and never re-read. `NETWORK` and `discoveryServers` stay real, so the
// assertions about the broker and the discovery half are the real thing.
const env = vi.hoisted(() => ({
  turn: null as RTCIceServer | null,
  calls: 0,
}));

vi.mock('../config/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/network')>();
  return {
    ...actual,
    turnOverride: (): RTCIceServer | null => {
      env.calls += 1;
      return env.turn;
    },
  };
});

// The receiver's default selection already contains every relay in the table, so
// the relay a token names cannot be told apart in the config `join` ends up
// offering - naming index 1 and naming index 2 produce the same list. This
// records the index that actually reached the table instead of wrapping or
// replacing it, so `iceConfigFor`'s own behaviour is unchanged.
const table = vi.hoisted(() => ({ relays: [] as number[] }));

vi.mock('../config/iceServers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/iceServers')>();
  return {
    ...actual,
    resolveRelay: (relay: number): RTCIceServer => {
      table.relays.push(relay);
      return actual.resolveRelay(relay);
    },
  };
});

const { FakeDataConnection: FakeConnection, peers } = fakes;
type FakeDataConnection = InstanceType<typeof FakeConnection>;

function connectAs(alreadyOpen: boolean): { conn: FakeDataConnection; channel: PeerChannel } {
  const conn = new FakeConnection();
  const channel = new PeerChannel(conn as never, alreadyOpen);
  return { conn, channel };
}

function connectOpenedByPeer(): { conn: FakeDataConnection; channel: PeerChannel } {
  const conn = new FakeConnection();
  conn.fire('open');
  const channel = new PeerChannel(conn as never);
  return { conn, channel };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type FakePeerHandle = InstanceType<typeof fakes.FakePeer>;

const lastPeer = (): FakePeerHandle => {
  const peer = peers[peers.length - 1];
  if (peer === undefined) throw new Error('no Peer was constructed');
  return peer;
};

const lastConn = (peer: FakePeerHandle): FakeDataConnection => {
  const conn = peer.conns[peer.conns.length - 1];
  if (conn === undefined) throw new Error('no DataConnection was created');
  return conn;
};

// What the options handed to `new Peer` actually offered the browser.
const iceServersOf = (peer: FakePeerHandle): RTCIceServer[] => {
  const options = peer.options[0] as { config: { iceServers: RTCIceServer[] } } | undefined;
  if (options === undefined) throw new Error('the Peer was constructed with no options');
  return options.config.iceServers;
};

const urlsOf = (server: RTCIceServer): string[] =>
  Array.isArray(server.urls) ? server.urls : [server.urls as string];

const relayUrlsOf = (servers: readonly RTCIceServer[]): string[] =>
  servers.flatMap(urlsOf).filter((url) => url.startsWith('turn:'));

// The table's own object for an index, so a config can be asserted against the
// servers themselves rather than a re-resolution of the same indices.
const tableServer = (index: number): RTCIceServer => {
  const entry = ICE_SERVERS[index];
  if (entry === undefined) throw new Error(`no ICE server at index ${index}`);
  return entry.server;
};

// The first entry in the table that cannot relay, which is the index a token
// would be mis-pointing at if a STUN entry could be read as "the relay".
const firstIndexThatCannotRelay = (): number =>
  ICE_SERVERS.findIndex((entry) => !entry.relay);

afterEach(() => {
  env.turn = null;
  env.calls = 0;
  table.relays.length = 0;
});

describe('describePeerError', () => {
  it('tells the user nobody is sharing when the peer is missing', () => {
    expect(describePeerError({ type: 'peer-unavailable' })).toMatch(/no one is sharing/i);
  });

  it('treats a room id collision as a share-code problem', () => {
    expect(describePeerError({ type: 'unavailable-id' })).toMatch(/share code/i);
  });

  it('explains a blocked network path without blaming the user', () => {
    expect(describePeerError({ type: 'network' })).toMatch(/signalling server/i);
  });

  it('falls back to a generic message for anything unrecognised', () => {
    expect(describePeerError({ type: 'server-error' })).toMatch(/could not connect/i);
    expect(describePeerError(new Error('boom'))).toMatch(/could not connect/i);
  });
});

describe('errorCloseReason', () => {
  it('blames the transport path when the DataChannel never opened', () => {
    expect(errorCloseReason(false)).toBe('transport-failure');
  });

  it('reports a plain error once the DataChannel was working', () => {
    expect(errorCloseReason(true)).toBe('error');
  });
});

describe('PeerChannel close reasons', () => {
  it('surfaces a negotiation failure as a transport failure', () => {
    const { conn, channel } = connectAs(false);
    const reasons: CloseReason[] = [];
    channel.onClose((reason) => reasons.push(reason));
    conn.fire('error', { type: 'network' });
    expect(reasons).toEqual(['transport-failure']);
  });

  it('surfaces a failure after negotiation opened as a plain error', () => {
    const { conn, channel } = connectAs(false);
    const reasons: CloseReason[] = [];
    channel.onClose((reason) => reasons.push(reason));
    conn.fire('open');
    conn.fire('error', { type: 'network' });
    expect(reasons).toEqual(['error']);
  });

  it('does not reclassify a connection handed over already open', () => {
    const { conn, channel } = connectAs(true);
    const reasons: CloseReason[] = [];
    channel.onClose((reason) => reasons.push(reason));
    conn.fire('error', { type: 'network' });
    expect(reasons).toEqual(['error']);
  });

  it('keeps the opened flag separate from who closed the channel', () => {
    const { conn, channel } = connectAs(true);
    const reasons: CloseReason[] = [];
    channel.onClose((reason) => reasons.push(reason));
    conn.fire('close');
    expect(reasons).toEqual(['remote']);

    const local = connectAs(true);
    const localReasons: CloseReason[] = [];
    local.channel.onClose((reason) => localReasons.push(reason));
    local.channel.close();
    local.conn.fire('close');
    expect(localReasons).toEqual(['local']);
  });

  it('reports a close exactly once when error and close both fire', () => {
    const { conn, channel } = connectAs(false);
    const reasons: CloseReason[] = [];
    channel.onClose((reason) => reasons.push(reason));
    conn.fire('open');
    conn.fire('error', { type: 'network' });
    conn.fire('close');

    expect(reasons).toEqual(['error']);
  });

  it('reports a close exactly once when close fires twice', () => {
    const { conn, channel } = connectAs(false);
    const reasons: CloseReason[] = [];
    channel.onClose((reason) => reasons.push(reason));
    conn.fire('open');
    conn.fire('close');
    conn.fire('close');

    expect(reasons).toEqual(['remote']);
  });

  it('reports a local close once when the DataChannel echoes it back', () => {
    const { conn, channel } = connectAs(false);
    const reasons: CloseReason[] = [];
    channel.onClose((reason) => reasons.push(reason));
    conn.fire('open');
    channel.close();
    conn.fire('close');
    conn.fire('close');

    expect(reasons).toEqual(['local']);
  });
});

describe('PeerChannel sends before the DataChannel opens', () => {
  const offer = '{"t":"offer","name":"a.bin","size":"12","chunkSize":64}';

  it('delivers a message queued before open instead of tripping not-open-yet', () => {
    const { conn, channel } = connectAs(false);
    const reasons: CloseReason[] = [];
    channel.onClose((reason) => reasons.push(reason));

    channel.send(offer);
    expect(conn.notOpenYet).toBe(0);
    expect(conn.sent).toEqual([]);
    expect(reasons).toEqual([]);

    conn.fire('open');
    expect(conn.sent).toEqual([offer]);
    expect(reasons).toEqual([]);
  });

  it('sends straight through once the connection is open', () => {
    const { conn, channel } = connectAs(false);
    conn.fire('open');

    channel.send(offer);
    channel.send('second');

    expect(conn.sent).toEqual([offer, 'second']);
    expect(conn.notOpenYet).toBe(0);
  });

  it('flushes the queue in send order, not reversed or reordered', () => {
    const { conn, channel } = connectAs(false);
    const first = new Uint8Array([1, 2, 3]).buffer;
    const second = 'offer';
    const third = new Uint8Array([4, 5]).buffer;

    channel.send(first);
    channel.send(second);
    channel.send(third);

    conn.fire('open');

    expect(conn.sent).toEqual([first, second, third]);
  });

  it('counts queued bytes in bufferedAmount until they are flushed', () => {
    const { conn, channel } = connectAs(false);
    const buffer = new Uint8Array(64).buffer;

    expect(channel.bufferedAmount).toBe(0);
    channel.send(buffer);
    expect(channel.bufferedAmount).toBe(64);

    conn.fire('open');
    expect(channel.bufferedAmount).toBe(0);
  });

  it('drops the queue and sends nothing when closed before opening', () => {
    const { conn, channel } = connectAs(false);
    channel.send(offer);
    channel.send('second');

    channel.close();

    expect(conn.sent).toEqual([]);
    expect(conn.notOpenYet).toBe(0);
    expect(channel.bufferedAmount).toBe(0);
    expect(conn.closed).toBe(true);
  });

  it('drops the queue when the remote closes before opening', () => {
    const { conn, channel } = connectAs(false);
    channel.send(offer);

    conn.fire('close');
    conn.fire('open');

    expect(conn.sent).toEqual([]);
    expect(conn.notOpenYet).toBe(0);
    expect(channel.bufferedAmount).toBe(0);
  });

  it('sends immediately on a connection that is already open, with no open event', () => {
    const { conn, channel } = connectOpenedByPeer();

    channel.send(offer);

    expect(conn.sent).toEqual([offer]);
    expect(conn.notOpenYet).toBe(0);
    expect(conn.listenerCount('open')).toBe(1);
  });

  it('does not blame the transport for a failure on a connection that was already open', () => {
    const { conn, channel } = connectOpenedByPeer();
    const reasons: CloseReason[] = [];
    channel.onClose((reason) => reasons.push(reason));

    conn.fire('error', { type: 'network' });

    expect(reasons).toEqual(['error']);
  });
});

describe('isSessionFatal', () => {
  it('treats a lost signalling socket or a dropped server as fatal', () => {
    for (const type of ['disconnected', 'network', 'server-error', 'socket-closed', 'socket-error']) {
      expect(isSessionFatal(type), type).toBe(true);
    }
  });

  it('treats a single peer problem as survivable', () => {
    for (const type of [
      'peer-unavailable',
      'unavailable-id',
      'invalid-id',
      'invalid-key',
      'browser-incompatible',
      'webrtc',
    ]) {
      expect(isSessionFatal(type), type).toBe(false);
    }
  });

  it('treats an unrecognised or missing type as survivable rather than guessing', () => {
    expect(isSessionFatal(undefined)).toBe(false);
    expect(isSessionFatal('something-new')).toBe(false);
  });
});

describe('PeerSession error reporting', () => {
  const session = async (): Promise<{
    peer: FakePeerHandle;
    errors: { type: string | undefined; message: string; fatal: boolean }[];
  }> => {
    const opening = PeerSession.open();
    await settled();
    const peer = lastPeer();
    peer.fire('open');
    await settled();
    const errors: { type: string | undefined; message: string; fatal: boolean }[] = [];
    (await opening).onError((error) => errors.push(error));
    return { peer, errors };
  };

  it('flags a lost signalling socket as fatal so the session can be torn down', async () => {
    const { peer, errors } = await session();
    peer.fire('error', { type: 'socket-closed' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fatal).toBe(true);
    expect(errors[0]?.type).toBe('socket-closed');
    expect(errors[0]?.message.length).toBeGreaterThan(0);
  });

  it('flags a single peer problem as survivable so live transfers keep running', async () => {
    const { peer, errors } = await session();
    peer.fire('error', { type: 'peer-unavailable' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fatal).toBe(false);
  });
});

describe('ConnectionFailedError', () => {
  it('keeps the machine-readable PeerJS type so callers can act on it', () => {
    const error = new ConnectionFailedError('unavailable-id', 'That share code is already taken.');
    expect(error.code).toBe('unavailable-id');
    expect(error.message).toMatch(/share code/i);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('PeerSession.join', () => {
  it('asks for a reliable raw DataChannel from the peer named by the room id', async () => {
    const joining = PeerSession.join('room123');
    await settled();
    lastPeer().fire('open');
    await settled();
    expect(lastPeer().connectOptions).toEqual([{ reliable: true, serialization: 'raw' }]);
    lastConn(lastPeer()).fire('open');
    await joining;
  });

  it('rejects and tears the session down when the connection errors before it opens', async () => {
    const joining = PeerSession.join('room123', DEFAULT_RELAY, 5000);
    await settled();
    lastPeer().fire('open');
    await settled();
    const peer = lastPeer();
    const conn = lastConn(peer);
    conn.fire('error', { type: 'network' });
    await expect(joining).rejects.toThrowError(ConnectionFailedError);
    expect(conn.closed).toBe(true);
    expect(peer.destroyed).toBe(true);
  });

  it('gives up with a firewall-flavoured timeout and tears the session down', async () => {
    const joining = PeerSession.join('room123', DEFAULT_RELAY, 5);
    await settled();
    lastPeer().fire('open');
    await settled();
    const peer = lastPeer();
    const conn = lastConn(peer);
    await expect(joining).rejects.toMatchObject({ code: 'timeout' });
    expect(conn.closed).toBe(true);
    expect(peer.destroyed).toBe(true);
  });

  it('leaves only the channel-level error handler attached once the connection opens', async () => {
    const joining = PeerSession.join('room123', DEFAULT_RELAY, 5000);
    await settled();
    lastPeer().fire('open');
    await settled();
    const conn = lastConn(lastPeer());
    expect(conn.listenerCount('error')).toBe(1);
    conn.fire('open');
    await joining;
    expect(conn.listenerCount('error')).toBe(1);
  });

  it('does not destroy the peer session when a joined channel errors after it opened', async () => {
    const joining = PeerSession.join('room123', DEFAULT_RELAY, 5000);
    await settled();
    lastPeer().fire('open');
    await settled();
    const peer = lastPeer();
    const conn = lastConn(peer);
    conn.fire('open');
    const { channel, session } = await joining;
    conn.fire('error', { type: 'network' });
    expect(peer.destroyed).toBe(false);
    expect(conn.closed).toBe(false);
    expect(channel).toBeInstanceOf(PeerChannel);
    expect(session).toBeInstanceOf(PeerSession);
  });

  it('hands back the session that owns the channel so the caller can destroy it', async () => {
    const joining = PeerSession.join('room123', DEFAULT_RELAY, 5000);
    await settled();
    lastPeer().fire('open');
    await settled();
    const peer = lastPeer();
    lastConn(peer).fire('open');
    const { session } = await joining;
    expect(peer.destroyed).toBe(false);

    session.close();
    expect(peer.destroyed).toBe(true);
  });

  it('destroys the peer session on close exactly once', async () => {
    const joining = PeerSession.join('room123', DEFAULT_RELAY, 5000);
    await settled();
    lastPeer().fire('open');
    await settled();
    const peer = lastPeer();
    lastConn(peer).fire('open');
    const { session } = await joining;

    session.close();
    session.close();
    expect(peer.destroyed).toBe(true);
  });

  it('leaves nothing to destroy when the join fails before it opens', async () => {
    const joining = PeerSession.join('room123', DEFAULT_RELAY, 5000);
    await settled();
    lastPeer().fire('open');
    await settled();
    const peer = lastPeer();
    lastConn(peer).fire('error', { type: 'network' });
    await expect(joining).rejects.toThrowError(ConnectionFailedError);
    expect(peer.destroyed).toBe(true);
  });

  it('does not fire the join timeout at a channel that already opened', async () => {
    const joining = PeerSession.join('room123', DEFAULT_RELAY, 5);
    await settled();
    lastPeer().fire('open');
    await settled();
    const peer = lastPeer();
    lastConn(peer).fire('open');
    await joining;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peer.destroyed).toBe(false);
  });

  it('gathers from the relay the token named, so both ends use the same server', async () => {
    const joining = PeerSession.join('room123', DEFAULT_RELAY + 1);
    await settled();
    const offered = iceServersOf(lastPeer());
    lastPeer().fire('open');
    await settled();
    lastConn(lastPeer()).fire('open');
    await joining;

    // The receiver has no picker, so its selection is the default one - but the
    // relay the sender put in the token has to be the one resolved, or the two
    // ends could be pointed at different servers.
    expect(table.relays).toContain(DEFAULT_RELAY + 1);
    expect(offered).toContain(resolveRelay(DEFAULT_RELAY + 1));
    expect(offered).toEqual(iceConfigFor({ enabled: DEFAULT_ENABLED, relay: DEFAULT_RELAY + 1 }));
  });

  it('lands on the default relay for a link shared before the token carried a relay', async () => {
    // The 54-byte legacy token decodes to `relay: null`, and this is the whole
    // reason a 54-byte link still has to produce a usable connection: the
    // receiver picks its own default rather than refusing the link.
    const payload: SharePayload = { roomId: 'room123', key: new Uint8Array(32), relay: null };
    const joining = PeerSession.join(payload.roomId, payload.relay ?? DEFAULT_RELAY);
    await settled();
    const offered = iceServersOf(lastPeer());
    const resolved = [...table.relays];
    lastPeer().fire('open');
    await settled();
    lastConn(lastPeer()).fire('open');
    await joining;

    // The receiver keeps its own default selection - it has no picker - so what
    // matters is which relay the join resolved. Read before the assertions
    // below resolve one of their own.
    expect(resolved).toEqual([DEFAULT_RELAY]);
    expect(offered).toContain(resolveRelay(DEFAULT_RELAY));
  });

  it('lands on the default relay when the link names no relay at all', async () => {
    const joining = PeerSession.join('room123', undefined);
    await settled();
    const offered = iceServersOf(lastPeer());
    const resolved = [...table.relays];
    lastPeer().fire('open');
    await settled();
    lastConn(lastPeer()).fire('open');
    await joining;

    expect(resolved).toEqual([DEFAULT_RELAY]);
    expect(offered).toContain(resolveRelay(DEFAULT_RELAY));
  });
});

describe('iceConfigFor', () => {
  it('keeps the selection in the order given and names the designated relay once, last', () => {
    const config = iceConfigFor({ enabled: [0, 2], relay: 1 });
    expect(config).toHaveLength(3);
    expect(config[2]).toEqual(resolveRelay(1));
  });

  it('names a relay the sender designated even when the selection left it out', () => {
    // The receiver follows the token, not its own selection, so a relay the
    // sender chose has to be appended rather than dropped.
    const config = iceConfigFor({ enabled: [0], relay: 1 });
    expect(config).toContain(resolveRelay(1));
  });

  it('falls back to the default relay when the sender named one this build lacks', () => {
    // A token is attacker-controlled input and the two peers may run different
    // builds, so an index this build has never heard of is a legitimate token.
    const config = iceConfigFor({ enabled: [0], relay: 9999 });
    expect(config[config.length - 1]).toEqual(resolveRelay(DEFAULT_RELAY));
  });

  it('falls back to the default relay when the index names a server that cannot relay', () => {
    // Index 0 is Google STUN today. A decoded relay is not guaranteed to be a
    // TURN server, and a STUN entry offered as one is a relay that cannot relay.
    const stunIndex = firstIndexThatCannotRelay();
    expect(stunIndex, 'the table has a STUN-only entry to mis-point at').toBeGreaterThanOrEqual(0);
    const config = iceConfigFor({ enabled: [0], relay: stunIndex });
    expect(config).toContain(resolveRelay(DEFAULT_RELAY));
    expect(config[config.length - 1]).toBe(resolveRelay(DEFAULT_RELAY));
  });

  it('never duplicates a server that is both selected and designated', () => {
    // Dedupe is by object identity, not index; see the two tests below.
    const config = iceConfigFor({ enabled: [2, 1], relay: 2 });
    expect(config).toHaveLength(2);
    expect(config.filter((server) => server === resolveRelay(2))).toHaveLength(1);
  });

  it('appends no second copy of the fallback when the token names an index this build lacks', () => {
    // The hazard the identity check exists for: an index comparison finds 9999
    // absent from the selection, so it appends the fallback - which
    // `DEFAULT_ENABLED` already contains - and the relay is gathered twice.
    const config = iceConfigFor({ enabled: DEFAULT_ENABLED, relay: 9999 });
    expect(config).toHaveLength(DEFAULT_ENABLED.length);
    expect(config.filter((server) => server === resolveRelay(DEFAULT_RELAY))).toHaveLength(1);
  });

  it('still adds a relay when the named index is selected but cannot relay', () => {
    // The other half: index 0 is in the selection and names Google STUN, so an
    // index comparison concludes the designated relay is already there and
    // appends nothing, leaving the connection with no TURN at all.
    const stunIndex = firstIndexThatCannotRelay();
    const config = iceConfigFor({ enabled: [stunIndex], relay: stunIndex });
    expect(config).toEqual([tableServer(stunIndex), resolveRelay(DEFAULT_RELAY)]);
  });

  it('keeps the designated relay where the selection put it, rather than moving it to the end', () => {
    // Priority does not require list position, and the list is read by people
    // debugging a connection, so the dedupe must not reorder anything.
    expect(iceConfigFor({ enabled: [2, 1], relay: 2 })).toEqual(resolveEnabled([2, 1]));
  });

  it('resolves a selection and a relay to the same table objects, which is what the dedupe relies on', () => {
    // The duplicate check is `enabled.includes(relay)`, an identity comparison
    // across two separate calls into the table. That only works because both
    // hand back the table's own live objects rather than copies; if either
    // started copying, this is the assertion that fails first.
    for (const [index, entry] of ICE_SERVERS.entries()) {
      expect(resolveEnabled([index])[0], entry.name).toBe(entry.server);
    }
    for (const [index, entry] of ICE_SERVERS.entries()) {
      if (!entry.relay) continue;
      expect(resolveRelay(index), entry.name).toBe(entry.server);
    }
    // The fallback is itself a table object, so a relayed default is deduped
    // against a selection of the same index.
    expect(ICE_SERVERS.some((entry) => entry.server === resolveRelay(DEFAULT_RELAY))).toBe(true);
  });

  it('still offers a relay for an empty selection, because TURN alone can carry a transfer', () => {
    expect(iceConfigFor({ enabled: [], relay: 0 })).toEqual([resolveRelay(DEFAULT_RELAY)]);
  });
});

describe('PeerSession.open', () => {
  const openPeer = async (selection?: Parameters<typeof PeerSession.open>[1]): Promise<FakePeerHandle> => {
    const opening = PeerSession.open('room123', selection);
    await settled();
    const peer = lastPeer();
    peer.fire('open');
    await settled();
    await opening;
    return peer;
  };

  it('hands PeerJS the selected servers and the designated relay', async () => {
    const peer = await openPeer({ enabled: [0], relay: 1 });
    expect(iceServersOf(peer)).toEqual(iceConfigFor({ enabled: [0], relay: 1 }));
  });

  it('defaults to the app\'s own selection when given none', async () => {
    const peer = await openPeer();
    expect(iceServersOf(peer)).toEqual(iceConfigFor({ enabled: DEFAULT_ENABLED, relay: DEFAULT_RELAY }));
  });

  it('offers the relay the selection named, not the default one', async () => {
    // `DEFAULT_RELAY` sits inside the default selection, so a config built from
    // a hardcoded default is identical for every selection that keeps the
    // default: only naming a different relay tells the two apart.
    const peer = await openPeer({ enabled: [0], relay: DEFAULT_RELAY + 1 });
    expect(iceServersOf(peer)).toEqual([tableServer(0), tableServer(DEFAULT_RELAY + 1)]);
  });

  it('hands PeerJS the app\'s broker, so the session reaches the configured signalling server', async () => {
    const peer = await openPeer();
    expect(peer.options[0]).toMatchObject({
      host: NETWORK.broker.host,
      port: NETWORK.broker.port,
      path: NETWORK.broker.path,
      secure: NETWORK.broker.secure,
    });
  });

  it('keeps address discovery alongside a relay override, so a direct route is still tried', async () => {
    // A fork naming its own relay still wants the cheap direct route attempted
    // first - and the discovery half comes from `discoveryServers()` rather than
    // a filter re-derived here, which is how the two lists would drift.
    const override: RTCIceServer = { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'secret' };
    env.turn = override;

    const peer = await openPeer({ enabled: [0], relay: 1 });
    const offered = iceServersOf(peer);

    expect(offered).toEqual(discoveryServers().concat(override));
    expect(offered).toContain(ICE_SERVERS[0]?.server as RTCIceServer);
  });

  it('replaces the table relays with the override, so a fork is not sent to a relay it did not choose', async () => {
    const override: RTCIceServer = { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'secret' };
    env.turn = override;

    const peer = await openPeer({ enabled: DEFAULT_ENABLED, relay: DEFAULT_RELAY });
    expect(relayUrlsOf(iceServersOf(peer))).toEqual(['turn:turn.example.com:3478']);
  });

  it('reads the override fresh on every open, rather than once at import', async () => {
    // `turnOverride` reads the env at call time while `NETWORK` snapshots it at
    // import, so a value cached at module scope would never take effect: the
    // second session would be offered the first session's relay.
    const first: RTCIceServer = { urls: ['turn:first.example.com:3478'], username: 'a', credential: 'b' };
    const second: RTCIceServer = { urls: ['turn:second.example.com:3478'], username: 'a', credential: 'b' };

    env.turn = first;
    const openedFirst = await openPeer();
    const callsAfterFirst = env.calls;

    env.turn = second;
    const openedSecond = await openPeer();

    expect(relayUrlsOf(iceServersOf(openedFirst))).toEqual(['turn:first.example.com:3478']);
    expect(relayUrlsOf(iceServersOf(openedSecond))).toEqual(['turn:second.example.com:3478']);
    // One read per open: two sessions cannot agree on a config if only the first
    // one looked at the environment.
    expect(env.calls).toBe(callsAfterFirst + 1);
    expect(callsAfterFirst).toBe(1);
  });
});
