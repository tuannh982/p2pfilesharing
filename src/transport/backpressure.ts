import type { Channel } from './channel';

export const HIGH_WATER_MARK = 1048576;

const DEFAULT_POLL_INTERVAL_MS = 4;
const DEFAULT_DRAIN_TIMEOUT_MS = 30000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForDrain(
  channel: Channel,
  highWaterMark: number = HIGH_WATER_MARK,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (channel.bufferedAmount > highWaterMark) {
    if (Date.now() >= deadline) return;
    await sleep(pollIntervalMs);
  }
}
