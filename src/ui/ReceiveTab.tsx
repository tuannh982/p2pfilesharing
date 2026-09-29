import { useCallback, useEffect, useRef, useState } from 'react';
import { importRawKey } from '../crypto/keys';
import type { ManifestEntry } from '../protocol/manifest';
import { ProtocolError } from '../protocol/messages';
import { ReceiverSession } from '../protocol/session';
import { DEFAULT_STALL_TIMEOUT_MS } from '../protocol/transfer';
import { BlobSink, needsBufferedFallback } from '../sink/blob';
import { FileSink, isFileSystemAccessSupported } from '../sink/file';
import type { Sink } from '../sink/sink';
import { PeerSession, type JoinResult, type PeerChannel } from '../transport/peerjs';
import { decodeShare, TokenError } from '../token/codec';
import { formatBytes, formatDuration, formatRate } from './format';
import { readTokenFromFragment, shareTokenFrom } from './shareLink';

type Phase = 'idle' | 'connecting' | 'listing';

type RowState = 'waiting' | 'downloading' | 'saved' | 'failed';

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
  waiting: 'Waiting',
  downloading: 'Downloading',
  saved: 'Saved',
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
  const canStreamToDisk = isFileSystemAccessSupported();
  const [dead, setDead] = useState(false);

  const sessionRef = useRef<PeerSession | null>(null);
  const channelRef = useRef<PeerChannel | null>(null);
  const receiverRef = useRef<ReceiverSession | null>(null);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const startedAtRef = useRef(0);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const teardown = useCallback((): void => {
    generationRef.current += 1;
    receiverRef.current?.abort();
    receiverRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    busyRef.current = false;
  }, []);

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
    if (isFileSystemAccessSupported()) return FileSink.open(entry.name);
    const sink = new BlobSink(entry.name);
    if (needsBufferedFallback(entry.size)) setNotice(MEMORY_WARNING);
    return sink;
  }, []);

  const onConnect = async (token?: string): Promise<void> => {
    teardown();
    setError(null);
    setStatus(null);
    setNotice(null);
    setRows([]);
    setBusyIndex(null);
    setDead(false);

    const generation = generationRef.current;
    const stale = (): boolean => !mountedRef.current || generationRef.current !== generation;

    let roomId: string;
    let key: CryptoKey;
    try {
      const candidate = token ?? shareTokenFrom(input);
      if (candidate === '') {
        setError(NO_TOKEN);
        return;
      }
      const payload = decodeShare(candidate);
      roomId = payload.roomId;
      key = await importRawKey(payload.key);
    } catch (cause) {
      if (stale()) return;
      setError(cause instanceof TokenError ? cause.message : UNREADABLE_TOKEN);
      return;
    }

    setPhase('connecting');

    let joined: JoinResult;
    try {
      joined = await PeerSession.join(roomId);
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

  const onDownload = async (index: number): Promise<void> => {
    const receiver = receiverRef.current;
    const row = rows.find((candidate) => candidate.index === index);
    if (receiver === null || row === undefined || busyRef.current) return;
    if (row.state === 'downloading') return;

    busyRef.current = true;
    setBusyIndex(index);
    setError(null);
    patch(index, { state: 'downloading', received: 0n });
    startedAtRef.current = Date.now();

    try {
      await receiver.select(index);
      if (mountedRef.current) {
        patch(index, { state: 'saved' });
        setStatus(canStreamToDisk ? SAVED_TO_DISK : DOWNLOAD_STARTED);
      }
    } catch (cause) {
      if (isPickerCancelled(cause)) {
        if (mountedRef.current) patch(index, { state: 'waiting', received: 0n });
        return;
      }
      if (mountedRef.current) {
        patch(index, { state: 'failed' });
        setError(`${row.name}: ${describeCause(cause, 'The transfer failed.')}`);
        if (cause instanceof ProtocolError) {
          teardown();
          setDead(true);
        }
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusyIndex(null);
    }
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
            {rows.length} {rows.length === 1 ? 'file is' : 'files are'} on offer. Download the ones
            you want, one at a time.
          </p>
          <ul className="file-list">
            {rows.map((row) => (
              <li key={row.index} className="file-row transfer">
                <div className="row between">
                  <span className="grow">{row.name}</span>
                  <span className="muted">{formatBytes(row.size)}</span>
                </div>
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
                <div className="row">
                  <button
                    type="button"
                    onClick={() => void onDownload(row.index)}
                    aria-label={
                      row.state === 'saved'
                        ? `Download again ${row.name}`
                        : `Download ${row.name}${row.state === 'failed' ? ' (failed)' : ''}`
                    }
                    disabled={busyIndex !== null || dead || row.state === 'downloading'}
                  >
                    {row.state === 'saved' ? 'Download again' : 'Download'}
                  </button>
                  {row.state !== 'saved' && (
                    <span className={row.state === 'failed' ? 'error small' : 'muted small'}>
                      {STATE_TEXT[row.state]}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
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
              disabled={busyIndex !== null}
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
