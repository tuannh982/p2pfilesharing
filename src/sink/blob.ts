import type { Sink } from './sink';

export const BUFFER_WARNING_THRESHOLD = 536870912;

export function needsBufferedFallback(size: bigint): boolean {
  return size >= BigInt(BUFFER_WARNING_THRESHOLD);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitiseFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .replace(/[. ]+$/, '');
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'download';
  const stem = cleaned.split('.')[0] ?? cleaned;
  if (WINDOWS_RESERVED.test(stem)) return `${cleaned}.download`;
  return cleaned;
}

export interface BlobSinkHooks {
  triggerDownload?: (blob: Blob, filename: string) => void;
}

function defaultDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export class BlobSink implements Sink {
  private readonly parts: Uint8Array[] = [];
  private aborted = false;
  private closed = false;

  constructor(
    private readonly rawName: string,
    private readonly hooks: BlobSinkHooks = {},
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.aborted) {
      throw new Error('The download was aborted.');
    }
    this.parts.push(chunk.slice());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const blob = this.toBlob();
    const trigger = this.hooks.triggerDownload ?? defaultDownload;
    trigger(blob, sanitiseFilename(this.rawName));
  }

  abort(): void {
    this.aborted = true;
    this.parts.length = 0;
  }

  toBlob(): Blob {
    if (this.aborted) {
      throw new Error('The download was aborted.');
    }
    return new Blob(this.parts as BlobPart[], { type: 'application/octet-stream' });
  }
}
