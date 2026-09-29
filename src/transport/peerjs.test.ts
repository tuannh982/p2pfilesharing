import { describe, expect, it, vi } from 'vitest';
import { ConnectionFailedError, describePeerError, errorCloseReason, isSessionFatal, PeerChannel, PeerSession } from './peerjs';
import type { CloseReason } from './channel';

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

    constructor(options: unknown) {
      super();
      this.options.push(options);
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
    const joining = PeerSession.join('room123', 5000);
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
    const joining = PeerSession.join('room123', 5);
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
    const joining = PeerSession.join('room123', 5000);
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
    const joining = PeerSession.join('room123', 5000);
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
    const joining = PeerSession.join('room123', 5000);
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
    const joining = PeerSession.join('room123', 5000);
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
    const joining = PeerSession.join('room123', 5000);
    await settled();
    lastPeer().fire('open');
    await settled();
    const peer = lastPeer();
    lastConn(peer).fire('error', { type: 'network' });
    await expect(joining).rejects.toThrowError(ConnectionFailedError);
    expect(peer.destroyed).toBe(true);
  });

  it('does not fire the join timeout at a channel that already opened', async () => {
    const joining = PeerSession.join('room123', 5);
    await settled();
    lastPeer().fire('open');
    await settled();
    const peer = lastPeer();
    lastConn(peer).fire('open');
    await joining;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peer.destroyed).toBe(false);
  });
});
