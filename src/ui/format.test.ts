import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatRate } from './format';

describe('formatBytes', () => {
  it('uses binary units', () => {
    expect(formatBytes(0n)).toBe('0 B');
    expect(formatBytes(512n)).toBe('512 B');
    expect(formatBytes(1024n)).toBe('1.0 KiB');
    expect(formatBytes(1536n)).toBe('1.5 KiB');
    expect(formatBytes(1024n * 1024n)).toBe('1.0 MiB');
    expect(formatBytes(2147483648n)).toBe('2.0 GiB');
  });
});

describe('formatRate', () => {
  it('formats a rate, and shows a dash before any data moves', () => {
    expect(formatRate(0)).toBe('-');
    expect(formatRate(1536)).toBe('1.5 KiB/s');
  });
});

describe('formatDuration', () => {
  it('formats a countdown', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(124)).toBe('2m 04s');
    expect(formatDuration(3725)).toBe('1h 02m');
  });
});
