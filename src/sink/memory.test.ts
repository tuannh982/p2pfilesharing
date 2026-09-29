import { describe, expect, it } from 'vitest';
import { MemorySink } from './memory';

describe('MemorySink', () => {
  it('reassembles the chunks written to it in order', async () => {
    const sink = new MemorySink();
    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3, 4, 5]));
    await sink.close();
    expect(sink.byteLength).toBe(5);
    expect([...sink.toUint8Array()]).toEqual([1, 2, 3, 4, 5]);
  });

  it('copies chunks so later mutation of the caller buffer cannot corrupt it', async () => {
    const sink = new MemorySink();
    const source = new Uint8Array([1, 2, 3]);
    await sink.write(source);
    source[0] = 99;
    expect([...sink.toUint8Array()]).toEqual([1, 2, 3]);
  });

  it('discards everything written before an abort', async () => {
    const sink = new MemorySink();
    await sink.write(new Uint8Array([1, 2, 3]));
    sink.abort();
    expect(sink.byteLength).toBe(0);
  });
});
