import {
  buildBinding,
  CHUNK_DOMAIN,
  CHUNK_SIZE,
  TAG_BYTES,
  decryptChunk,
  encryptChunk,
} from '../crypto/chunks';
import type { Sink } from '../sink/sink';
import { HIGH_WATER_MARK, waitForDrain } from '../transport/backpressure';
import type { Channel, ChannelMessage, CloseReason } from '../transport/channel';
import { parseControl, ProtocolError, serializeControl, type ControlMessage } from './messages';

export const CLOSE_MESSAGES: Record<CloseReason, string> = {
  local: 'The transfer was cancelled.',
  remote: 'The connection closed before the transfer finished.',
  error: 'The connection to the sender failed mid-transfer.',
  'transport-failure':
    "Couldn't establish a direct connection. Both sides may be behind strict firewalls.",
};

export type SenderState = 'idle' | 'sending' | 'sent' | 'completed' | 'aborted' | 'failed';

export const DEFAULT_STALL_TIMEOUT_MS = 60000;

// Both engines derive this independently; it never goes on the wire. The
// receiver builds it from the manifest entry, which is what turns a wrong stream
// into a failure rather than a bad file. It binds the index and the total size,
// so a wrong index or an under-delivered file fails authentication on the first
// chunk, and an over-delivered one trips the declared-length check before
// anything is decrypted. A zero-byte file has no chunk to fail on.
//
// Not covered: the name. A substitution of one file for another of the *same*
// length is as invisible here as it is to the tag, which is the one case the
// old cleartext check caught. Both sides hold the name, so binding it would
// close the gap -- but the format is frozen, so that is a decision, not a fix.
const chunkBinding = (fileIndex: number, total: bigint): Uint8Array<ArrayBuffer> =>
  buildBinding(CHUNK_DOMAIN, fileIndex, total);

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

// A cancel and the sender's answer to one are the session's to consume, and it
// does: SenderSession answers a cancel naming the file in flight, ignores one
// naming any other, and drops a terminator the peer sent of its own accord. A
// channel hands every frame to every subscriber and cannot detach this engine,
// so they arrive here too, and a cancel arrives in the one slot this engine
// cannot use it in. Neither is a protocol error here, and neither is an answer:
// the engine steps over them and keeps waiting, so an acknowledgement the peer
// already had in flight is still read behind them. Everything else is returned
// as it arrived -- a malformed frame included, which parseControl refuses.
const isSessionAnswered = (control: ControlMessage): boolean =>
  control.t === 'cancel' || control.t === 'cancelled';

// Bounded, because every stepped-over frame re-arms the stall timer on its way
// in, so a peer spraying cancels would otherwise hold a transfer open for as
// long as it cared to keep sending. A transfer waits for consent and then for
// the acknowledgement, and spends at most one in each, so this is a ceiling on
// the whole thing: it bounds the sender stepping over a cancel or a terminator,
// and the receiver stepping over a terminator that outran its drain. Exported
// so the tests can build a peer that walks into the ceiling rather than assert
// a number they made up.
export const MAX_STEPPED_FRAMES = 4;

