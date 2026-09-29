import Peer, { PeerErrorType } from 'peerjs';
import type { DataConnection, PeerError } from 'peerjs';
import { NETWORK } from '../config/network';
import type { Channel, ChannelMessage, CloseReason } from './channel';

export const DEFAULT_JOIN_TIMEOUT_MS = 30000;

export class ConnectionFailedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConnectionFailedError';
    this.code = code;
  }
}

export function describePeerError(error: unknown): string {
  const type = (error as { type?: string } | null)?.type;
  switch (type) {
    case PeerErrorType.PeerUnavailable:
      return 'No one is sharing with that code. Make sure the sender has the page open.';
    case PeerErrorType.UnavailableID:
      return 'That share code is already taken. Please try again.';
    case PeerErrorType.Network:
      return 'Could not reach the signalling server. Check your connection and try again.';
    default:
      return 'Could not connect to the sender. Please try again.';
  }
}

export function errorCloseReason(opened: boolean): CloseReason {
  return opened ? 'error' : 'transport-failure';
}

const SESSION_FATAL_ERRORS: ReadonlySet<string> = new Set([
  PeerErrorType.Disconnected,
  PeerErrorType.Network,
  PeerErrorType.ServerError,
  PeerErrorType.SocketClosed,
  PeerErrorType.SocketError,
]);

export interface SessionError {
  type: string | undefined;
  message: string;
  fatal: boolean;
}

export function isSessionFatal(type: string | undefined): boolean {
  return type !== undefined && SESSION_FATAL_ERRORS.has(type);
}

const messageSize = (msg: ChannelMessage): number =>
  typeof msg === 'string' ? msg.length : msg.byteLength;

export class PeerChannel implements Channel {
  private readonly messageHandlers: ((msg: ChannelMessage) => void)[] = [];
  private readonly closeHandlers: ((reason: CloseReason) => void)[] = [];
  private readonly queue: ChannelMessage[] = [];
  private closedLocally = false;
  private closed = false;
  private closeReported = false;
  private opened: boolean;

  constructor(private readonly conn: DataConnection, alreadyOpen = false) {
    this.opened = alreadyOpen || conn.open;
    this.conn.on('data', (data: unknown) => {
      if (typeof data === 'string') {
        this.dispatch(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        this.dispatch(data);
        return;
      }
      if (data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => this.dispatch(buffer));
      }
    });
    this.conn.on('open', () => {
      this.opened = true;
      this.flush();
    });
    this.conn.on('close', () => {
      this.terminate();
      this.dispatchClose(this.closedLocally ? 'local' : 'remote');
    });
    this.conn.on('error', () => {
      this.terminate();
      this.dispatchClose(errorCloseReason(this.opened));
    });
  }

  get bufferedAmount(): number {
    const dataChannel: RTCDataChannel | undefined = this.conn.dataChannel;
    let queued = 0;
    for (const msg of this.queue) queued += messageSize(msg);
    return (dataChannel?.bufferedAmount ?? 0) + queued;
  }

  private dispatch(msg: ChannelMessage): void {
    for (const handler of this.messageHandlers) handler(msg);
  }

  private dispatchClose(reason: CloseReason): void {
    if (this.closeReported) return;
    this.closeReported = true;
    for (const handler of this.closeHandlers) handler(reason);
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const pending = this.queue.splice(0, this.queue.length);
    for (const msg of pending) this.conn.send(msg);
  }

  private terminate(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  send(msg: ChannelMessage): void {
    if (this.closed) return;
    if (this.opened) {
      this.conn.send(msg);
      return;
    }
    this.queue.push(msg);
  }

  onMessage(cb: (msg: ChannelMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onClose(cb: (reason: CloseReason) => void): void {
    this.closeHandlers.push(cb);
  }

  close(): void {
    this.closedLocally = true;
    this.terminate();
    this.conn.close();
  }
}

export interface JoinResult {
  session: PeerSession;
  channel: PeerChannel;
}

export class PeerSession {
  private readonly connectionHandlers: ((channel: PeerChannel) => void)[] = [];
  private readonly errorHandlers: ((error: SessionError) => void)[] = [];
  private readonly peer: Peer;
  private closed = false;

  private constructor(peer: Peer) {
    this.peer = peer;
    this.peer.on('connection', (conn: DataConnection) => {
      for (const handler of this.connectionHandlers) handler(new PeerChannel(conn));
    });
    this.peer.on('error', (error: PeerError<string>) => {
      const failure: SessionError = {
        type: error.type,
        message: describePeerError(error),
        fatal: isSessionFatal(error.type),
      };
      for (const handler of this.errorHandlers) handler(failure);
    });
  }

  static open(roomId?: string): Promise<PeerSession> {
    return new Promise((resolve, reject) => {
      const options = {
        host: NETWORK.broker.host,
        port: NETWORK.broker.port,
        path: NETWORK.broker.path,
        secure: NETWORK.broker.secure,
        config: { iceServers: NETWORK.iceServers },
      };
      const peer = roomId === undefined ? new Peer(options) : new Peer(roomId, options);
      const onEarlyError = (error: PeerError<string>): void => {
        const type = error.type;
        peer.destroy();
        reject(new ConnectionFailedError(type, describePeerError(error)));
      };
      peer.once('error', onEarlyError);
      peer.once('open', () => {
        peer.removeListener('error', onEarlyError);
        resolve(new PeerSession(peer));
      });
    });
  }

  static async join(roomId: string, timeoutMs: number = DEFAULT_JOIN_TIMEOUT_MS): Promise<JoinResult> {
    const session = await PeerSession.open();
    const conn = session.peer.connect(roomId, { reliable: true, serialization: 'raw' });

    return new Promise<JoinResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = (code: string, message: string): void => {
        if (timer !== undefined) clearTimeout(timer);
        conn.close();
        session.close();
        reject(new ConnectionFailedError(code, message));
      };
      timer = setTimeout(
        () =>
          fail(
            'timeout',
            'Could not establish a direct connection. Both sides may be behind strict firewalls.',
          ),
        timeoutMs,
      );

      const onEarlyError = (error: PeerError<string>): void =>
        fail(error.type, describePeerError(error));
      const onOpen = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        conn.removeListener('error', onEarlyError);
        resolve({ session, channel: new PeerChannel(conn, true) });
      };
      conn.once('open', onOpen);
      conn.once('error', onEarlyError);
    });
  }

  onConnection(cb: (channel: PeerChannel) => void): void {
    this.connectionHandlers.push(cb);
  }

  onError(cb: (error: SessionError) => void): void {
    this.errorHandlers.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.peer.destroy();
  }
}
