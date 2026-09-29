import { describe, expect, it } from 'vitest';
import { waitForDrain } from './backpressure';
import type { Channel } from './channel';
import { createLoopbackPair } from './loopback';

const withBufferedAmount = (base: Channel, read: () => number): Channel => ({
  send: (m) => base.send(m),
  onMessage: (cb) => base.onMessage(cb),
  onClose: (cb) => base.onClose(cb),
  close: () => base.close(),
  get bufferedAmount() {
    return read();
  },
});

describe('waitForDrain', () => {
  it('resolves immediately when nothing is buffered', async () => {
    const { a } = createLoopbackPair();
    await expect(waitForDrain(a, 1024, 0)).resolves.toBeUndefined();
  });

  it('waits until the queue falls to or below the high-water mark', async () => {
    const { a } = createLoopbackPair();
    let drained = false;
    setTimeout(() => {
      drained = true;
    }, 5);
    const channel = withBufferedAmount(a, () => (drained ? 0 : 5000));
    await waitForDrain(channel, 1024, 1);
    expect(drained).toBe(true);
  });

  it('drains real buffered bytes from a loopback channel', async () => {
    const { a } = createLoopbackPair();
    let drained = false;
    setTimeout(() => {
      drained = true;
    }, 0);
    const channel = withBufferedAmount(a, () => (drained ? 0 : a.bufferedAmount));
    a.send(new Uint8Array(2048).buffer);
    expect(a.bufferedAmount).toBeGreaterThan(1024);
    await waitForDrain(channel, 1024, 1);
    expect(drained).toBe(true);
    expect(a.bufferedAmount).toBe(0);
  });

  it('gives up rather than hanging forever if the channel never drains', async () => {
    const { a } = createLoopbackPair();
    const stuck = withBufferedAmount(a, () => 5000);
    await expect(waitForDrain(stuck, 1024, 1, 50)).resolves.toBeUndefined();
  });
});
