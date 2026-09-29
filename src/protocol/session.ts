import type { Sink } from '../sink/sink';
import type { Channel, ChannelMessage, CloseReason } from '../transport/channel';
import {
  FIRST_FILE_INDEX,
  decryptManifest,
  encryptManifest,
  manifestFromFiles,
  type ManifestEntry,
} from './manifest';
import { parseControl, ProtocolError, serializeControl } from './messages';
import { CLOSE_MESSAGES, ReceiverEngine, SenderEngine } from './transfer';

export interface SenderSessionOptions {
  pollIntervalMs?: number;
  stallTimeoutMs?: number;
  onTransferStart?: (index: number, file: File) => void;
  onProgress?: (index: number, sent: bigint, total: bigint) => void;
  onComplete?: (index: number) => void;
  onError?: (index: number, message: string) => void;
}

const SHARE_ENDED = 'The share is over, so it cannot be used any further.';
const CLOSED_BEFORE_START =
  'The connection closed before the file could start.';

const isSessionControl = (msg: ChannelMessage): boolean => {
  if (typeof msg !== 'string') return false;
  try {
    const tag = (JSON.parse(msg) as { t?: unknown }).t;
    return tag === 'select' || tag === 'finish';
  } catch {
    return false;
  }
};

export class SenderSession {
  private readonly pending: ChannelMessage[] = [];
  private waiter: ((msg: ChannelMessage | null) => void) | null = null;
  private closed = false;
  private busy = false;
  private running = false;
  private stopped = false;
  private engine: SenderEngine | null = null;

  constructor(
    private readonly channel: Channel,
    private readonly key: CryptoKey,
    private readonly files: File[],
    private readonly options: SenderSessionOptions = {},
  ) {
    this.channel.onMessage((msg) => {
      if (this.stopped) return;
      if (this.busy) {
        if (isSessionControl(msg)) this.pending.push(msg);
        return;
      }
      const waiter = this.waiter;
      if (waiter === null) {
        this.pending.push(msg);
        return;
      }
      this.waiter = null;
      waiter(msg);
    });
    this.channel.onClose(() => {
      this.closed = true;
      this.wake();
    });
  }

  abort(): void {
    this.stopped = true;
    this.engine?.abort();
    this.channel.close();
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    if (waiter === null) return;
    this.waiter = null;
    waiter(null);
  }

  private next(): Promise<ChannelMessage | null> {
    if (this.stopped) return Promise.resolve(null);
    const queued = this.pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private halted(signal?: AbortSignal): boolean {
    return this.stopped || signal?.aborted === true;
  }

  private async serve(index: number, signal?: AbortSignal): Promise<void> {
    const file = this.files[index];
    if (file === undefined) {
      throw new ProtocolError(`The receiver asked for file ${index + 1}, which is not in this share.`);
    }
    this.options.onTransferStart?.(index, file);
    this.busy = true;
    const engine = new SenderEngine(this.channel, file, this.key, {
      fileIndex: index + FIRST_FILE_INDEX,
      pollIntervalMs: this.options.pollIntervalMs,
      stallTimeoutMs: this.options.stallTimeoutMs,
      onProgress: (sent, total) => this.options.onProgress?.(index, sent, total),
    });
    this.engine = engine;
    try {
      await engine.run(signal);
      this.options.onComplete?.(index);
    } catch (cause) {
      this.options.onError?.(
        index,
        cause instanceof Error ? cause.message : 'The transfer failed.',
      );
      throw cause;
    } finally {
      this.engine = null;
      this.busy = false;
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) {
      throw new ProtocolError('SenderSession.run may only be called once.');
    }
    if (this.files.length === 0) {
      throw new ProtocolError('A share must contain at least one file.');
    }
    this.running = true;
    const onAbort = (): void => this.wake();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (this.halted(signal)) return;
      this.channel.send(await encryptManifest(this.key, manifestFromFiles(this.files)));
      if (this.stopped) return;

      for (;;) {
        if (this.halted(signal)) return;
        const msg = await this.next();
        if (msg === null) return;
        if (this.stopped) return;
        if (typeof msg !== 'string') {
          throw new ProtocolError('Expected a select or a finish but received file data.');
        }
        const control = parseControl(msg);
        if (control.t === 'finish') return;
        if (control.t !== 'select') {
          throw new ProtocolError(`Expected a select or a finish but received "${control.t}".`);
        }
        await this.serve(control.index - FIRST_FILE_INDEX, signal);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.channel.close();
    }
  }
}

export interface ReceiverSessionOptions {
  stallTimeoutMs?: number;
  openSink: (entry: ManifestEntry) => Promise<Sink>;
  onManifest: (files: ManifestEntry[]) => void;
  onProgress?: (index: number, received: bigint, total: bigint) => void;
  onComplete?: (index: number) => void;
  onDisconnect?: (reason: CloseReason) => void;
}

export class ReceiverSession {
  private readonly pending: ChannelMessage[] = [];
  private waiter: ((msg: ChannelMessage | null) => void) | null = null;
  private manifest: ManifestEntry[] = [];
  private listing = false;
  private listening = false;
  private closed = false;
  private closeMessage: string | null = null;
  private stopped = false;

