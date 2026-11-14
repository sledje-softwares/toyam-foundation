// File hashing contract (rule 3). The SHA-256 is computed on the phone over exactly the bytes that are
// uploaded: the final (compressed) file in the sandbox, after the copy. The server signs
// `x-amz-content-sha256` with it, so R2 refuses any body that differs.
//
// On the phone the digest comes from expo-file-system's native `File.digest('SHA-256')`, which streams
// the file from disk (64 KB buffers, java.security.MessageDigest) and returns lower-case hex. Nothing is
// read through base64 or a JS string, so a "hash of the base64 text" mistake cannot happen here.

export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Reads a file by URI and returns its SHA-256 hex (native on the phone, node:crypto in tests). */
export type FileDigester = (uri: string) => Promise<string>;

/** Hash of the final file, normalised and checked: never queue a malformed hash. */
export async function sha256OfFile(uri: string, digest: FileDigester): Promise<string> {
  const hex = (await digest(uri)).trim().toLowerCase();
  if (!SHA256_HEX.test(hex)) throw new Error('The file could not be read. Please try again.');
  return hex;
}

/** Known vector: the 256 bytes 0x00…0xff. Used by the on-device self-check before the first hash. */
export const SELF_TEST_BYTES = (): Uint8Array => Uint8Array.from({ length: 256 }, (_, i) => i);
export const SELF_TEST_SHA256 = '40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880';
/** SHA-256 of zero bytes. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
