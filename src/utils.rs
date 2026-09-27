//! Small helpers: hashing, hex, base64url, constant-time compare, randomness.
//!
//! Everything here is wasm-friendly with no heavyweight dependencies.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Lowercase hex encoding.
pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Decode a lowercase/uppercase hex string. Returns `None` on any invalid input.
pub fn from_hex(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    // `as_chunks` hands out fixed-size pairs and a remainder; a non-empty
    // remainder means the input had an odd length.
    let (pairs, rest) = bytes.as_chunks::<2>();
    if !rest.is_empty() {
        return None;
    }

    let mut out = Vec::with_capacity(pairs.len());
    for &[hi, lo] in pairs {
        let hi = (hi as char).to_digit(16)?;
        let lo = (lo as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// SHA-256 of the given bytes, as lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    to_hex(&hasher.finalize())
}

/// Is this exactly 64 lowercase/uppercase hex characters?
pub fn is_valid_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Normalise a SHA-256 string to lowercase, validating it first.
pub fn normalize_sha256(s: &str) -> Option<String> {
    if !is_valid_sha256(s) {
        return None;
    }
    Some(s.to_ascii_lowercase())
}

/// Base64url (no padding) encoding, hand rolled to avoid an extra dependency.
pub fn base64url_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 0x3f) as usize] as char);
        }
    }
    out
}

/// Base64url (no padding) decoding.
pub fn base64url_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }

    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4 + 3);

    for chunk in bytes.chunks(4) {
        if chunk.len() == 1 {
            return None; // a lone trailing character is never valid
        }
        let mut n: u32 = 0;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// HMAC-SHA256, returned as raw bytes.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any size");
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}

/// Compare two byte slices without short-circuiting on the first differing byte.
///
/// Used for password and signature checks so that timing does not leak how many
/// leading bytes matched.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Cryptographically random bytes from the platform CSPRNG.
///
/// `getrandom` is compiled with the `js` feature so it routes to
/// `crypto.getRandomValues` inside the Workers runtime.
pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).expect("CSPRNG unavailable");
    buf
}

/// A URL-safe random string of `len` characters, used for nonces and temp keys.
pub fn random_token(len: usize) -> String {
    // base64url of ceil(len * 3 / 4) bytes yields roughly `len` characters.
    let bytes = random_bytes(len * 3 / 4 + 1);
    base64url_encode(&bytes)[..len].to_string()
}

/// Current time in milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

use worker::Date;

/// Escape a filename for safe inclusion in Markdown link/image text.
///
/// Square brackets and backslashes would otherwise break the surrounding
/// `![...](...)` construct, and parentheses can terminate the URL early.
pub fn escape_markdown_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' | '[' | ']' | '(' | ')' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// The Content-Type implied by a filename, based on extension only.
///
/// User supplied Content-Type headers are never trusted on their own — the
/// extension is the source of truth, matching the spec's Content-Type table.
pub fn content_type_for_filename(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();

    // `.user.js` must be checked before `.js` — it is still JavaScript.
    if lower.ends_with(".user.js") {
        return Some("application/javascript");
    }

    let ext = lower.rsplit('.').next().unwrap_or("");
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "xml" => "application/xml",
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        _ => return None,
    })
}
