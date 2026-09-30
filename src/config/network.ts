import { DEFAULT_ENABLED, ICE_SERVERS, resolveEnabled } from './iceServers';

export interface NetworkConfig {
  broker: { host: string; port: number; path: string; secure: boolean };
}

const env = import.meta.env;

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 443;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 443;
}

// A fork's own relay. Deliberately not a table entry: an index is only
// meaningful if both sides index the same table, and an entry that exists in
// one build and not another would put a fork's users one byte out of step with
// everyone else's. The operator gets their relay; they do not get to name it in
// a share token.
//
// All three variables or none; README.md documents the same rule. The two
// halves of a partial override fail for different reasons, which is why neither
// can be half-honoured. A URL with no username or credential is not a usable
// TURN server: the browser rejects the entry with InvalidAccessError while
// constructing the RTCPeerConnection. PeerJS builds that connection lazily
// rather than at `new Peer`, so the throw happens inside `peer.connect(...)` at
// `src/transport/peerjs.ts:198` — and it leaves `join` as a rejected promise
// rather than a PeerJS `error` event, so it bypasses both `onEarlyError`
// handlers and `describePeerError` and reaches the screen as a raw browser
// message naming none of the three variables the operator half-set. Credentials
// with no URL never get that far: `urls` is a required member of RTCIceServer,
// so the entry is not a server at all. Ignoring the override connects over the
// table's public relays and merely disregards what the operator asked for.
export function turnOverride(): RTCIceServer | null {
  const url = env.VITE_TURN_URL;
  const username = env.VITE_TURN_USERNAME;
  const credential = env.VITE_TURN_CREDENTIAL;
  if (url === undefined || username === undefined || credential === undefined) return null;
  return { urls: [url], username, credential };
}

// Address discovery only: every enabled entry that cannot relay, picked by what
// it can do rather than by its position. Index 0 happens to be the STUN entry
// today, but a table that led with a relay, or one whose index 0 had gone
// missing, would otherwise leave this half of the list wrong — and an empty
// result is still a usable config, since TURN alone can carry a transfer.
//
// Exported because a caller composing a relay override needs the same discovery
// half this module builds, and re-deriving it there is how the two drift. The
// entries are the table's own live objects: treat them as read-only, per the
// contract at the top of `iceServers.ts`.
export function discoveryServers(): readonly RTCIceServer[] {
  return resolveEnabled(DEFAULT_ENABLED.filter((index) => ICE_SERVERS[index]?.relay === false));
}

export const APP_URL: string | undefined = env.VITE_APP_URL;

// The broker and nothing else. An ICE config once sat here as a second
// computed copy of the table's default selection, and no production code ever
// read it: `PeerSession.open` builds its own from the sender's selection, or
// from `discoveryServers()` and the override. Two computations of the same list
// is two things to keep in step, and they disagreed - this one deduped by
// index, so a `DEFAULT_RELAY` naming a server that cannot relay left the
// config with no relay at all where `iceConfigFor` appends the fallback. The
// live mechanism is `iceConfigFor` (`src/transport/peerjs.ts`), with a parity
// assertion in `src/transport/peerjs.test.ts` against what a session actually
// hands the browser. Nothing reads a value here, so nothing is built here.
export const NETWORK: NetworkConfig = {
  broker: {
    host: env.VITE_BROKER_HOST ?? '0.peerjs.com',
    port: parsePort(env.VITE_BROKER_PORT),
    path: env.VITE_BROKER_PATH ?? '/',
    secure: env.VITE_BROKER_SECURE === 'false' ? false : true,
  },
};
