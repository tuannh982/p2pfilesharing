import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { importRawKey } from '../crypto/keys';
import {
  DEFAULT_ENABLED,
  DEFAULT_RELAY,
  ICE_SERVERS,
  isKnownIndex,
} from '../config/iceServers';
import { turnOverride } from '../config/network';
import { manifestFromFiles, validateManifest } from '../protocol/manifest';
import { SenderSession, type SenderSessionOptions } from '../protocol/session';
import { ConnectionFailedError, PeerSession, type IceSelection } from '../transport/peerjs';
import { encodeShare } from '../token/codec';
import { mintSharePayload } from '../token/mint';
import { formatBytes, formatRate } from './format';
import { buildShareLink } from './shareLink';

type Phase = 'idle' | 'ready' | 'serving' | 'failed';

type RowState = 'sending' | 'delivered' | 'cancelled' | 'failed';

interface Row {
  receiver: number;
  index: number;
  name: string;
  sent: bigint;
  total: bigint;
  state: RowState;
  startedAt: number;
}

const MAX_ROOM_ID_ATTEMPTS = 5;

const STORAGE_KEY = 'p2fs.ice';

const DEFAULT_SELECTION: IceSelection = { enabled: DEFAULT_ENABLED, relay: DEFAULT_RELAY };

// The grid the picker is laid out in needs one explicit row per server, because
// the relay group spans from the first row to the last and `-1` resolves against
// the explicit grid - a grid whose rows are all implicit ends at line 1, and the
// group then covers a single row while the checkboxes flow into its column. The
// count comes from the array these rows are rendered from rather than being
// written into the stylesheet, so a server appended to the table brings its row
// with it. React's `CSSProperties` has no index signature for custom
// properties, hence the assertion.
const SERVER_ROW_COUNT = { '--server-rows': ICE_SERVERS.length } as CSSProperties;

// `isKnownIndex` alone would accept 0, which is Google STUN. `resolveRelay`
// sends a non-relay index to the default relay rather than failing, so a
// hand-edited `relay: 0` would survive every reload and quietly mean something
// other than what it says. The designation is re-checked against what the entry
// can actually do, not merely against whether it exists.
//
// This is the only place that asks, which is why the rule lives here rather than
// beside the table's other rules: it is not a copy of `resolveRelay`'s, which
// redirects a non-relay index, but the question a redirect cannot answer -
// whether this entry is one the user may put in the radiogroup at all, asked
// before designating rather than resolved after. The other end of the relay
// index is `chooseRelay` in `relayChoice.ts`, which is the byte arriving from a
// token and has nothing to resolve.
const isRelayIndex = (index: number): boolean =>
  isKnownIndex(index) && ICE_SERVERS[index]?.relay === true;

// Filtered and de-duplicated rather than trusted. `localStorage` is
// user-writable and survives across builds, so a stored array can name an index
// this build lacks, name one twice, or hold something that is not an index at
// all; each of those would otherwise reach `resolveEnabled` verbatim.
const knownEnabled = (candidates: readonly unknown[]): number[] => {
  const enabled: number[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'number' || !isKnownIndex(candidate)) continue;
    if (enabled.includes(candidate)) continue;
    enabled.push(candidate);
  }
  return enabled;
};

// Parsed as `unknown` first, because `localStorage` holds whatever a previous
// build, another tab or a hand-edited value left there. An array is the awkward
// case: `typeof` admits it as an object, but it has no `enabled` to read.
const readSelection = (): IceSelection => {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return DEFAULT_SELECTION;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_SELECTION;
    const fields = parsed as { enabled?: unknown; relay?: unknown };
    if (!Array.isArray(fields.enabled)) return DEFAULT_SELECTION;
    const relay =
      typeof fields.relay === 'number' && isRelayIndex(fields.relay) ? fields.relay : DEFAULT_RELAY;
    const enabled = knownEnabled(fields.enabled);
    // The relay is forced in because `iceConfigFor` appends it either way;
    // leaving it out would show its checkbox unchecked while its server was in
    // the config all the same.
    return { enabled: enabled.includes(relay) ? enabled : [...enabled, relay], relay };
  } catch {
    return DEFAULT_SELECTION;
  }
};

