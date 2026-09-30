export type DownloadMode = 'picker' | 'browser';

const env = import.meta.env;

export function parseDownloadMode(raw: string | undefined): DownloadMode {
  // Only the exact opt-in selects the save dialog. A typo must not switch to
  // it: that path streams straight to disk, which buffers nothing, and a user
  // who asked for the browser download should not get a dialog they did not
  // want on a large file.
  return raw?.trim().toLowerCase() === 'picker' ? 'picker' : 'browser';
}

export const DOWNLOAD_MODE: DownloadMode = parseDownloadMode(env.VITE_DOWNLOAD_MODE);

export function usesFilePicker(): boolean {
  return DOWNLOAD_MODE === 'picker';
}
