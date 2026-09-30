import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOWNLOAD_MODE, parseDownloadMode, usesFilePicker } from './download';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('parseDownloadMode', () => {
  it('saves through the browser download when nothing is set', () => {
    expect(parseDownloadMode(undefined)).toBe('browser');
  });

  it('opts into the save dialog when asked', () => {
    expect(parseDownloadMode('picker')).toBe('picker');
  });

  it('accepts the mode spelled either way', () => {
    expect(parseDownloadMode('PICKER')).toBe('picker');
    expect(parseDownloadMode('browser')).toBe('browser');
  });

  it('keeps the browser download for anything unrecognised rather than guessing', () => {
    // A typo must not silently switch to the save dialog: that path streams to
    // disk and is fine, but the mode the user asked for is the one they get.
    expect(parseDownloadMode('pickerx')).toBe('browser');
    expect(parseDownloadMode('')).toBe('browser');
    expect(parseDownloadMode('0')).toBe('browser');
  });
});

describe('DOWNLOAD_MODE', () => {
  it('defaults to the browser download', () => {
    expect(DOWNLOAD_MODE).toBe('browser');
    expect(usesFilePicker()).toBe(false);
  });

  it('reads the mode from the environment', async () => {
    vi.stubEnv('VITE_DOWNLOAD_MODE', 'picker');
    vi.resetModules();
    const { DOWNLOAD_MODE: overridden, usesFilePicker: overriddenPicker } = await import(
      './download'
    );
    expect(overridden).toBe('picker');
    expect(overriddenPicker()).toBe(true);
  });

  it('still honours an explicit browser opt-in', async () => {
    vi.stubEnv('VITE_DOWNLOAD_MODE', 'browser');
    vi.resetModules();
    const { DOWNLOAD_MODE: overridden } = await import('./download');
    expect(overridden).toBe('browser');
  });
});
