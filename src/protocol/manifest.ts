import { buildBinding, decryptChunk, encryptChunk, MANIFEST_DOMAIN } from '../crypto/chunks';

export const MANIFEST_FILE_INDEX = 0;
export const MANIFEST_CHUNK_INDEX = 0n;
export const FIRST_FILE_INDEX = 1;
export const MAX_FILES = 200;
export const MAX_MANIFEST_BYTES = 65536;
export const MAX_NAME_BYTES = 255;

export interface ManifestEntry {
  name: string;
  size: bigint;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const shortName = (name: string): string =>
  name.length > 60 ? `${name.slice(0, 60)}...` : name;

const nameByteLength = (name: string): number => encoder.encode(name).byteLength;

const manifestBytes = (files: ManifestEntry[]): Uint8Array<ArrayBuffer> =>
  encoder.encode(
    JSON.stringify({ files: files.map((entry) => ({ name: entry.name, size: String(entry.size) })) }),
  );

export function validateManifest(files: ManifestEntry[]): void {
  if (files.length === 0) {
    throw new ManifestError('A share must contain at least one file.');
  }
  if (files.length > MAX_FILES) {
    throw new ManifestError(
      `A share can carry at most ${MAX_FILES} files; this one has ${files.length}.`,
    );
  }
  for (const entry of files) {
    const length = nameByteLength(entry.name);
    if (length < 1 || length > MAX_NAME_BYTES) {
      throw new ManifestError(
        `A filename must be 1 to ${MAX_NAME_BYTES} bytes once encoded; "${shortName(entry.name)}" is not.`,
      );
    }
    if (entry.size < 0n) {
      throw new ManifestError(`"${shortName(entry.name)}" has an invalid size.`);
    }
  }
  if (manifestBytes(files).byteLength > MAX_MANIFEST_BYTES) {
    throw new ManifestError('The file list is too long to send in one piece; share fewer files.');
  }
}

export function encodeManifest(files: ManifestEntry[]): Uint8Array<ArrayBuffer> {
  validateManifest(files);
  return manifestBytes(files);
}

const UNREADABLE = 'The sender sent a file list this app could not read.';

export function decodeManifest(bytes: Uint8Array): ManifestEntry[] {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new ManifestError('The sender sent a file list too long to read in one piece.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new ManifestError(UNREADABLE);
  }
  if (!isRecord(parsed)) {
    throw new ManifestError(UNREADABLE);
  }
  const maybeFiles = parsed['files'];
  if (!Array.isArray(maybeFiles)) {
    throw new ManifestError(UNREADABLE);
  }
  const raw: unknown[] = maybeFiles;
  if (raw.length === 0) {
    throw new ManifestError('The sender sent an empty file list.');
  }
  if (raw.length > MAX_FILES) {
    throw new ManifestError(`The sender sent more than ${MAX_FILES} files.`);
  }
  return raw.map((entry) => {
    if (!isRecord(entry)) {
      throw new ManifestError('A file in the list is not a file.');
    }
    const name = entry['name'];
    const size = entry['size'];
    if (typeof name !== 'string' || nameByteLength(name) < 1) {
      throw new ManifestError('A file in the list has no usable name.');
    }
    if (nameByteLength(name) > MAX_NAME_BYTES) {
      throw new ManifestError(`A filename in the file list is over ${MAX_NAME_BYTES} bytes.`);
    }
    if (typeof size !== 'string' || !/^\d+$/.test(size)) {
      throw new ManifestError(`"${shortName(name)}" has an unreadable size.`);
    }
    return { name, size: BigInt(size) };
  });
}

// Fixed zero, not the manifest's own length; chunks.ts explains why. A function
// of nothing rather than a constant or a parameter: a caller that could pass a
// size would one day pass the wrong one, with no error anywhere.
export function manifestBinding(): Uint8Array<ArrayBuffer> {
  return buildBinding(MANIFEST_DOMAIN, MANIFEST_FILE_INDEX, 0n);
}

export async function encryptManifest(
  key: CryptoKey,
  files: ManifestEntry[],
): Promise<ArrayBuffer> {
  return encryptChunk(
    key,
    encodeManifest(files),
    MANIFEST_FILE_INDEX,
    MANIFEST_CHUNK_INDEX,
    manifestBinding(),
  );
}

export async function decryptManifest(
  key: CryptoKey,
  frame: ArrayBuffer,
): Promise<ManifestEntry[]> {
  const plain = await decryptChunk(
    key,
    frame,
    MANIFEST_FILE_INDEX,
    MANIFEST_CHUNK_INDEX,
    manifestBinding(),
  );
  return decodeManifest(plain);
}

export function manifestFromFiles(files: File[]): ManifestEntry[] {
  return files.map((file) => ({ name: file.name, size: BigInt(file.size) }));
}
