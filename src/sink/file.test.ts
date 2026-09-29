import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSink, isFileSystemAccessSupported } from './file';

interface StubWritable {
  write: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

const globals = globalThis as { showSaveFilePicker?: unknown };

function stubWritable(): StubWritable {
  return {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
}

function stubPicker(writable: unknown) {
  const picker = vi.fn(async () => writable);
  globals.showSaveFilePicker = picker;
  return picker;
}

afterEach(() => {
  delete globals.showSaveFilePicker;
});

describe('isFileSystemAccessSupported', () => {
  it('reports whether the browser can stream straight to disk', () => {
    expect(isFileSystemAccessSupported()).toBe(
      typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function',
    );
  });

  it('agrees with the stubbed global', () => {
    stubPicker(stubWritable());
    expect(isFileSystemAccessSupported()).toBe(true);
  });
});

describe('FileSink.open', () => {
  it('rejects when the browser has no file picker', async () => {
    await expect(FileSink.open('data.bin')).rejects.toThrow(/cannot stream directly to disk/i);
  });

  it('resolves with a sink once the user picks a destination', async () => {
    const writable = stubWritable();
    const picker = stubPicker(writable);

    const sink = await FileSink.open('data.bin');

    expect(picker).toHaveBeenCalledTimes(1);
    expect(sink).toBeInstanceOf(FileSink);
  });

  it('opens the stream when the picker returns a file handle instead of one', async () => {
    // showSaveFilePicker resolves with a FileSystemFileHandle on some builds.
    // The stream comes from its createWritable(), not from the handle itself.
    const writable = stubWritable();
    const handle = { createWritable: vi.fn(async () => writable) };
    stubPicker(handle);

    const sink = await FileSink.open('data.bin');
    await sink.write(new Uint8Array([1, 2, 3]));
    await sink.close();

    expect(handle.createWritable).toHaveBeenCalledTimes(1);
    expect(writable.write).toHaveBeenCalledTimes(1);
    expect(writable.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a picker that hands back something with no write method', async () => {
    // A polyfill or partial implementation can expose showSaveFilePicker
    // without returning a real FileSystemWritableFileStream. Accepting the
    // object would fail later, mid-transfer, as "write is not a function" and
    // take the connection down with it.
    stubPicker({ close: async () => {}, abort: async () => {} });

    await expect(FileSink.open('data.bin')).rejects.toThrow(/cannot stream directly to disk/i);
  });

  it('rejects a picker that returns nothing at all', async () => {
    stubPicker(undefined);

    await expect(FileSink.open('data.bin')).rejects.toThrow(/cannot stream directly to disk/i);
  });

  it('offers the sanitised name, so a hostile filename cannot steer the save location', async () => {
    const picker = stubPicker(stubWritable());

    await FileSink.open('../../etc/passwd');

    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'passwd' }),
    );
  });
});

describe('FileSink.write', () => {
  it('forwards the chunk to the writable', async () => {
    const writable = stubWritable();
    stubPicker(writable);
    const sink = await FileSink.open('data.bin');
    const chunk = new Uint8Array([1, 2, 3]);

    await sink.write(chunk);

    expect(writable.write).toHaveBeenCalledTimes(1);
    expect(writable.write).toHaveBeenCalledWith(chunk);
  });

  it('throws after close, so a late chunk is not silently dropped', async () => {
    const writable = stubWritable();
    stubPicker(writable);
    const sink = await FileSink.open('data.bin');
    await sink.close();

    await expect(sink.write(new Uint8Array([1]))).rejects.toThrow(/no longer being written/i);
    expect(writable.write).not.toHaveBeenCalled();
  });
});

describe('FileSink.close', () => {
  it('closes the handle exactly once, so a retry cannot double-close it', async () => {
    const writable = stubWritable();
    stubPicker(writable);
    const sink = await FileSink.open('data.bin');

    await sink.close();
    await sink.close();

    expect(writable.close).toHaveBeenCalledTimes(1);
  });

  it('aborts the handle when the close itself fails, so the partial file is cleaned up', async () => {
    const writable = stubWritable();
    writable.close.mockRejectedValueOnce(new Error('flush failed'));
    stubPicker(writable);
    const sink = await FileSink.open('data.bin');

    await expect(sink.close()).rejects.toThrow(/flush failed/);
    sink.abort();

    expect(writable.abort).toHaveBeenCalledTimes(1);
  });
});

describe('FileSink.abort', () => {
  it('aborts the handle once and refuses later writes', async () => {
    const writable = stubWritable();
    stubPicker(writable);
    const sink = await FileSink.open('data.bin');

    sink.abort();
    sink.abort();

    expect(writable.abort).toHaveBeenCalledTimes(1);
    await expect(sink.write(new Uint8Array([1]))).rejects.toThrow(/no longer being written/i);
  });

  it('does not throw when the browser gives back a handle with no abort method', () => {
    // Safari and some embedded webviews resolve showSaveFilePicker with an
    // object that has write and close but no abort. Abort runs on the failure
    // path, so throwing here would replace the real transfer error with a
    // TypeError and leave the engine mid-teardown.
    stubPicker({ write: async () => {}, close: async () => {} });

    return FileSink.open('data.bin').then((sink) => {
      expect(() => sink.abort()).not.toThrow();
    });
  });

  it('swallows a rejected teardown instead of leaving an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    const host = (globalThis as {
      process?: {
        on(event: 'unhandledRejection', handler: (reason: unknown) => void): void;
        off(event: 'unhandledRejection', handler: (reason: unknown) => void): void;
      };
    }).process;
    if (host === undefined) throw new Error('unhandled rejections cannot be observed here');
    host.on('unhandledRejection', listener);
    const abortCalls: string[] = [];
    const rejecting = {
      ...stubWritable(),
      abort: (): Promise<void> => {
        abortCalls.push('abort');
        return Promise.reject(new Error('disk vanished'));
      },
    };
    stubPicker(rejecting);
    const sink = await FileSink.open('data.bin');

    sink.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.off('unhandledRejection', listener);

    expect(abortCalls).toEqual(['abort']);
    expect(rejections).toEqual([]);
  });
});
