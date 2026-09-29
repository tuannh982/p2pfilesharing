export const CHUNK_SIZE = 65536;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const FILE_INDEX_BYTES = 4;
export const CHUNK_INDEX_BYTES = 8;

const TAG_BITS = TAG_BYTES * 8;
const MAX_FILE_INDEX = 2 ** (FILE_INDEX_BYTES * 8);
const MAX_CHUNK_INDEX = 2n ** BigInt(CHUNK_INDEX_BYTES * 8);

export class DecryptionError extends Error {
  constructor(message = 'Integrity check failed - the link does not match this sender.') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export class ProtocolRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolRangeError';
  }
}

export function deriveNonce(fileIndex: number, chunkIndex: bigint): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= MAX_FILE_INDEX) {
    throw new ProtocolRangeError(`A file index must be a whole number below ${MAX_FILE_INDEX}.`);
  }
  if (chunkIndex < 0n || chunkIndex >= MAX_CHUNK_INDEX) {
    throw new ProtocolRangeError('A chunk index must fit in 64 bits.');
  }
  const nonce = new Uint8Array(NONCE_BYTES);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, fileIndex);
  view.setBigUint64(FILE_INDEX_BYTES, chunkIndex);
  return nonce;
}

export async function encryptChunk(
  key: CryptoKey,
  plain: Uint8Array<ArrayBuffer>,
  fileIndex: number,
  chunkIndex: bigint,
): Promise<ArrayBuffer> {
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: deriveNonce(fileIndex, chunkIndex),
    tagLength: TAG_BITS,
  };
  return crypto.subtle.encrypt(params, key, plain);
}

export async function decryptChunk(
  key: CryptoKey,
  frame: ArrayBuffer,
  fileIndex: number,
  chunkIndex: bigint,
): Promise<Uint8Array<ArrayBuffer>> {
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: deriveNonce(fileIndex, chunkIndex),
    tagLength: TAG_BITS,
  };
  try {
    return new Uint8Array(await crypto.subtle.decrypt(params, key, frame));
  } catch {
    throw new DecryptionError();
  }
}
