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
  onCancel?: (index: number) => void;
  onError?: (index: number, message: string) => void;
  onDisconnect?: (reason: CloseReason) => void;
}

const SHARE_ENDED = 'The share is over, so it cannot be used any further.';
const CLOSED_BEFORE_START =
  'The connection closed before the file could start.';

// The frames the session itself acts on, as against the ones a running engine
// is waiting for. The filter below exists so a transfer's own frames do not
// pile up in the session's queue while an engine has them. A cancel is not
// named here because it never reaches this filter -- cancelFor above settles
// every one of them -- but a cancelled can, from a peer that owes it to nobody,
// and ending the share over it would undo the skip the peer asked for.
const isSessionControl = (msg: ChannelMessage): boolean => {
  if (typeof msg !== 'string') return false;
  try {
    const tag = (JSON.parse(msg) as { t?: unknown }).t;
    return tag === 'select' || tag === 'finish' || tag === 'cancelled';
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
  private serving: { index: number; controller: AbortController; cancelled: boolean } | null = null;

  constructor(
    private readonly channel: Channel,
    private readonly key: CryptoKey,
    private readonly files: File[],
    private readonly options: SenderSessionOptions = {},
  ) {
    this.channel.onMessage((msg) => {
      if (this.stopped) return;
      if (this.cancelFor(msg)) return;
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
    this.channel.onClose((reason) => {
      this.closed = true;
      this.wake();
      if (this.stopped) return;
      this.options.onDisconnect?.(reason);
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

  // A cancel names the file in flight and arrives while busy, which is exactly
  // when the filter above drops every frame that is not a select or a finish.
  // Intercepting it here is the only way it survives. Parsed leniently, because
  // a frame that is not a cancel must not become one, and taken for every
  // cancel whether or not one is in flight: a cancel for a file that has
  // already finished is stale, and queueing it would abort whichever file the
  // peer asks for next.
  private cancelFor(msg: ChannelMessage): boolean {
    if (typeof msg !== 'string') return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;
    const control = parsed as { t?: unknown; index?: unknown };
    if (control.t !== 'cancel') return false;
    const serving = this.serving;
    if (serving === null || control.index !== serving.index + FIRST_FILE_INDEX) return true;
    serving.cancelled = true;
    serving.controller.abort();
    return true;
  }

  // The receiver drains the frames this sender had already put on the wire, on
  // a deadline, and past it the next file fails. So the last of this file's
  // frames has to be said out loud, and said here: after everything the engine
  // sent for this index and before the loop serves the next select, because the
  // receiver stops discarding at this frame and anything after it lands on the
  // next file's engine.
  private answerCancel(index: number): void {
    if (!this.closed) {
      try {
        this.channel.send(serializeControl({ t: 'cancelled', index: index + FIRST_FILE_INDEX }));
      } catch {}
    }
    this.options.onCancel?.(index);
  }

  private async serve(index: number, signal?: AbortSignal): Promise<void> {
    const file = this.files[index];
    if (file === undefined) {
      throw new ProtocolError(`The receiver asked for file ${index + 1}, which is not in this share.`);
    }
    this.options.onTransferStart?.(index, file);
    this.busy = true;
    const controller = new AbortController();
    const serving = { index, controller, cancelled: false };
    this.serving = serving;
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const engine = new SenderEngine(this.channel, file, this.key, {
      fileIndex: index + FIRST_FILE_INDEX,
      pollIntervalMs: this.options.pollIntervalMs,
      stallTimeoutMs: this.options.stallTimeoutMs,
      onProgress: (sent, total) => this.options.onProgress?.(index, sent, total),
    });
    this.engine = engine;
    try {
      await engine.run(controller.signal);
      // The engine only reaches 'completed' when the receiver's done
      // acknowledgement actually arrived, so this is the only case that is a
      // delivery. Everything else it can return on — a peer that left, an abort,
      // a signal — is not a completed file.
      if (serving.cancelled) {
        this.answerCancel(index);
        return;
      }
      if (engine.state !== 'completed') return;
      this.options.onComplete?.(index);
    } catch (cause) {
      // A backstop, and a load-bearing one. Most of the time the abort above
      // settles the engine's wait before anything throws. Not always: a stall
      // or a failure the receiver reported is raised before the engine gets to
      // its own abort check, so it throws with serving.cancelled already true.
      // Reporting that would put a red banner on the sender's row for a file
      // the receiver chose to skip, and with it no terminator -- which would
      // leave the receiver's drain to time out and the next file to die on
      // leftovers. A skip is never a failure.
      if (serving.cancelled) {
        this.answerCancel(index);
        return;
      }
      // A channel that closed under the transfer is not a transfer error, so
      // the departure is reported once, by the close handler. A failure on a
      // connection that is still open is a real one and must reach the caller.
      if (!this.closed && !this.halted(signal)) {
        this.options.onError?.(
          index,
          cause instanceof Error ? cause.message : 'The transfer failed.',
        );
      }
      throw cause;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.serving = null;
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
        // A cancelled is the receiver's own frame to send, never one to
        // receive, so there is nothing to do with one but let it pass. Ending
        // the share over it would undo a skip the receiver asked for. A cancel
        // cannot reach here: cancelFor consumes every one of them, whatever it
        // names, before they get this far.
        if (control.t === 'cancelled') continue;
        if (control.t !== 'select') {
          throw new ProtocolError(`Expected a select or a finish but received "${control.t}".`);
        }
        await this.serve(control.index - FIRST_FILE_INDEX, signal);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.stopped = true;
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
  // Settles when the last file's engine has read away whatever the sender had
  // already sent for it. See select.
  private discard: Promise<void> = Promise.resolve();

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

  async select(index: number, signal?: AbortSignal): Promise<void> {
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
    // A cancelled file leaves the frames the sender had already put on the wire
    // still coming, and a channel hands every frame to every subscriber: an
    // engine subscribed now would queue chunks of a file it was never offered
    // and read the first as its offer, ending the share. The ask is what waits,
    // because nothing can arrive for this file until the sender is asked.
    await this.discard;
    if (this.stopped) {
      throw new ProtocolError(SHARE_ENDED);
    }
    if (this.closed) {
      throw new ProtocolError(this.closeMessage ?? CLOSED_BEFORE_START);
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
    this.discard = engine.released;
    await engine.run(signal);
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
