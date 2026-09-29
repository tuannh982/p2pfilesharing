import { CHUNK_SIZE, TAG_BYTES, decryptChunk, encryptChunk } from '../crypto/chunks';
import type { Sink } from '../sink/sink';
import { HIGH_WATER_MARK, waitForDrain } from '../transport/backpressure';
import type { Channel, ChannelMessage, CloseReason } from '../transport/channel';
import { parseControl, ProtocolError, serializeControl } from './messages';

export const CLOSE_MESSAGES: Record<CloseReason, string> = {
  local: 'The transfer was cancelled.',
  remote: 'The connection closed before the transfer finished.',
  error: 'The connection to the sender failed mid-transfer.',
  'transport-failure':
    "Couldn't establish a direct connection. Both sides may be behind strict firewalls.",
};

export type SenderState = 'idle' | 'sending' | 'sent' | 'completed' | 'aborted' | 'failed';

export const DEFAULT_STALL_TIMEOUT_MS = 60000;

const fileNameOf = (file: Blob): string => (file instanceof File ? file.name : '');

export class TransferDeclinedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TransferDeclinedError';
  }
}

export class DeliveryUnconfirmedError extends Error {
  constructor() {
    super('The receiver never confirmed the file was written.');
    this.name = 'DeliveryUnconfirmedError';
  }
}

const sinkFailure = (action: string, cause: unknown): string => {
  const detail = cause instanceof Error && cause.message !== '' ? cause.message : 'The write failed.';
  return `The receiver could not ${action}: ${detail}`;
};

const readErrorControl = (msg: ChannelMessage): string | null => {
  if (typeof msg !== 'string') return null;
  try {
    const control = parseControl(msg);
    return control.t === 'error' ? control.message : null;
  } catch {
    return null;
  }
};

export interface SenderOptions {
  fileIndex: number;
  highWaterMark?: number;
  pollIntervalMs?: number;
  stallTimeoutMs?: number;
  onProgress?: (sent: bigint, total: bigint) => void;
  onStateChange?: (state: SenderState) => void;
}

export class SenderStalledError extends Error {
  constructor(timeoutMs: number) {
    super(`The receiver went quiet for ${Math.round(timeoutMs / 1000)}s, so the transfer timed out.`);
    this.name = 'SenderStalledError';
  }
}

export class SenderEngine {
  private currentState: SenderState = 'idle';
  private aborted = false;
  private closed = false;
  private readonly inbox: ChannelMessage[] = [];
  private waiter: ((msg: ChannelMessage | null) => void) | null = null;
  private stallError: Error | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteError: string | null = null;

  constructor(
    private readonly channel: Channel,
    private readonly file: Blob,
    private readonly key: CryptoKey,
    private readonly options: SenderOptions,
  ) {
    this.setState('idle');
    this.channel.onMessage((msg) => {
      this.armStall();
      const reason = readErrorControl(msg);
      if (reason !== null && this.remoteError === null) this.remoteError = reason;
      const waiter = this.waiter;
      if (waiter === null) {
        this.inbox.push(msg);
        return;
      }
      waiter(msg);
    });
    this.channel.onClose(() => {
      this.closed = true;
      this.disarmStall();
      this.wake();
    });
  }

  get state(): SenderState {
    return this.currentState;
  }

  private setState(next: SenderState): void {
    this.currentState = next;
    this.options.onStateChange?.(next);
  }