// Guarded twice over. `localStorage` is absent outside a browser, so the
// optional chain handles a unit test or a worker; and `setItem` throws rather
// than returning null when storage is disabled, partitioned, or out of quota,
// which the optional chain does not cover. Either way the choice still applies
// to the share being started - it just is not remembered.
const writeSelection = (selection: IceSelection): void => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {}
};

// The designated relay is in the config whether or not the list says so, so it
// is put back in rather than only being defended against in the UI. That makes
// "unchecked means not used" true everywhere instead of nearly everywhere. The
// append is guarded as well: a duplicate index is a second gather request
// against the same server, so this has to hold whatever it is handed.
const toggleEnabled = (current: IceSelection, index: number, on: boolean): IceSelection => {
  const next = on
    ? current.enabled.includes(index)
      ? current.enabled
      : [...current.enabled, index]
    : current.enabled.filter((candidate) => candidate !== index);
  return {
    ...current,
    enabled: next.includes(current.relay) ? next : [...next, current.relay],
  };
};

const isDefaultSelection = (selection: IceSelection): boolean =>
  selection.relay === DEFAULT_RELAY &&
  selection.enabled.length === DEFAULT_ENABLED.length &&
  DEFAULT_ENABLED.every((index) => selection.enabled.includes(index));

const nameOf = (index: number): string => ICE_SERVERS[index]?.name ?? `server ${index}`;

// Address discovery is what a STUN entry is for, picked by what it can do
// rather than by its position, the same way `discoveryServers()` picks it.
const hasDiscovery = (selection: IceSelection): boolean =>
  selection.enabled.some((index) => ICE_SERVERS[index]?.relay === false);

// Both halves of the selection, because a deviation in either one is a
// deviation: a line naming only the relay would read identically to the default
// for a user who had merely switched a spare relay off.
const describeSelection = (selection: IceSelection): string => {
  const on = selection.enabled.map(nameOf);
  return `relay ${nameOf(selection.relay)}, enabled: ${on.join(', ')}`;
};

const isRoomIdCollision = (cause: unknown): boolean =>
  cause instanceof ConnectionFailedError && cause.code === 'unavailable-id';

const rowKey = (row: Row): string => `${row.receiver}-${row.index}`;

const fileKey = (file: File, index: number): string => `${file.name}-${file.size}-${index}`;

const nameAt = (files: File[], index: number): string => files[index]?.name ?? 'the file';

