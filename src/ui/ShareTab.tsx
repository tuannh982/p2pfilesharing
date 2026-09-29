import { useCallback, useEffect, useRef, useState } from 'react';
import { importRawKey } from '../crypto/keys';
import { manifestFromFiles, validateManifest } from '../protocol/manifest';
import { SenderSession, type SenderSessionOptions } from '../protocol/session';
import { ConnectionFailedError, PeerSession } from '../transport/peerjs';
import { encodeShare } from '../token/codec';
import { mintSharePayload } from '../token/mint';
import { formatBytes, formatRate } from './format';
import { buildShareLink } from './shareLink';

type Phase = 'idle' | 'ready' | 'serving' | 'failed';

type RowState = 'sending' | 'delivered' | 'failed';

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

  const sessionRef = useRef<PeerSession | null>(null);
  const enginesRef = useRef<Set<SenderSession>>(new Set());
  const mountedRef = useRef(true);
  const creatingRef = useRef(false);
  const generationRef = useRef(0);
  const receiverCountRef = useRef(0);

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
    receiverCountRef.current = 0;
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

  const host = useCallback(
    async (current: File[]): Promise<void> => {
      const generation = generationRef.current;
      const stale = (): boolean => !mountedRef.current || generationRef.current !== generation;

      const minted = await mintSharePayload();
      if (stale()) return;

      const session = await PeerSession.open(minted.roomId);
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
        const receiver = receiverCountRef.current + 1;
        receiverCountRef.current = receiver;
        setReceivers(receiver);
        setError(null);

        const patch = (index: number, change: Partial<Row>): void =>
          setRows((previous) =>
            previous.map((row) =>
              row.receiver === receiver && row.index === index ? { ...row, ...change } : row,
            ),
          );

        const options: SenderSessionOptions = {
          onTransferStart: (index, file) => {
            setStatus(`Receiver ${receiver} is sending ${file.name}.`);
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
            setStatus(`Receiver ${receiver} delivered ${nameAt(current, index)}.`);
            patch(index, { state: 'delivered' });
          },
          onError: (index, message) => {
            setError(message);
            setStatus(`Receiver ${receiver} could not send ${nameAt(current, index)}.`);
            patch(index, { state: 'failed' });
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
    [forgetShare, teardown],
  );

  const onCreate = async (): Promise<void> => {
    const current = picked;
    if (current.length === 0 || creatingRef.current) return;
    creatingRef.current = true;
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      for (let attempt = 1; attempt <= MAX_ROOM_ID_ATTEMPTS; attempt += 1) {
        try {
          await host(current);
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
            <p className="muted small">Receiver {receivers} is looking at the file list...</p>
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
  if (row.total === 0n) return '100%';
  const elapsed = Math.max(0.001, (Date.now() - row.startedAt) / 1000);
  return `${rowPercent(row)}% · ${formatRate(Number(row.sent) / elapsed)}`;
}