  private armStall(): void {
    this.disarmStall();
    const timeoutMs = this.options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      this.stallError = new SenderStalledError(timeoutMs);
      this.wake();
    }, timeoutMs);
  }

  private disarmStall(): void {
    if (this.stallTimer === null) return;
    clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private halted(signal?: AbortSignal): boolean {
    return this.aborted || this.closed || signal?.aborted === true;
  }

  private isSending(): boolean {
    return this.currentState === 'sending';
  }

  private isSent(): boolean {
    return this.currentState === 'sent';
  }

  private async acknowledged(signal?: AbortSignal): Promise<boolean> {
    const msg = await this.next(signal);
    this.raiseRemoteFailure();
    if (msg === null) {
      if (this.stallError !== null) throw this.stallError;
      if (this.aborted || signal?.aborted === true) {
        this.setState('aborted');
        return false;
      }
      throw new DeliveryUnconfirmedError();
    }
    if (typeof msg !== 'string') {
      throw new ProtocolError('Expected an acknowledgement but received file data.');
    }
    const control = parseControl(msg);
    if (control.t === 'done') {
      this.setState('completed');
      return true;
    }
    if (control.t === 'error') throw new Error(control.message);
    throw new ProtocolError(`Expected an acknowledgement but received "${control.t}".`);
  }

  private sendOnOpenChannel(control: string): void {
    if (this.closed) return;
    this.channel.send(control);
  }

  private wake(): void {
    const waiter = this.waiter;
    if (waiter === null) return;
    waiter(null);
  }

  private next(signal?: AbortSignal): Promise<ChannelMessage | null> {
    if (this.stallError !== null) return Promise.resolve(null);
    const queued = this.inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.halted(signal)) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const onAbort = (): void => finish(null);
      const finish = (msg: ChannelMessage | null): void => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        if (this.waiter === finish) this.waiter = null;
        resolve(msg);
      };
      this.waiter = finish;
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async consent(signal?: AbortSignal): Promise<boolean> {
    const msg = await this.next(signal);
    if (msg === null) {
      if (this.stallError !== null) throw this.stallError;
      this.reportStopped();
      return false;
    }
    if (typeof msg !== 'string') {
      throw new ProtocolError('Expected a control message but received file data.');
    }
    const control = parseControl(msg);
    if (control.t === 'accept') return true;
    if (control.t === 'reject') {
      this.setState('aborted');
      throw new TransferDeclinedError(control.reason);
    }
    if (control.t === 'error') {
      this.remoteError = null;
      this.reportStopped();
      return false;
    }
    throw new ProtocolError(`Expected an accept or a reject but received "${control.t}".`);
  }

  abort(): void {
    this.aborted = true;
    this.disarmStall();
    if (this.currentState === 'sending') this.setState('aborted');
    this.wake();
  }

  private reportStopped(): void {
    if (this.currentState === 'sending') this.setState('aborted');
    this.sendOnOpenChannel(
      serializeControl({ t: 'error', message: 'The sender stopped sharing.' }),
    );
  }

  private raiseRemoteFailure(): void {
    if (this.remoteError === null) return;
    const reason = this.remoteError;
    this.remoteError = null;
    if (this.isSending() || this.isSent()) this.setState('failed');
    throw new Error(reason);
  }

  private failureMessage(cause: unknown): string {
    if (cause instanceof SenderStalledError) return cause.message;
    return 'The transfer failed.';
  }

  async run(signal?: AbortSignal): Promise<void> {
    if (this.currentState !== 'idle') {
      throw new Error('SenderEngine.run may only be called once.');
    }
    this.setState('sending');
    this.armStall();

    try {
      const size = this.file.size;
      const total = BigInt(size);
      const fullChunks = Math.floor(size / CHUNK_SIZE);
      const remainder = size % CHUNK_SIZE;
      let sent = 0n;
      let index = 0n;

      this.channel.send(
        serializeControl({
          t: 'offer',
          name: fileNameOf(this.file),
          size: String(size),
          chunkSize: CHUNK_SIZE,
        }),
      );

      if (!(await this.consent(signal))) return;

      const sendChunk = async (offset: number, length: number): Promise<boolean> => {
        this.raiseRemoteFailure();
        if (this.stallError !== null) throw this.stallError;
        if (this.halted(signal)) return false;
        const buffer = await this.file.slice(offset, offset + length).arrayBuffer();
        this.channel.send(
          await encryptChunk(this.key, new Uint8Array(buffer), this.options.fileIndex, index),
        );
        index += 1n;
        sent += BigInt(buffer.byteLength);
        this.options.onProgress?.(sent, total);
        this.armStall();
        await waitForDrain(
          this.channel,
          this.options.highWaterMark ?? HIGH_WATER_MARK,
          this.options.pollIntervalMs,
        );
        return true;
      };

      for (let i = 0; i < fullChunks; i += 1) {
        if (!(await sendChunk(i * CHUNK_SIZE, CHUNK_SIZE))) {
          this.reportStopped();
          return;
        }
      }

      if (remainder > 0 && !(await sendChunk(fullChunks * CHUNK_SIZE, remainder))) {
        this.reportStopped();
        return;
      }

      this.raiseRemoteFailure();
      if (this.stallError !== null) throw this.stallError;

      if (this.halted(signal)) {
        this.reportStopped();
        return;
      }

      this.sendOnOpenChannel(serializeControl({ t: 'done' }));
      this.setState('sent');

      if (!(await this.acknowledged(signal))) return;
    } catch (cause) {
      if (this.isSending() || this.isSent()) {
        if (!this.closed) {
          try {
            this.channel.send(serializeControl({ t: 'error', message: this.failureMessage(cause) }));
          } catch {}
        }
        this.setState('failed');
      }
      throw cause;
    } finally {
      this.disarmStall();
    }
  }
}

