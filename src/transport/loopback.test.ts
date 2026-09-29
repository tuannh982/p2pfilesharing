import { describe, expect, it } from 'vitest';
import type { ChannelMessage } from './channel';
import { createLoopbackPair } from './loopback';

const collect = (channel: { onMessage(cb: (m: ChannelMessage) => void): void }): ChannelMessage[] => {
  const seen: ChannelMessage[] = [];
  channel.onMessage((m) => seen.push(m));
  return seen;
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('loopback channel pair', () => {
  it('delivers a string from a to b', async () => {
    const { a, b } = createLoopbackPair();
    const seen = collect(b);
    a.send('hello');
    await tick();
    expect(seen).toEqual(['hello']);
  });

  it('delivers an ArrayBuffer with the same contents', async () => {
    const { a, b } = createLoopbackPair();
    const seen = collect(b);
    a.send(new Uint8Array([1, 2, 3]).buffer);
    await tick();
    expect(seen[0]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(seen[0] as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it('delivers messages in order', async () => {
    const { a, b } = createLoopbackPair();
    const seen = collect(b);
    a.send('one');
    a.send('two');
    a.send('three');
    await tick();
    expect(seen).toEqual(['one', 'two', 'three']);
  });

  it('drains bufferedAmount back to zero after delivery', async () => {
    const { a } = createLoopbackPair();
    a.send(new Uint8Array(1024).buffer);
    expect(a.bufferedAmount).toBe(1024);
    await tick();
    expect(a.bufferedAmount).toBe(0);
  });

  it('reports a remote close to the far side', async () => {
    const { a, b } = createLoopbackPair();
    const reasons: string[] = [];
    b.onClose((r) => reasons.push(r));
    a.close();
    await tick();
    expect(reasons).toEqual(['remote']);
  });

  it('ignores sends from a closed channel', async () => {
    const { a, b } = createLoopbackPair();
    const seen = collect(b);
    a.close();
    a.send('ignored');
    await tick();
    expect(seen).toEqual([]);
  });

  it('reports reason local to its own close handlers on close', async () => {
    const { a } = createLoopbackPair();
    const reasons: string[] = [];
    a.onClose((r) => reasons.push(r));
    a.close();
    await tick();
    expect(reasons).toEqual(['local']);
  });

  it('drops a message queued immediately before the far side closes', async () => {
    const { a, b } = createLoopbackPair();
    const seen = collect(b);
    a.send(new Uint8Array(1024).buffer);
    b.close();
    await tick();
    expect(seen).toEqual([]);
  });

  it('never reports a negative bufferedAmount when closed with data still queued', async () => {
    const { a, b } = createLoopbackPair();
    const seen = collect(b);
    a.send(new Uint8Array(1024).buffer);
    a.close();
    await tick();
    expect(seen).toEqual([]);
    expect(a.bufferedAmount).toBe(0);
  });

  it('does not fire local or remote close handlers again on a second close', async () => {
    const { a, b } = createLoopbackPair();
    const localReasons: string[] = [];
    const remoteReasons: string[] = [];
    a.onClose((r) => localReasons.push(r));
    b.onClose((r) => remoteReasons.push(r));
    a.close();
    a.close();
    await tick();
    expect(localReasons).toEqual(['local']);
    expect(remoteReasons).toEqual(['remote']);
  });
});
