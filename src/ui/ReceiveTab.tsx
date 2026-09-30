import { useCallback, useEffect, useRef, useState } from 'react';
import { importRawKey } from '../crypto/keys';
import type { ManifestEntry } from '../protocol/manifest';
import { ProtocolError } from '../protocol/messages';
import { ReceiverSession } from '../protocol/session';
import { DEFAULT_STALL_TIMEOUT_MS, TransferCancelledError } from '../protocol/transfer';
import { usesFilePicker } from '../config/download';
import { BlobSink, needsBufferedFallback } from '../sink/blob';
import { FileSink, isFileSystemAccessSupported } from '../sink/file';
import type { Sink } from '../sink/sink';
import { PeerSession, type JoinResult, type PeerChannel } from '../transport/peerjs';
import { decodeShare, TokenError } from '../token/codec';
import { formatBytes, formatDuration, formatRate } from './format';
import { readTokenFromFragment, shareTokenFrom } from './shareLink';
import { DownloadQueue } from './downloadQueue';
import { chooseRelay } from './relayChoice';

type Phase = 'idle' | 'connecting' | 'listing';

type RowState = 'waiting' | 'queued' | 'downloading' | 'saved' | 'cancelled' | 'failed';

interface Row {
  index: number;
  name: string;
  size: bigint;
  received: bigint;
  state: RowState;
}

const UNREADABLE_TOKEN = 'That share token could not be read. Please check it and try again.';

const NO_TOKEN = 'Paste a share token or a share link to see what is being shared.';

const MEMORY_WARNING =
  'This browser cannot stream to disk, so the file is held in memory. It may be slow for very large files.';

const SENDER_LEFT = 'The sender disconnected, so no more files can be taken.';

const SAVED_TO_DISK = 'Saved to disk.';

const DOWNLOAD_STARTED = 'Download started.';

const isPickerCancelled = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === 'AbortError';

const describeCause = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message !== '' ? cause.message : fallback;

const readClipboard = async (
  setInput: (value: string) => void,
  setError: (value: string | null) => void,
): Promise<void> => {
  try {
    setInput(await navigator.clipboard.readText());
  } catch {
    setError('Could not read the clipboard. Paste the token manually.');
  }
};

