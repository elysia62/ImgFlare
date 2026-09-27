/**
 * SHA-256 hashing in the browser.
 *
 * Uses the platform WebCrypto digest — no third-party hash library, and no
 * file content ever leaves the page just to be hashed.
 */

const HEX = '0123456789abcdef';

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number;
    out += HEX[(byte >> 4) & 0x0f];
    out += HEX[byte & 0x0f];
  }
  return out;
}

/**
 * SHA-256 of a Blob/File, as 64 lowercase hex characters.
 *
 * For small files the whole buffer is digested in one call. Large files are
 * streamed through `crypto.subtle.digest` in chunks is *not* possible (WebCrypto
 * has no incremental API), so we simply read the blob fully — the upload size
 * cap keeps this bounded.
 */
export async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return toHex(digest);
}

/** SHA-256 of a UTF-8 string, handy for tests. */
export async function sha256HexOfString(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
}
