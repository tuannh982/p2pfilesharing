import { sanitiseFilename } from './blob';
import type { Sink } from './sink';

interface FileSystemWritable {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}

type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemWritable>;

function getPicker(): ShowSaveFilePicker | null {
  const candidate = (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  return typeof candidate === 'function' ? (candidate as ShowSaveFilePicker) : null;
}

export function isFileSystemAccessSupported(): boolean {
  return getPicker() !== null;
}

function isWritableStream(value: unknown): value is FileSystemWritable {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<FileSystemWritable>;
  return typeof candidate.write === 'function' && typeof candidate.close === 'function';
}

async function streamFromHandle(value: unknown): Promise<unknown> {
  const create = (value as { createWritable?: unknown } | null)?.createWritable;
  if (typeof create !== 'function') return null;
  try {
    return await (create as () => Promise<unknown>).call(value);
  } catch {
    return null;
  }
}

export class FileSink implements Sink {
  private writable: FileSystemWritable | null = null;
  private aborted = false;

  private constructor() {}

  static async open(rawName: string): Promise<FileSink> {
    const picker = getPicker();
    if (picker === null) {
      throw new Error('This browser cannot stream directly to disk.');
    }
    const sink = new FileSink();
    const picked = await picker({
      suggestedName: sanitiseFilename(rawName),
      types: [{ description: 'File', accept: { 'application/octet-stream': ['.bin'] } }],
    });
    const writable = isWritableStream(picked) ? picked : await streamFromHandle(picked);
    if (!isWritableStream(writable)) {
      sink.abort();
      throw new Error('This browser cannot stream directly to disk.');
    }
    sink.writable = writable;
    return sink;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.writable === null || this.aborted) {
      throw new Error('The file is no longer being written.');
    }
    await this.writable.write(chunk);
  }

  async close(): Promise<void> {
    if (this.writable === null || this.aborted) return;
    const writable = this.writable;
    this.writable = null;
    try {
      await writable.close();
    } catch (error) {
      abortQuietly(writable);
      throw error;
    }
  }

  abort(): void {
    this.aborted = true;
    const writable = this.writable;
    this.writable = null;
    abortQuietly(writable);
  }
}

function abortQuietly(writable: FileSystemWritable | null): void {
  if (writable === null) return;
  try {
    void writable.abort?.().catch(() => {});
  } catch {}
}