// Nothing at all, file data where a control frame belongs, or a control frame
// this engine is meant to read.
type SenderFrame = { kind: 'data' } | { kind: 'control'; control: ControlMessage } | null;

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

  // The next frame this engine is meant to read, stepping over the ones the
  // session answers rather than failing on them or taking one for its own. Null
  // is nothing at all: a stall, a close, or an abort.
  private async nextOwnFrame(signal?: AbortSignal): Promise<SenderFrame> {
    for (let stepped = 0; ; stepped += 1) {
      const msg = await this.next(signal);
      if (msg === null) return null;
      if (typeof msg !== 'string') return { kind: 'data' };
      const control = parseControl(msg);
      if (!isSessionAnswered(control)) return { kind: 'control', control };
      if (stepped >= MAX_STEPPED_FRAMES) {
        throw new ProtocolError(
          `The peer sent more than ${MAX_STEPPED_FRAMES} cancel frames for one transfer.`,
        );
      }
    }
  }

  private async acknowledged(signal?: AbortSignal): Promise<boolean> {
    const frame = await this.nextOwnFrame(signal);
    this.raiseRemoteFailure();
    if (frame === null) {
      if (this.stallError !== null) throw this.stallError;
      if (this.aborted || signal?.aborted === true) {
        this.setState('aborted');
        return false;
      }
      throw new DeliveryUnconfirmedError();
    }
    if (frame.kind === 'data') {
      throw new ProtocolError('Expected an acknowledgement but received file data.');
    }
    const { control } = frame;
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
    const frame = await this.nextOwnFrame(signal);
    if (frame === null) {
      if (this.stallError !== null) throw this.stallError;
      // A wait cut short is not the sender stopping. A cancel is a receiver
      // declining a file it was offered, and the session is answering it with a
      // terminator; an error frame here would end the share in the receiver's
      // eyes over a file its user chose to skip, and would be the very frame its
      // drain is meant to end on instead. A stall is a real one and throws
      // above; a closed channel cannot be written to.
      if (this.aborted || signal?.aborted === true) {
        this.setState('aborted');
        return false;
      }
      this.reportStopped();
      return false;
    }
    if (frame.kind === 'data') {
      throw new ProtocolError('Expected a control message but received file data.');
    }
    const { control } = frame;
    if (control.t === 'accept') return true;
    if (control.t === 'reject') {
      this.setState('aborted');
      throw new TransferDeclinedError(control.reason);
    }
    if (control.t === 'error') {
      // Not the case above: the peer is the one reporting the failure, so the
      // sender stopping here is a real event and saying so is a fair answer.
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

  // Worth telling a peer that is still there, because otherwise it is left
  // guessing: it reported a failure, so the sender is stopping and will say
  // nothing further. A close has nowhere to write to -- sendOnOpenChannel sees
  // to that -- and an abort is not news at all; see standDown.
  private reportStopped(): void {
    this.standDown();
    this.sendOnOpenChannel(
      serializeControl({ t: 'error', message: 'The sender stopped sharing.' }),
    );
  }

  // The send loop cut short, which is neither a wire failure nor news for the
  // peer: the party that asked for the stop already knows, and what follows says
  // which it was -- the next select, so the file was skipped, or a closed
  // channel, so the share is over. And it is a lie on a cancel, which is worse
  // than useless here: the receiver's drain ends on the first control frame it
  // sees, so this one would end that drain while the sender is still pushing the
  // cancelled file. Those frames then get through only because the engine that
  // has already finished still happens to be subscribed, and a channel hands
  // every frame to every handler in the order they registered. Nothing in the
  // Channel contract promises that order.
  private standDown(): void {
    if (this.currentState === 'sending') this.setState('aborted');
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
          await encryptChunk(
            this.key,
            new Uint8Array(buffer),
            this.options.fileIndex,
            index,
            chunkBinding(this.options.fileIndex, total),
          ),
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
          this.standDown();
          return;
        }
      }

      if (remainder > 0 && !(await sendChunk(fullChunks * CHUNK_SIZE, remainder))) {
        this.standDown();
        return;
      }

      this.raiseRemoteFailure();
      if (this.stallError !== null) throw this.stallError;

      if (this.halted(signal)) {
        this.standDown();
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

export type ReceiverState =
  | 'idle'
  | 'awaiting-offer'
  | 'receiving'
  | 'completed'
  | 'cancelled'
  | 'failed';

export class TransferCancelledError extends Error {
  constructor() {
    super('The transfer was cancelled.');
    this.name = 'TransferCancelledError';
  }
}

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
  // A cancel leaves the frames the sender had already put on the wire, and
  // every engine on the channel collects them -- the next file's included,
  // whose first frame would then be a chunk it was never offered. So a
  // cancelled engine keeps reading and drops what arrives until the sender
  // says the last of it has gone, and whatever starts the next file waits on
  // `released` first. Going quiet here instead is what handed those frames to
  // the next file and ended the share over a file the user chose to skip.
  private draining = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private release: (() => void) | null = null;

  /** Settles once this engine will read no further frames, drain or not. */
  readonly released: Promise<void>;

  constructor(
    private readonly channel: Channel,
    private readonly key: CryptoKey,
    private readonly expected: { size: bigint },
    private readonly sink: Sink,
    private readonly options: ReceiverOptions,
  ) {
    this.released = new Promise((resolve) => {
      this.release = resolve;
    });
    this.setState('idle');
    this.channel.onMessage((msg) => {
      if (this.settled && !this.draining) return;
      if (this.draining) {
        // Read and drop. The first control frame to turn up is the sender
        // saying it is done with this file -- its own terminator, or the done
        // of a file it had already finished when the cancel arrived, which is
        // the last frame for this index either way.
        if (typeof msg === 'string') this.stopDrain();
        return;
      }
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
      // Nothing more can arrive on a closed channel, so a drain has nothing
      // left to wait for.
      this.stopDrain();
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
    this.stopDrain();
    setTimeout(() => this.channel.close(), 0);
  }

  // Bounded, because a sender that never says the last of its frames has gone
  // would otherwise leave this reading the channel for the rest of the share.
  // The configured stall, not the default: a caller that chose a short timeout
  // chose it for a peer that goes quiet, which is exactly what this is waiting
  // on, and honouring it for every other wait but not this one would be a trap.
  private beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    const timeout = this.options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.drainTimer = setTimeout(() => this.stopDrain(), timeout);
  }

  private stopDrain(): void {
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.draining = false;
    this.release?.();
  }

  // Not `fail`: that closes the channel, which would end the whole share over
  // one file the receiver chose to skip.
  private cancelled(): void {
    this.disarmStall();
    if (!this.sinkSettled) {
      this.sinkSettled = true;
      try {
        this.sink.abort();
      } catch {}
    }
    this.beginDrain();
    try {
      this.channel.send(serializeControl({ t: 'cancel', index: this.options.fileIndex }));
    } catch {}
    this.setState('cancelled');
    this.settled = true;
  }

  private cancelIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted !== true) return;
    this.cancelled();
    throw new TransferCancelledError();
  }

  private interrupted(): Error {
    if (this.stallError !== null) return this.stallError;
    return new Error(this.closeMessage ?? 'The connection closed before the transfer finished.');
  }

  private next(signal?: AbortSignal): Promise<ChannelMessage | null> {
    if (this.stallError !== null) return Promise.resolve(null);
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closeMessage !== null) return Promise.resolve(null);
    if (signal?.aborted === true) return Promise.resolve(null);
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

  private asControl(msg: ChannelMessage): Promise<ReturnType<typeof parseControl>> {
    if (typeof msg !== 'string') {
      return Promise.reject(
        new ProtocolError('Expected a control message but received file data.'),
      );
    }
    return Promise.resolve(parseControl(msg));
  }

  async run(signal?: AbortSignal): Promise<void> {
    if (this.currentState !== 'idle') {
      throw new Error('ReceiverEngine.run may only be called once.');
    }
    this.setState('awaiting-offer');
    this.armStall();

    try {
      let first = await this.next(signal);
      this.cancelIfAborted(signal);
      if (first === null) {
        this.fail();
        throw this.interrupted();
      }
      let offer = await this.asControl(first);
      // A terminator for the file before this one, arriving after the drain that
      // should have taken it has already let this file in: the drain ends on any
      // control frame, and a sender that finished the file as the cancel was in
      // flight put its own done on the wire first. It says nothing about this
      // file, and the session drops it as well, so it is stepped over rather than
      // taken for an answer -- which ends the share over a file that is only
      // beginning.
      for (let stepped = 0; offer.t === 'cancelled'; stepped += 1) {
        if (stepped >= MAX_STEPPED_FRAMES) {
          throw new ProtocolError(
            `The peer sent more than ${MAX_STEPPED_FRAMES} terminator frames for one transfer.`,
          );
        }
        first = await this.next(signal);
        this.cancelIfAborted(signal);
        if (first === null) {
          this.fail();
          throw this.interrupted();
        }
        offer = await this.asControl(first);
      }
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

      this.channel.send(serializeControl({ t: 'accept' }));
      this.setState('receiving');

      let index = 0n;
      let received = 0n;

      for (;;) {
        const msg = await this.next(signal);
        // Read the signal before the message, not only when there is none: a
        // cancel that lands as the last chunk arrives has to beat the done
        // already queued behind it, or the file the user stopped is written
        // anyway.
        this.cancelIfAborted(signal);
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

        const plain = await decryptChunk(
          this.key,
          msg,
          this.options.fileIndex,
          index,
          chunkBinding(this.options.fileIndex, this.expected.size),
        );
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
      this.stopDrain();
    } catch (error) {
      if (!this.settled) this.fail();
      throw error;
    }
  }
}