export class TruncatedTransferError extends Error {
  constructor(received: bigint, total: bigint) {
    const percent = total === 0n ? 100 : Number((received * 100n) / total);
    super(`Transfer ended early at ${percent}%.`);
    this.name = 'TruncatedTransferError';
  }
}

export type ReceiverState = 'idle' | 'awaiting-offer' | 'receiving' | 'completed' | 'failed';

export class TransferStalledError extends Error {
  constructor(timeoutMs: number) {
    super(`The sender went quiet for ${Math.round(timeoutMs / 1000)}s, so the transfer timed out.`);
    this.name = 'TransferStalledError';
  }
}

export interface ReceiverOptions {
  fileIndex: number;
  stallTimeoutMs?: number;
  onProgress?: (received: bigint, total: bigint) => void;
  onStateChange?: (state: ReceiverState) => void;
}

export class ReceiverEngine {
  private currentState: ReceiverState = 'idle';
  private readonly queue: ChannelMessage[] = [];
  private waiter: ((msg: ChannelMessage | null) => void) | null = null;
  private closeMessage: string | null = null;
  private stallError: Error | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private sinkSettled = false;
  private reasonSent = false;

  constructor(
    private readonly channel: Channel,
    private readonly key: CryptoKey,
    private readonly expected: { name: string; size: bigint },
    private readonly sink: Sink,
    private readonly options: ReceiverOptions,
  ) {
    this.setState('idle');
    this.channel.onMessage((msg) => {
      if (this.settled) return;
      if (this.stallError !== null) return;
      this.armStall();
      const waiter = this.waiter;
      if (waiter === null) {
        this.queue.push(msg);
        return;
      }
      this.waiter = null;
      waiter(msg);
    });
    this.channel.onClose((reason) => {
      if (this.closeMessage === null) this.closeMessage = CLOSE_MESSAGES[reason];
      this.disarmStall();
      const waiter = this.waiter;
      if (waiter === null) return;
      this.waiter = null;
      waiter(null);
    });
  }

  get state(): ReceiverState {
    return this.currentState;
  }

  private setState(next: ReceiverState): void {
    this.currentState = next;
    this.options.onStateChange?.(next);
  }

