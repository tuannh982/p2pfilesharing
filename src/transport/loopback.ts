import type { Channel, ChannelMessage, CloseReason } from './channel';

const messageSize = (msg: ChannelMessage): number =>
  typeof msg === 'string' ? msg.length : msg.byteLength;

class LoopbackChannel implements Channel {
  private remote: LoopbackChannel | null = null;
  private readonly messageHandlers: ((msg: ChannelMessage) => void)[] = [];
  private readonly closeHandlers: ((reason: CloseReason) => void)[] = [];
  private inflight = 0;
  private closed = false;

  link(remote: LoopbackChannel): void {
    this.remote = remote;
  }

  get bufferedAmount(): number {
    return this.inflight;
  }

  send(msg: ChannelMessage): void {
    if (this.closed) return;
    this.inflight += messageSize(msg);
    queueMicrotask(() => {
      this.inflight -= messageSize(msg);
      const target = this.remote;
      if (this.closed || target === null || target.closed) return;
      for (const handler of target.messageHandlers) handler(msg);
    });
  }

  onMessage(cb: (msg: ChannelMessage) => void): void {
    this.messageHandlers.push(cb);
  }

  onClose(cb: (reason: CloseReason) => void): void {
    this.closeHandlers.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler('local');
    const target = this.remote;
    if (target === null || target.closed) return;
    target.closed = true;
    for (const handler of target.closeHandlers) handler('remote');
  }
}

export interface LoopbackPair {
  a: Channel;
  b: Channel;
}

export function createLoopbackPair(): LoopbackPair {
  const a = new LoopbackChannel();
  const b = new LoopbackChannel();
  a.link(b);
  b.link(a);
  return { a, b };
}
