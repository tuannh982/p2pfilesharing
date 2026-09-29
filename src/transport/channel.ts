export type ChannelMessage = string | ArrayBuffer;

export type CloseReason = 'local' | 'remote' | 'error' | 'transport-failure';

export interface Channel {
  send(msg: ChannelMessage): void;
  onMessage(cb: (msg: ChannelMessage) => void): void;
  onClose(cb: (reason: CloseReason) => void): void;
  close(): void;
  readonly bufferedAmount: number;
}