export function ShareTab() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [picked, setPicked] = useState<File[]>([]);
  const [token, setToken] = useState('');
  const [receivers, setReceivers] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<IceSelection>(readSelection);

  const sessionRef = useRef<PeerSession | null>(null);
  const enginesRef = useRef<Set<SenderSession>>(new Set());
  const mountedRef = useRef(true);
  const creatingRef = useRef(false);
  const generationRef = useRef(0);
  const nextReceiverIdRef = useRef(0);
  const liveReceiversRef = useRef<Set<number>>(new Set());
  const statusReceiverRef = useRef<number | null>(null);

  const teardown = useCallback((): void => {
    for (const engine of enginesRef.current) engine.abort();
    enginesRef.current.clear();
    sessionRef.current?.close();
    sessionRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [teardown]);

  const forgetShare = useCallback((): void => {
    setReceivers(0);
    setRows([]);
    setStatus('');
    liveReceiversRef.current.clear();
    statusReceiverRef.current = null;
  }, []);

  const onPick = (chosen: File[]): void => {
    generationRef.current += 1;
    teardown();
    setToken('');
    forgetShare();
    setPicked([]);
    if (chosen.length === 0) {
      setError(null);
      setPhase('idle');
      return;
    }
    try {
      validateManifest(manifestFromFiles(chosen));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Those files cannot be shared.');
      setPhase('idle');
      return;
    }
    setError(null);
    setPicked(chosen);
    setPhase('ready');
  };

  // Called fresh on every render rather than read off `NETWORK`, which
  // snapshotted the env at import. A build that names its own relay takes the
  // override branch in `PeerSession.open` and never looks at the selection, so
  // this is also what decides whether offering a picker would be offering a
  // control that does nothing.
  const turn = turnOverride();

  const applySelection = (next: IceSelection): void => {
    setSelection(next);
    writeSelection(next);
  };

  const onToggle = (index: number, on: boolean): void => {
    applySelection(toggleEnabled(selection, index, on));
  };

  const onDesignate = (index: number): void => {
    // Designating a relay that is currently switched off has to switch it on, or
    // the two halves of the selection would say opposite things about whether
    // the designated relay is in the config.
    const enabled = selection.enabled.includes(index)
      ? selection.enabled
      : [...selection.enabled, index];
    applySelection({ enabled, relay: index });
  };

  const onResetSelection = (): void => {
    applySelection({ enabled: DEFAULT_ENABLED, relay: DEFAULT_RELAY });
  };

  const host = useCallback(
    async (current: File[], chosen: IceSelection): Promise<void> => {
      const generation = generationRef.current;
      const stale = (): boolean => !mountedRef.current || generationRef.current !== generation;

      const minted = await mintSharePayload(chosen.relay);
      if (stale()) return;

      const session = await PeerSession.open(minted.roomId, chosen);
      if (stale()) {
        session.close();
        return;
      }
      sessionRef.current = session;

      const key = await importRawKey(minted.key);
      if (stale()) {
        session.close();
        return;
      }

      session.onError((failure) => {
        setError(failure.message);
        if (!failure.fatal) return;
        teardown();
        forgetShare();
        setToken('');
        setPhase('failed');
      });

      session.onConnection((channel) => {
        nextReceiverIdRef.current += 1;
        const receiver = nextReceiverIdRef.current;
        liveReceiversRef.current.add(receiver);
        setReceivers(liveReceiversRef.current.size);
        setError(null);

        const patch = (index: number, change: Partial<Row>): void =>
          setRows((previous) =>
            previous.map((row) =>
              row.receiver === receiver && row.index === index ? { ...row, ...change } : row,
            ),
          );

        const options: SenderSessionOptions = {
          onTransferStart: (index, file) => {
            statusReceiverRef.current = receiver;
            setStatus(`Sending ${file.name} to Receiver ${receiver}.`);
            setRows((previous) => [
              ...previous.filter((row) => !(row.receiver === receiver && row.index === index)),
              {
                receiver,
                index,
                name: file.name,
                sent: 0n,
                total: BigInt(file.size),
                state: 'sending',
                startedAt: Date.now(),
              },
            ]);
          },
          onProgress: (index, sent, total) => patch(index, { sent, total, state: 'sending' }),
          onComplete: (index) => {
            statusReceiverRef.current = receiver;
            setStatus(`Sent ${nameAt(current, index)} to Receiver ${receiver}.`);
            patch(index, { state: 'delivered' });
          },
          // Fires after the terminator is on the wire, and only when the cancel
          // actually named the file in flight: a stale one produces nothing, so
          // a row that never reaches here stays in the state it was in. No
          // `setError`: the receiver declining a file it was offered is the
          // share working, and the red banner is for things going wrong.
          onCancel: (index) => {
            statusReceiverRef.current = receiver;
            setStatus(`Cancelled ${nameAt(current, index)} for Receiver ${receiver}.`);
            patch(index, { state: 'cancelled' });
          },
          onError: (index, message) => {
            statusReceiverRef.current = receiver;
            setError(message);
            setStatus(`Could not send ${nameAt(current, index)} to Receiver ${receiver}.`);
            patch(index, { state: 'failed' });
          },
          onDisconnect: (reason) => {
            liveReceiversRef.current.delete(receiver);
            setReceivers(liveReceiversRef.current.size);
            setRows((previous) => previous.filter((row) => row.receiver !== receiver));
            if (statusReceiverRef.current !== receiver) return;
            statusReceiverRef.current = null;
            setStatus(
              reason === 'remote' || reason === 'local'
                ? `Receiver ${receiver} left.`
                : `The connection to Receiver ${receiver} failed.`,
            );
          },
        };

        const engine = new SenderSession(channel, key, current, options);
        enginesRef.current.add(engine);
        void engine
          .run()
          .catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : 'The transfer failed.');
          })
          .finally(() => {
            enginesRef.current.delete(engine);
          });
      });

      setToken(encodeShare(minted));
      setPhase('serving');
    },
    // `chosen` is a parameter so each room-id retry gets what the user is
    // looking at, not a stale closure; `selection` stays a dep to keep the two
    // in step.
    [forgetShare, selection, teardown],
  );

  const onCreate = async (): Promise<void> => {
    const current = picked;
    if (current.length === 0 || creatingRef.current) return;
    creatingRef.current = true;
    setBusy(true);
    setError(null);
    statusReceiverRef.current = null;
    setStatus('');
    try {
      for (let attempt = 1; attempt <= MAX_ROOM_ID_ATTEMPTS; attempt += 1) {
        try {
          await host(current, selection);
          return;
        } catch (cause) {
          if (!isRoomIdCollision(cause) || attempt === MAX_ROOM_ID_ATTEMPTS) throw cause;
        }
      }
    } catch (cause) {
      teardown();
      forgetShare();
      setToken('');
      setError(cause instanceof Error ? cause.message : 'Could not start sharing.');
      setPhase('failed');
    } finally {
      creatingRef.current = false;
      setBusy(false);
    }
  };

  const copy = async (value: string, what: string): Promise<void> => {
    if (value === '') return;
    try {
      await navigator.clipboard.writeText(value);
      statusReceiverRef.current = null;
      setStatus(`${what} copied to the clipboard.`);
    } catch {
      setError('Could not copy to the clipboard. Select the text and copy it manually.');
    }
  };

  const onStop = (): void => {
    teardown();
    setToken('');
    forgetShare();
    setError(null);
    setPhase(picked.length === 0 ? 'idle' : 'ready');
  };

  const onTryAgain = (): void => {
    setError(null);
    setPhase(picked.length === 0 ? 'idle' : 'ready');
  };

  const total = picked.reduce((sum, file) => sum + BigInt(file.size), 0n);
  const link = token === '' ? '' : buildShareLink(token);

  const selected = (
    <>
      <ul className="file-list">
        {picked.map((file, index) => (
          <li key={fileKey(file, index)} className="file-row">
            <span className="grow">{file.name}</span>
            <span className="muted">{formatBytes(BigInt(file.size))}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">
        {picked.length} {picked.length === 1 ? 'file' : 'files'} · {formatBytes(total)} in total
      </p>
    </>
  );

  return (
    <div className="card stack">
      {phase === 'idle' && (
        <div className="stack">
          <p className="muted">
            Choose one or more files. They travel straight to the other person, encrypted on the
            way, and they can pick which ones to take.
          </p>
          <input
            type="file"
            multiple
            aria-label="Choose files to share"
            onChange={(event) => onPick([...(event.target.files ?? [])])}
          />
        </div>
      )}

      {phase === 'ready' && (
        <div className="stack">
          {selected}
          {turn !== null ? (
            <p className="muted small">
              This build names its own relay with VITE_TURN_URL, so the relays in the table are
              not used for the connection and there is nothing to choose here. STUN is still used,
              so a direct address can still be found. The token still names{' '}
              {nameOf(selection.relay)} as the relay, which only reaches a receiver running a build
              without that override.
            </p>
          ) : (
            <>
              {!isDefaultSelection(selection) && (
                <div className="row between small">
                  <span className="muted">Not the default: {describeSelection(selection)}.</span>
                  <button type="button" className="secondary" onClick={onResetSelection}>
                    Reset to default
                  </button>
                </div>
              )}
              <details className="advanced">
                <summary>Connection servers</summary>
                <div className="stack">
                  <p className="muted small">
                    A direct connection is always tried first. These servers help when there is
                    not one: STUN finds your public address, and a relay carries the traffic when
                    no direct path exists. Only the relay you designate is named in the share
                    link, and that is all that travels: unless the receiving build names its own
                    relay, it gathers from all three servers by default plus the one you
                    designate, so switching anything off here changes what this browser tries
                    and nothing about what the receiver tries. The designated relay always stays
                    on; every other entry is optional.
                  </p>
                  <div className="server-list" style={SERVER_ROW_COUNT}>
                    {ICE_SERVERS.map((entry, index) => (
                      <div key={entry.name} className="row between server-row">
                        <label className="grow">
                          <input
                            type="checkbox"
                            checked={selection.enabled.includes(index)}
                            disabled={index === selection.relay}
                            onChange={(event) => onToggle(index, event.target.checked)}
                          />{' '}
                          {entry.name}
                        </label>
                      </div>
                    ))}
                    <div
                      className="server-relays"
                      role="radiogroup"
                      aria-label="Designate the relay that carries the transfer"
                    >
                      {ICE_SERVERS.map((entry, index) => (
                        <div key={entry.name} className="row between server-row muted small">
                          <label>
                            <input
                              type="radio"
                              name="p2fs-relay"
                              checked={selection.relay === index}
                              disabled={!entry.relay}
                              aria-label={`Designate ${entry.name} as the relay`}
                              onChange={() => onDesignate(index)}
                            />{' '}
                            relay
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                  {!hasDiscovery(selection) && (
                    <p className="muted small">
                      No address-lookup server is enabled, so a direct connection is unlikely and
                      the relay will carry the transfer.
                    </p>
                  )}
                </div>
              </details>
            </>
          )}
          <div className="row">
            <button type="button" onClick={() => void onCreate()} disabled={busy}>
              {busy ? 'Starting...' : 'Create share token'}
            </button>
            <button type="button" className="secondary" onClick={() => onPick([])}>
              Choose different files
            </button>
          </div>
        </div>
      )}

      {phase === 'serving' && (
        <div className="stack">
          {selected}
          <input
            type="text"
            readOnly
            value={token}
            aria-label="Share token"
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="row">
            <button type="button" onClick={() => void copy(token, 'Token')}>
              Copy token
            </button>
            <button type="button" className="secondary" onClick={() => void copy(link, 'Link')}>
              Copy link
            </button>
            <button type="button" className="secondary" onClick={onStop}>
              Stop sharing
            </button>
          </div>
          <p className="muted small" role="status">
            {status}
          </p>
          <p className="muted small">
            Anyone with this token can decrypt every file in the share. It never expires and cannot
            be revoked, so treat holding the token as holding the files. The link keeps the token
            in the address bar, where it is never sent to this app's host.
          </p>

          {receivers === 0 ? (
            <p className="muted small">Waiting for a receiver...</p>
          ) : rows.length === 0 ? (
            <p className="muted small">
              {receivers} {receivers === 1 ? 'receiver is' : 'receivers are'} looking at the file
              list...
            </p>
          ) : (
            <ul className="file-list">
              {rows.map((row) => (
                <li key={rowKey(row)} className="file-row transfer">
                  <div className="row">
                    <span className="grow">
                      Receiver {row.receiver} · {row.name}
                    </span>
                    <span className="muted">{describeRow(row)}</span>
                  </div>
                  <progress
                    value={rowPercent(row)}
                    max={100}
                    aria-label={`Receiver ${row.receiver}: ${row.name}`}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {phase === 'failed' && (
        <div className="stack">
          {selected}
          <div className="row">
            <button type="button" onClick={onTryAgain}>
              Try again
            </button>
            <button type="button" className="secondary" onClick={() => onPick([])}>
              Choose different files
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function rowPercent(row: Row): number {
  if (row.total === 0n) return 100;
  return Number((row.sent * 100n) / row.total);
}

function describeRow(row: Row): string {
  if (row.state === 'delivered') return 'delivered.';
  if (row.state === 'failed') return 'failed.';
  // Not a percentage, and not zeroed either: the bytes really did go out, and
  // the text is what says the file was skipped rather than that it finished.
  if (row.state === 'cancelled') return 'cancelled.';
  if (row.total === 0n) return '100%';
  const elapsed = Math.max(0.001, (Date.now() - row.startedAt) / 1000);
  return `${rowPercent(row)}% · ${formatRate(Number(row.sent) / elapsed)}`;
}
