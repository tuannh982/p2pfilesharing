import type { Sink } from './sink';

export class MemorySink implements Sink {
  private chunks: Uint8Array[] = [];
  private total = 0;

  get byteLength(): number {
    return this.total;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk.slice());
    this.total += chunk.length;
  }

  async close(): Promise<void> {}

  abort(): void {
    this.chunks = [];
    this.total = 0;
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
