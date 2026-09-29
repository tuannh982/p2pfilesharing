import { describe, expect, it, vi } from 'vitest';
import { BUFFER_WARNING_THRESHOLD, BlobSink, needsBufferedFallback, sanitiseFilename } from './blob';

describe('sanitiseFilename', () => {
  it('keeps an ordinary filename', () => {
    expect(sanitiseFilename('vacation.zip')).toBe('vacation.zip');
  });

  it('strips a Unix path so a link cannot steer the save location', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFilename('/absolute/path/report.pdf')).toBe('report.pdf');
  });

  it('strips a Windows path', () => {
    expect(sanitiseFilename('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
  });

  it('strips a null byte that could truncate the name', () => {
    expect(sanitiseFilename('safe.txt\0.png')).toBe('safe.txt.png');
  });

  it('falls back to a safe default when nothing usable remains', () => {
    expect(sanitiseFilename('   ')).toBe('download');
    expect(sanitiseFilename('///')).toBe('download');
  });

  it('falls back for a name made only of dots, which are directory aliases', () => {
    expect(sanitiseFilename('.')).toBe('download');
    expect(sanitiseFilename('..')).toBe('download');
  });

  it('drops trailing dots and spaces, which Windows silently strips itself', () => {
    expect(sanitiseFilename('report.pdf.')).toBe('report.pdf');
    expect(sanitiseFilename('report.pdf   ')).toBe('report.pdf');
    expect(sanitiseFilename('report.pdf. . ')).toBe('report.pdf');
  });

  it('neutralises a reserved Windows device name, including via its stem', () => {
    expect(sanitiseFilename('NUL')).toBe('NUL.download');
    expect(sanitiseFilename('NUL.txt')).toBe('NUL.txt.download');
    expect(sanitiseFilename('com1')).toBe('com1.download');
    expect(sanitiseFilename('COM9.png')).toBe('COM9.png.download');
  });

  it('leaves a name that merely contains a reserved word', () => {
    expect(sanitiseFilename('console.txt')).toBe('console.txt');
    expect(sanitiseFilename('com10.txt')).toBe('com10.txt');
  });

  it('strips control characters, including the bidi override that disguises an extension', () => {
    expect(sanitiseFilename('in\u0007voice.txt')).toBe('invoice.txt');
    expect(sanitiseFilename('photo.png\u202Egpj')).toBe('photo.pnggpj');
    expect(sanitiseFilename('\u2066report.txt\u2069')).toBe('report.txt');
  });

  it('preserves unicode filenames', () => {
    expect(sanitiseFilename('zdjęcie-🌞.txt')).toBe('zdjęcie-🌞.txt');
  });
});

describe('needsBufferedFallback', () => {
  it('warns at 512 MiB, where memory pressure becomes real', () => {
    expect(BUFFER_WARNING_THRESHOLD).toBe(536870912);
    expect(needsBufferedFallback(BigInt(BUFFER_WARNING_THRESHOLD) - 1n)).toBe(false);
    expect(needsBufferedFallback(BigInt(BUFFER_WARNING_THRESHOLD))).toBe(true);
  });
});

describe('BlobSink', () => {
  it('produces a blob of the right type and size', async () => {
    const sink = new BlobSink('data.bin', { triggerDownload: () => {} });
    await sink.write(new Uint8Array([1, 2, 3]));
    await sink.write(new Uint8Array([4, 5]));
    await sink.close();

    const blob = sink.toBlob();
    expect(blob.size).toBe(5);
    expect(blob.type).toBe('application/octet-stream');
  });

  it('copies chunks so later mutation of the caller buffer cannot corrupt it', async () => {
    const sink = new BlobSink('data.bin', { triggerDownload: () => {} });
    const source = new Uint8Array([1, 2, 3]);
    await sink.write(source);
    source[0] = 99;
    await sink.close();

    expect([...new Uint8Array(await sink.toBlob().arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('abandons the buffer on abort', async () => {
    const sink = new BlobSink('data.bin');
    await sink.write(new Uint8Array([1, 2, 3]));
    sink.abort();
    expect(() => sink.toBlob()).toThrowError(/aborted/i);
  });

  it('throws on write after abort, matching FileSink, rather than retaining unread bytes', async () => {
    const sink = new BlobSink('data.bin', { triggerDownload: () => {} });
    sink.abort();

    await expect(sink.write(new Uint8Array([1, 2, 3]))).rejects.toThrowError(/aborted/i);
  });

  it('triggers a download with the sanitised name on close', async () => {
    const calls: { filename: string; size: number }[] = [];
    const sink = new BlobSink('../../etc/passwd', {
      triggerDownload: (blob, filename) => calls.push({ filename, size: blob.size }),
    });
    await sink.write(new Uint8Array([7, 8]));
    await sink.close();

    expect(calls).toEqual([{ filename: 'passwd', size: 2 }]);
  });

  it('fires the download only once, however many times close is called', async () => {
    const triggerDownload = vi.fn();
    const sink = new BlobSink('data.bin', { triggerDownload });
    await sink.write(new Uint8Array([7, 8]));

    await sink.close();
    await sink.close();

    expect(triggerDownload).toHaveBeenCalledTimes(1);
  });
});