  constructor(
    private readonly channel: Channel,
    private readonly key: CryptoKey,
    private readonly options: ReceiverSessionOptions,
  ) {
    this.channel.onMessage((msg) => {
      if (this.stopped || !this.listening) return;
      const waiter = this.waiter;
      if (waiter === null) {
        this.pending.push(msg);
        return;
      }
      this.waiter = null;
      waiter(msg);
    });
    this.channel.onClose((reason) => {
      this.closed = true;
      if (this.closeMessage !== null) return;
      this.closeMessage = CLOSE_MESSAGES[reason];
      this.wake();
      if (!this.stopped) this.options.onDisconnect?.(reason);
    });
  }

  get files(): ManifestEntry[] {
    return this.manifest;
  }

  abort(): void {
    this.stopped = true;
    this.channel.close();
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    if (waiter === null) return;
    this.waiter = null;
    waiter(null);
  }

  private next(): Promise<ChannelMessage | null> {
    if (this.stopped) return Promise.resolve(null);
    const queued = this.pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  async run(signal?: AbortSignal): Promise<void> {
    if (this.listing) {
      throw new ProtocolError('ReceiverSession.run may only be called once.');
    }
    this.listing = true;
    this.listening = true;
    const stallMs = this.options.stallTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => this.wake();
    if (stallMs !== undefined) {
      timer = setTimeout(() => this.wake(), stallMs);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const first = await this.next();
      if (first === null) {
        throw new ProtocolError(
          signal?.aborted === true
            ? 'The transfer was cancelled.'
            : 'The sender went quiet before sending the file list, so the connection timed out.',
        );
      }
      if (typeof first === 'string') {
        throw new ProtocolError('Expected the encrypted file list but received a control message.');
      }
      this.manifest = await decryptManifest(this.key, first);
    } catch (cause) {
      this.stopped = true;
      this.channel.close();
      throw cause;
    } finally {
      this.listening = false;
      this.pending.length = 0;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    this.options.onManifest(this.manifest);
  }

  async select(index: number): Promise<void> {
    if (this.manifest.length === 0) {
      throw new ProtocolError('The file list has not arrived yet.');
    }
    if (this.stopped) {
      throw new ProtocolError(SHARE_ENDED);
    }
    if (this.closed) {
      throw new ProtocolError(this.closeMessage ?? CLOSED_BEFORE_START);
    }
    const entry = this.manifest[index];
    if (entry === undefined) {
      throw new ProtocolError(`File ${index + 1} is not in this share.`);
    }
    const sink = await this.options.openSink(entry);
    if (this.closed || this.stopped) {
      sink.abort();
      if (this.stopped) {
        throw new ProtocolError(SHARE_ENDED);
      }
      throw new ProtocolError(this.closeMessage ?? CLOSED_BEFORE_START);
    }
    this.channel.send(serializeControl({ t: 'select', index: index + FIRST_FILE_INDEX }));
    const engine = new ReceiverEngine(this.channel, this.key, entry, sink, {
      fileIndex: index + FIRST_FILE_INDEX,
      stallTimeoutMs: this.options.stallTimeoutMs,
      onProgress: (done) => this.options.onProgress?.(index, done, entry.size),
    });
    await engine.run();
    this.options.onComplete?.(index);
  }

  async finish(): Promise<void> {
    if (this.stopped) {
      throw new ProtocolError(SHARE_ENDED);
    }
    if (this.closed) {
      throw new ProtocolError(this.closeMessage ?? CLOSED_BEFORE_START);
    }
    this.channel.send(serializeControl({ t: 'finish' }));
    this.stopped = true;
  }
}
