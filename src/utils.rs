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

/// SHA-256 of the given bytes.
pub fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// SHA-256 of the given bytes, as lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    to_hex(&sha256_bytes(data))
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

/// Content type of an image, or `None` when the name or the bytes are not one
/// of the formats this host stores.
///
/// The extension and the file header both have to agree. A `.png` whose bytes
/// are HTML is rejected, and so is a JPEG renamed to `.html`.
pub fn image_content_type(name: &str, bytes: &[u8]) -> Option<&'static str> {
    let declared = image_type_for_extension(name)?;
    let sniffed = sniff_image(bytes)?;
    if declared == sniffed { Some(declared) } else { None }
}

fn image_type_for_extension(name: &str) -> Option<&'static str> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let ext = base
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    // A name with no dot yields the whole name as `ext`. Require a real dot.
    if !base.contains('.') {
        return None;
    }
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") && bytes.len() >= 14 {
        return Some("image/bmp");
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    if is_avif(bytes) {
        return Some("image/avif");
    }
    None
}

fn is_avif(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let end = bytes.len().min(64);
    bytes[8..end]
        .windows(4)
        .any(|window| window == b"avif" || window == b"avis")
}

#[cfg(test)]
mod image_tests {
    use super::image_content_type;

    #[test]
    fn png_header_and_extension_must_agree() {
        let png = b"\x89PNG\r\n\x1a\nrest";
        assert_eq!(image_content_type("a.PNG", png), Some("image/png"));
        assert_eq!(image_content_type("a.jpg", png), None);
        assert_eq!(image_content_type("a.png", b"<html>"), None);
        assert_eq!(image_content_type("noext", png), None);
    }

    #[test]
    fn rejects_non_images() {
        assert_eq!(image_content_type("a.svg", b"<svg></svg>"), None);
        assert_eq!(image_content_type("a.pdf", b"%PDF-1.7"), None);
        assert_eq!(image_content_type("a.html", b"<html>"), None);
    }
}