const STATE_TEXT: Record<RowState, string> = {
  waiting: '',
  queued: 'Queued',
  downloading: 'Downloading',
  saved: 'Saved',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

const rowPercent = (row: Row): number =>
  row.size === 0n ? 100 : Number((row.received * 100n) / row.size);

const progressText = (row: Row, startedAt: number): string => {
  if (row.size === 0n) return `${formatBytes(row.size)} · nothing to transfer`;
  if (row.received === 0n) return `${formatBytes(row.size)} · waiting for data`;
  const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const rate = Number(row.received) / elapsed;
  const remaining = Math.max(0, Number(row.size - row.received) / Math.max(1, rate));
  return `${rowPercent(row)}% · ${formatBytes(row.received)} of ${formatBytes(row.size)} · ${formatRate(rate)} · ${formatDuration(remaining)} left`;
};

export function ReceiveTab() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [input, setInput] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [menuIndex, setMenuIndex] = useState<number | null>(null);
  const [queued, setQueued] = useState<readonly number[]>([]);
  const canStreamToDisk = usesFilePicker() && isFileSystemAccessSupported();
  const [dead, setDead] = useState(false);

  const sessionRef = useRef<PeerSession | null>(null);
  const channelRef = useRef<PeerChannel | null>(null);
  const receiverRef = useRef<ReceiverSession | null>(null);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const startedAtRef = useRef(0);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const queueRef = useRef<DownloadQueue>(new DownloadQueue());
  const pumpingRef = useRef(false);
  const deadRef = useRef(false);
  // The handle on the file in flight, which is the only thing that can stop it:
  // the index has already left the queue, so there is nothing left to cancel
  // there, and the session has no handle of its own. Carrying the index beside
  // the controller is what tells an abort of the file in flight from a cancel
  // of one still waiting in the queue, which the two share a button for.
  const inflightRef = useRef<{ index: number; controller: AbortController } | null>(null);

  // Anything still queued can never run once the connection is gone, so a row
  // left claiming to be queued is one the user can neither cancel (it has
  // already left the queue, so `cancel` refuses) nor clear (it is no longer in
  // `pending`), and it keeps `Done` disabled. Dropping the queue and resetting
  // those rows together is what makes "no row is queued" hold from then on.
  const dropQueuedRows = useCallback((): void => {
    queueRef.current.clear();
    setQueued([]);
    setRows((previous) =>
      previous.map((row) =>
        row.state === 'queued' ? { ...row, state: 'waiting', received: 0n } : row,
      ),
    );
  }, []);

  const teardown = useCallback((): void => {
    generationRef.current += 1;
    receiverRef.current?.abort();
    receiverRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    busyRef.current = false;
    dropQueuedRows();
    pumpingRef.current = false;
    deadRef.current = false;
  }, [dropQueuedRows]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [teardown]);

  useEffect(() => {
    const fromFragment = readTokenFromFragment(window.location.href);
    if (fromFragment === '') return;
    setInput(fromFragment);
    void onConnect(fromFragment);
    // Connecting straight away is the point of following a share link; the
    // token is in the fragment, so there is nothing left for the user to do.
  }, []);

  const startOver = useCallback((): void => {
    teardown();
    setPhase('idle');
    setRows([]);
    setBusyIndex(null);
    setMenuIndex(null);
    setDead(false);
    setNotice(null);
    setStatus(null);
    setError(null);
  }, [teardown]);

  const patch = useCallback((index: number, change: Partial<Row>): void => {
    setRows((previous) =>
      previous.map((row) => (row.index === index ? { ...row, ...change } : row)),
    );
  }, []);

  const openSink = useCallback(async (entry: ManifestEntry): Promise<Sink> => {
    if (canStreamToDisk) return FileSink.open(entry.name);
    const sink = new BlobSink(entry.name);
    if (needsBufferedFallback(entry.size)) setNotice(MEMORY_WARNING);
    return sink;
  }, [canStreamToDisk]);

  const onConnect = async (token?: string): Promise<void> => {
    teardown();
    setError(null);
    setStatus(null);
    setNotice(null);
    setRows([]);
    setBusyIndex(null);
    setMenuIndex(null);
    setDead(false);

    const generation = generationRef.current;
    const stale = (): boolean => !mountedRef.current || generationRef.current !== generation;

    let roomId: string;
    let key: CryptoKey;
    let relay: number;
    try {
      const candidate = token ?? shareTokenFrom(input);
      if (candidate === '') {
        setError(NO_TOKEN);
        return;
      }
      const payload = decodeShare(candidate);
      roomId = payload.roomId;
      key = await importRawKey(payload.key);
      relay = chooseRelay(payload.relay);
    } catch (cause) {
      if (stale()) return;
      setError(cause instanceof TokenError ? cause.message : UNREADABLE_TOKEN);
      return;
    }

    setPhase('connecting');

    let joined: JoinResult;
    try {
      joined = await PeerSession.join(roomId, relay);
    } catch (cause) {
      if (stale()) return;
      setError(describeCause(cause, 'Could not connect to the sender.'));
      setPhase('idle');
      return;
    }
    if (stale()) {
      joined.session.close();
      return;
    }
    sessionRef.current = joined.session;
    channelRef.current = joined.channel;

    const receiver = new ReceiverSession(joined.channel, key, {
      stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
      openSink,
      onManifest: (entries) => {
        if (stale()) return;
        setRows(
          entries.map((entry, index) => ({
            index,
            name: entry.name,
            size: entry.size,
            received: 0n,
            state: 'waiting',
          })),
        );
        setPhase('listing');
      },
      onProgress: (index, received) => patch(index, { received }),
      onComplete: (index) => {
        patch(index, { state: 'saved' });
        setStatus(canStreamToDisk ? SAVED_TO_DISK : DOWNLOAD_STARTED);
      },
      onDisconnect: (reason) => {
        if (stale()) return;
        setDead(true);
        deadRef.current = true;
        setMenuIndex(null);
        dropQueuedRows();
        setStatus(SENDER_LEFT);
        if (reason === 'error' || reason === 'transport-failure') {
          setError('The connection to the sender failed.');
        }
      },
    });
    receiverRef.current = receiver;

    try {
      await receiver.run();
    } catch (cause) {
      if (stale()) return;
      teardown();
      setError(describeCause(cause, 'The connection failed before the file list arrived.'));
      setPhase('idle');
    }
  };

  // One file at a time, because the protocol serves one `select` at a time. The
  // latch is set before the first await and cleared in the `finally`, so two
  // clicks in the same tick cannot start two loops over one queue.
  const runOne = async (index: number): Promise<boolean> => {
    const receiver = receiverRef.current;
    // No receiver means the session is gone, so this index cannot run and must
    // not be reported as drained: the row is still `queued` and only the
    // invariant that nothing is queued once we are dead keeps that honest.
    if (receiver === null) return false;
    // A row that is not in the list has no state to strand, so the rest of the
    // queue can still be served.
    const row = rows.find((candidate) => candidate.index === index);
    if (row === undefined) return true;

    busyRef.current = true;
    setBusyIndex(index);
    // Only this row's own menu closes here. A menu belongs to the row that
    // opened it, so another file starting or finishing must not close it.
    setMenuIndex((open) => (open === index ? null : open));
    setError(null);
    patch(index, { state: 'downloading', received: 0n });
    startedAtRef.current = Date.now();

    // One controller per file, so the handle a cancel reaches is never one left
    // over from the file before.
    const controller = new AbortController();
    inflightRef.current = { index, controller };

    try {
      await receiver.select(index, controller.signal);
      if (mountedRef.current) {
        patch(index, { state: 'saved' });
        setStatus(canStreamToDisk ? SAVED_TO_DISK : DOWNLOAD_STARTED);
      }
      return true;
    } catch (cause) {
      if (isPickerCancelled(cause)) {
        if (mountedRef.current) patch(index, { state: 'waiting', received: 0n });
        return true;
      }
      // Asked for, so it is neither a failure nor a reason to stop the share.
      // `TransferCancelledError` is not a `ProtocolError`, so without this it
      // would fall through to a failed row and a red banner, which is the one
      // thing the user did not ask for. `true` keeps the pump draining.
      if (cause instanceof TransferCancelledError) {
        if (mountedRef.current) {
          patch(index, { state: 'cancelled' });
          setStatus(`Skipped ${row.name}.`);
        }
        return true;
      }
      if (!mountedRef.current) return false;
      patch(index, { state: 'failed' });
      setError(`${row.name}: ${describeCause(cause, 'The transfer failed.')}`);
      if (cause instanceof ProtocolError) {
        teardown();
        setDead(true);
        deadRef.current = true;
        return false;
      }
      return true;
    } finally {
      busyRef.current = false;
      if (inflightRef.current?.controller === controller) inflightRef.current = null;
      if (mountedRef.current) setBusyIndex(null);
    }
  };

  const pump = async (): Promise<void> => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      for (;;) {
        // Checked before the dequeue, not after: taking an index off the queue
        // and then abandoning it here would strand its row as `queued` with
        // nothing left in the queue to run or clear it.
        if (deadRef.current) return;
        const next = queueRef.current.dequeue();
        if (next === null) return;
        setQueued(queueRef.current.pending());
        if (!(await runOne(next))) return;
      }
    } finally {
      pumpingRef.current = false;
      setQueued(queueRef.current.pending());
    }
  };

  const onDownload = (index: number): void => {
    if (deadRef.current) return;
    if (!queueRef.current.enqueue(index)) return;
    patch(index, { state: 'queued' });
    setQueued(queueRef.current.pending());
    void pump();
  };

  const onCancelQueued = (index: number): void => {
    // The file in flight is not in the queue, so `cancel` would refuse it and
    // the row would be left claiming to be downloading for good. Aborting the
    // handle instead is what actually stops it: the engine turns that into the
    // cancel it sends, which is what `runOne` above turns back into the
    // cancelled state.
    const inflight = inflightRef.current;
    if (inflight !== null && inflight.index === index) {
      // Between the peer leaving and the engine noticing, this row still reads
      // as downloading and still offers the control. Nothing would break -- the
      // share is already over either way -- but "Skipped" would be a lie about
      // a transfer the peer abandoned.
      if (deadRef.current === true) return;
      inflight.controller.abort();
      return;
    }
    queueRef.current.cancel(index);
    setQueued(queueRef.current.pending());
    patch(index, { state: 'waiting', received: 0n });
  };

  const onClearQueue = (): void => {
    // Defensive only: `dequeue` removes the file in flight before `runOne` is
    // called, so it is never in `pending()` and this cannot skip it today. The
    // real trap is `queueRows`, which counts the downloading row, so `Clear all`
    // is live while a transfer runs and only this loop may not touch that row.
    const inFlight = busyRef.current ? rows.find((row) => row.state === 'downloading') : undefined;
    for (const index of queueRef.current.pending()) {
      if (index === inFlight?.index) continue;
      patch(index, { state: 'waiting', received: 0n });
    }
    queueRef.current.clear();
    setQueued([]);
  };

  const onDone = async (): Promise<void> => {
    if (doneRef.current) return;
    doneRef.current = true;
    const receiver = receiverRef.current;
    if (receiver !== null) {
      try {
        await receiver.finish();
      } catch {}
    }
    doneRef.current = false;
    startOver();
    setStatus('Done. The share is closed.');
  };

  const onCancel = (): void => {
    startOver();
  };

  const saved = rows.some((row) => row.state === 'saved');

  // The panel counts what is still to be fetched, and the file in flight with
  // it: the in-flight row has already left the queue but is still work.
  const queueRows = rows.filter((row) => row.state === 'queued' || row.state === 'downloading');

  return (
    <div className="card stack">
      {phase === 'idle' && (
        <div className="stack">
          <p className="muted">
            Paste a share token or link. The sender lists every file in the share, and you choose
            which ones to take.
          </p>
          <textarea
            rows={3}
            value={input}
            aria-label="Share token"
            placeholder="p2fs1..."
            onChange={(event) => setInput(event.target.value)}
          />
          <div className="row">
            <button type="button" onClick={() => void onConnect()}>
              Connect
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void readClipboard(setInput, setError)}
            >
              Paste
            </button>
          </div>
        </div>
      )}

      {phase === 'connecting' && (
        <div className="stack">
          <p className="muted">Connecting and asking for the file list...</p>
          <div className="row">
            <button type="button" className="secondary" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'listing' && (
        <div className="stack">
          <p className="muted small">
            {rows.length} {rows.length === 1 ? 'file is' : 'files are'} on offer. Queue the ones
            you want and they will be taken one at a time.
          </p>
          <ul className="file-list">
            {rows.map((row) => (
              <li key={row.index} className="file-row transfer">
                <div className="row between">
                  <span className="grow">{row.name}</span>
                  <span className="muted">{formatBytes(row.size)}</span>
                  <button
                    type="button"
                    className="menu"
                    aria-label={`More actions for ${row.name}`}
                    aria-haspopup="menu"
                    disabled={
                      dead || row.state === 'downloading' || row.state === 'queued'
                    }
                    onClick={() => setMenuIndex(menuIndex === row.index ? null : row.index)}
                  >
                    <span aria-hidden="true">&#8942;</span>
                  </button>
                </div>
                {menuIndex === row.index && (
                  <div role="menu" className="menu-panel">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuIndex(null);
                        onDownload(row.index);
                      }}
                    >
                      Download
                    </button>
                  </div>
                )}
                {row.state === 'downloading' && (
                  <>
                    <progress
                      value={rowPercent(row)}
                      max={100}
                      aria-label={`Downloading ${row.name}`}
                    />
                    <span className="muted small">
                      {progressText(row, startedAtRef.current)}
                    </span>
                  </>
                )}
                {row.state !== 'waiting' && row.state !== 'saved' && (
                  <span className={row.state === 'failed' ? 'error small' : 'muted small'}>
                    {STATE_TEXT[row.state]}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <section className="queue" aria-label="Download queue">
            <div className="row between">
              <h2 className="queue-title">
                Queue ({queueRows.length} {queueRows.length === 1 ? 'file' : 'files'})
              </h2>
              <button
                type="button"
                className="secondary"
                onClick={onClearQueue}
                disabled={queueRows.length === 0}
              >
                Clear all
              </button>
            </div>
            {queueRows.length === 0 ? (
              <p className="muted small">Nothing queued yet.</p>
            ) : (
              <ul className="file-list">
                {queueRows.map((row) => (
                  <li key={row.index} className="file-row">
                    <span className="grow">{row.name}</span>
                    <span className="muted">{formatBytes(row.size)}</span>
                    {row.state === 'downloading' ? (
                      <span className="muted small">{progressText(row, startedAtRef.current)}</span>
                    ) : (
                      <span className="muted small">{STATE_TEXT[row.state]}</span>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      aria-label={
                        row.state === 'downloading'
                          ? `Skip ${row.name}`
                          : `Remove ${row.name} from queue`
                      }
                      onClick={() => onCancelQueued(row.index)}
                    >
                      <span aria-hidden="true">&times;</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {dead && status === null && (
            <p className="muted small">
              The connection is closed, so no more files can be taken from this share.
            </p>
          )}
          <div className="row">
            <button
              type="button"
              className="secondary"
              onClick={() => void onDone()}
              disabled={busyIndex !== null || queued.length > 0}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {status !== null && (
        <p className={saved ? 'ok' : 'muted small'} role="status">
          {status}
        </p>
      )}

      {notice !== null && <p className="muted small">{notice}</p>}
    </div>
  );
}