  private armStall(): void {
    this.disarmStall();
    const timeoutMs = this.options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      this.stallError = new TransferStalledError(timeoutMs);
      const waiter = this.waiter;
      if (waiter === null) return;
      this.waiter = null;
      waiter(null);
    }, timeoutMs);
  }

  private disarmStall(): void {
    if (this.stallTimer === null) return;
    clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private fail(reason?: string): void {
    this.disarmStall();
    if (reason !== undefined && !this.reasonSent) {
      this.reasonSent = true;
      try {
        this.channel.send(serializeControl({ t: 'error', message: reason }));
      } catch {}
    }
    if (!this.sinkSettled) {
      this.sinkSettled = true;
      try {
        this.sink.abort();
      } catch {}
    }
    this.setState('failed');
    this.settled = true;
    setTimeout(() => this.channel.close(), 0);
  }

  private interrupted(): Error {
    if (this.stallError !== null) return this.stallError;
    return new Error(this.closeMessage ?? 'The connection closed before the transfer finished.');
  }

  private next(): Promise<ChannelMessage | null> {
    if (this.stallError !== null) return Promise.resolve(null);
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closeMessage !== null) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private asControl(msg: ChannelMessage): Promise<ReturnType<typeof parseControl>> {
    if (typeof msg !== 'string') {
      return Promise.reject(
        new ProtocolError('Expected a control message but received file data.'),
      );
    }
    return Promise.resolve(parseControl(msg));
  }

  async run(): Promise<void> {
    if (this.currentState !== 'idle') {
      throw new Error('ReceiverEngine.run may only be called once.');
    }
    this.setState('awaiting-offer');
    this.armStall();

    try {
      const first = await this.next();
      if (first === null) {
        this.fail();
        throw this.interrupted();
      }
      const offer = await this.asControl(first);
      if (offer.t === 'error') {
        this.fail();
        throw new Error(offer.message);
      }
      if (offer.t !== 'offer') {
        throw new ProtocolError(`Expected an offer but received "${offer.t}".`);
      }
      if (offer.chunkSize !== CHUNK_SIZE) {
        this.fail(`Unsupported chunk size ${offer.chunkSize}.`);
        throw new ProtocolError(`The sender offered an unsupported chunk size ${offer.chunkSize}.`);
      }
      if (offer.name !== this.expected.name || BigInt(offer.size) !== this.expected.size) {
        this.fail('This transfer does not match this link.');
        throw new ProtocolError('The incoming transfer does not match this link.');
      }

      this.channel.send(serializeControl({ t: 'accept' }));
      this.setState('receiving');

      let index = 0n;
      let received = 0n;

      for (;;) {
        const msg = await this.next();
        if (msg === null) {
          this.fail();
          throw this.interrupted();
        }
        if (typeof msg === 'string') {
          const control = parseControl(msg);
          if (control.t === 'done') break;
          if (control.t === 'error') {
            this.fail();
            throw new Error(control.message);
          }
          throw new ProtocolError(`Unexpected "${control.t}" during transfer.`);
        }

        const remaining = this.expected.size - received;
        if (remaining <= 0n || BigInt(msg.byteLength - TAG_BYTES) > remaining) {
          this.fail();
          throw new ProtocolError('The sender sent more data than it declared.');
        }

        const plain = await decryptChunk(this.key, msg, this.options.fileIndex, index);
        try {
          await this.sink.write(plain);
        } catch (cause) {
          this.fail(sinkFailure('write the file to disk', cause));
          throw cause;
        }
        index += 1n;
        received += BigInt(plain.length);
        this.options.onProgress?.(received, this.expected.size);
      }

      if (received !== this.expected.size) {
        this.fail();
        throw new TruncatedTransferError(received, this.expected.size);
      }

      this.disarmStall();
      try {
        await this.sink.close();
      } catch (cause) {
        this.fail(sinkFailure('finalise the file on disk', cause));
        throw cause;
      }
      this.sinkSettled = true;
      this.channel.send(serializeControl({ t: 'done' }));
      this.setState('completed');
      this.settled = true;
    } catch (error) {
      if (!this.settled) this.fail();
      throw error;
    }
  }
}
