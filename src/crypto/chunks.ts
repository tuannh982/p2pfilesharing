export const CHUNK_SIZE = 65536;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const FILE_INDEX_BYTES = 4;
export const CHUNK_INDEX_BYTES = 8;
// The width of a total size in a binding. Distinct from CHUNK_INDEX_BYTES
// because the two mean different things even though both are 8-byte integers.
export const SIZE_BYTES = 8;

const TAG_BITS = TAG_BYTES * 8;
const MAX_FILE_INDEX = 2 ** (FILE_INDEX_BYTES * 8);
const MAX_CHUNK_INDEX = 2n ** BigInt(CHUNK_INDEX_BYTES * 8);

export class DecryptionError extends Error {
  // The manifest is decrypted before any control frame is parsed, so a stale
  // build trips this on its first frame and the reload hint below is the only
  // message such a tab ever sees. A chunk reaching this catch, by contrast, is
  // a real authentication failure: a wrong key and a tampered frame look the
  // same from here, so neither is named.
  constructor(
    message = 'Integrity check failed. If the sender has had this page open for a while, they may need to reload it.',
  ) {
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

export const CHUNK_DOMAIN = 0x01;
export const MANIFEST_DOMAIN = 0x02;
export const BINDING_BYTES = 1 + FILE_INDEX_BYTES + SIZE_BYTES;

const DOMAIN_OFFSET = 0;
const BINDING_FILE_OFFSET = DOMAIN_OFFSET + 1;
const BINDING_SIZE_OFFSET = BINDING_FILE_OFFSET + FILE_INDEX_BYTES;

// What a frame is bound to. A frame sealed under one binding cannot be opened
// under another, so a sender that streams one file's bytes under another's
// index fails authentication instead of quietly writing the wrong content.
// The manifest binds a fixed zero size, not its own length: a receiver has to
// build this before it can decrypt, so it cannot yet know how long the
// plaintext turned out to be.
export function buildBinding(
  domain: number,
  fileIndex: number,
  totalSize: bigint,
): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(domain) || domain < 0 || domain > 0xff) {
    throw new ProtocolRangeError('A frame domain must be a whole number below 256.');
  }
  if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= MAX_FILE_INDEX) {
    throw new ProtocolRangeError(`A file index must be a whole number below ${MAX_FILE_INDEX}.`);
  }
  if (totalSize < 0n || totalSize >= MAX_CHUNK_INDEX) {
    throw new ProtocolRangeError('A total size must fit in 64 bits.');
  }
  const binding = new Uint8Array(BINDING_BYTES);
  const view = new DataView(binding.buffer);
  view.setUint8(DOMAIN_OFFSET, domain);
  view.setUint32(BINDING_FILE_OFFSET, fileIndex);
  view.setBigUint64(BINDING_SIZE_OFFSET, totalSize);
  return binding;
}

// WebCrypto treats an absent `additionalData` as legal and seals the frame
// anyway, so a caller who forgets the binding gets a frame with no identity
// rather than an error. The type signature already forbids that; this refuses
// it at runtime too, for a stale bundle or any build that skipped the
// typechecker. Deliberately not a length check: the binding's size is free,
// and only its presence is load-bearing.
function requireBinding(binding: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (binding === undefined) {
    throw new ProtocolRangeError('A frame must be sealed with a binding, but none was given.');
  }
  if (!(binding instanceof Uint8Array)) {
    throw new ProtocolRangeError('A frame binding must be a Uint8Array.');
  }
  return binding;
}

// The binding is required, not optional: a call site that could omit it would
// silently fall back to exactly the leak this closes. Associated data is
// authenticated but not encrypted, and it is never transmitted, so both sides
// derive it independently. It is no secret, and it is not derivable from the
// offer either: the offer carries only the chunk size, not the total. A relay
// that wanted it would have to take the file index from the cleartext select
// and the total from the frame lengths, which is the same work the README says
// it can already do. Rebinding a frame to another file breaks the tag either
// way.
export async function encryptChunk(
  key: CryptoKey,
  plain: Uint8Array<ArrayBuffer>,
  fileIndex: number,
  chunkIndex: bigint,
  binding: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: deriveNonce(fileIndex, chunkIndex),
    additionalData: requireBinding(binding),
    tagLength: TAG_BITS,
  };
  return crypto.subtle.encrypt(params, key, plain);
}

export async function decryptChunk(
  key: CryptoKey,
  frame: ArrayBuffer,
  fileIndex: number,
  chunkIndex: bigint,
  binding: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: deriveNonce(fileIndex, chunkIndex),
    additionalData: requireBinding(binding),
    tagLength: TAG_BITS,
  };
  try {
    return new Uint8Array(await crypto.subtle.decrypt(params, key, frame));
  } catch {
    throw new DecryptionError();
  }
}
