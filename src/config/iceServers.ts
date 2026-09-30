// `server` is handed out live rather than copied, and the table is one module
// instance that every connection the app opens reads from. Treat a resolved
// config as read-only: writing through it would corrupt the table for all of
// them, and a relay whose URL or credential changed underneath a shared token
// would send peers somewhere their sender never chose.
export interface IceServerEntry {
  readonly name: string;
  readonly relay: boolean;
  readonly server: RTCIceServer;
}

// Append-only. A share token names a relay by its index in this array, so
// reordering or removing an entry would silently repoint every token already
// shared. New servers go at the end.
export const ICE_SERVERS: readonly IceServerEntry[] = [
  {
    name: 'Google STUN',
    relay: false,
    server: {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302',
      ],
    },
  },
  // The PeerJS cloud relays, the only kind of relay that belongs in this
  // table: their credentials are the public `peerjs` / `peerjsp` pair PeerJS
  // publishes, and the pair this app has shipped since its first commit, so
  // no operator has to provision or rotate anything. Everything here is
  // bundled into the client and readable by anyone who loads the app, so a
  // relay with a private credential must never be added — present
  // credentials are not enough, they have to be the ones that service
  // actually authenticates with.
  {
    name: 'PeerJS EU',
    relay: true,
    server: { urls: 'turn:eu-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
  },
  {
    name: 'PeerJS US',
    relay: true,
    server: { urls: 'turn:us-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
  },
];

export const DEFAULT_ENABLED: readonly number[] = [0, 1, 2];

export const DEFAULT_RELAY = 1;

const entryAt = (index: number): IceServerEntry | undefined =>
  Number.isInteger(index) ? ICE_SERVERS[index] : undefined;

export function isKnownIndex(index: number): boolean {
  return entryAt(index) !== undefined;
}

export function resolveEnabled(enabled: readonly number[]): RTCIceServer[] {
  return enabled.flatMap((index) => {
    const entry = entryAt(index);
    return entry === undefined ? [] : [entry.server];
  });
}

export function resolveRelay(relay: number): RTCIceServer {
  const fallback = ICE_SERVERS[DEFAULT_RELAY];
  if (fallback === undefined) {
    throw new Error(`DEFAULT_RELAY (${DEFAULT_RELAY}) does not name an entry in the ICE server table.`);
  }
  const entry = entryAt(relay);
  return entry !== undefined && entry.relay ? entry.server : fallback.server;
}
