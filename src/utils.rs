//! Small helpers: hashing, hex, base64url, constant-time compare, randomness.
//!
//! Everything here is wasm-friendly with no heavyweight dependencies.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Length of a public image id. 32 characters from 62 symbols.
pub const PUBLIC_ID_LEN: usize = 32;

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

/// Public file name, the same shape as `4L4V3tZnrvk16TmODWWOyZWDTzov1YY4.png`.
///
/// The id is 32 characters from a 62-letter alphabet, so two uploads almost
/// never pick the same name. The extension is required and checked separately.
pub fn parse_public_image(name: &str) -> Option<(String, String)> {
    let (id, ext) = name.rsplit_once('.')?;
    if !is_public_id(id) {
        return None;
    }
    if ext.is_empty() || ext.len() > 8 || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some((id.to_string(), ext.to_ascii_lowercase()))
}

pub fn is_public_id(id: &str) -> bool {
    id.len() == PUBLIC_ID_LEN && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// 32-character public id. Letters and digits only, like other image hosts.
pub fn public_image_id() -> String {
    const ALPHABET: &[u8; 62] =
        b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut out = String::with_capacity(PUBLIC_ID_LEN);
    while out.len() < PUBLIC_ID_LEN {
        for &b in &random_bytes(PUBLIC_ID_LEN) {
            // 62 * 4 = 248. Drop the rest so the leftover values are not biased.
            if b < 248 {
                out.push(ALPHABET[(b % 62) as usize] as char);
                if out.len() == PUBLIC_ID_LEN {
                    break;
                }
            }
        }
    }
    out
}

/// File extension used in public URLs, for example `jpg` or `png`.
pub fn extension_for_type(content_type: &str) -> Option<&'static str> {
    Some(match canonical_image_type(content_type)? {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        "image/x-icon" => "ico",
        "image/svg+xml" => "svg",
        "image/jxl" => "jxl",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/tiff" => "tif",
        _ => return None,
    })
}

/// Whether a URL extension agrees with the stored image type.
///
/// `jpg` and `jpeg` both mean JPEG. A `.png` on a JPEG is not a match.
pub fn extension_matches(ext: &str, content_type: &str) -> bool {
    let Some(want) = canonical_image_type(content_type) else {
        return false;
    };
    let Some(declared) = image_type_for_extension(&format!("f.{ext}")) else {
        return false;
    };
    declared == want || (heif_family(declared) && heif_family(want))
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
    if declared == sniffed || heif_family(declared) && heif_family(sniffed) {
        Some(declared)
    } else {
        None
    }
}

/// Canonical type for a stored `Content-Type`, or `None` when it is not an
/// image this host will hand out.
pub fn canonical_image_type(stored: &str) -> Option<&'static str> {
    let base = stored
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Some(match base.as_str() {
        "image/png" => "image/png",
        "image/jpeg" => "image/jpeg",
        "image/webp" => "image/webp",
        "image/gif" => "image/gif",
        "image/avif" => "image/avif",
        "image/bmp" => "image/bmp",
        "image/x-icon" | "image/vnd.microsoft.icon" => "image/x-icon",
        "image/svg+xml" => "image/svg+xml",
        "image/jxl" => "image/jxl",
        "image/heic" => "image/heic",
        "image/heif" => "image/heif",
        "image/tiff" => "image/tiff",
        _ => return None,
    })
}

fn heif_family(content_type: &str) -> bool {
    content_type == "image/heic" || content_type == "image/heif"
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
        "svg" => "image/svg+xml",
        "jxl" => "image/jxl",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "tif" | "tiff" => "image/tiff",
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
    if bytes.starts_with(b"II*\x00") || bytes.starts_with(b"MM\x00*") {
        return Some("image/tiff");
    }
    if is_jxl(bytes) {
        return Some("image/jxl");
    }
    if let Some(kind) = sniff_isobmff(bytes) {
        return Some(kind);
    }
    if is_svg(bytes) {
        return Some("image/svg+xml");
    }
    None
}

fn is_jxl(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xff, 0x0a])
        || bytes.starts_with(&[
            0x00, 0x00, 0x00, 0x0c, b'J', b'X', b'L', b' ', 0x0d, 0x0a, 0x87, 0x0a,
        ])
}

/// AVIF and HEIF are both ISO-BMFF. AVIF wins when its brand is present,
/// because those files also list the generic `mif1` brand.
fn sniff_isobmff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return None;
    }
    let declared = u32::from_be_bytes(bytes[0..4].try_into().ok()?) as usize;
    let end = declared.clamp(16, bytes.len().min(256));
    let mut brands = Vec::new();
    brands.push(&bytes[8..12]);
    let mut i = 16;
    while i + 4 <= end {
        brands.push(&bytes[i..i + 4]);
        i += 4;
    }
    if brands.iter().any(|b| *b == b"avif" || *b == b"avis") {
        return Some("image/avif");
    }
    if brands.iter().any(|b| {
        matches!(
            *b,
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"hevm" | b"hevs"
        )
    }) {
        return Some("image/heic");
    }
    if brands
        .iter()
        .any(|b| *b == b"heif" || *b == b"mif1" || *b == b"msf1")
    {
        return Some("image/heif");
    }
    None
}

fn is_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    let head = head
        .strip_prefix(&[0xef, 0xbb, 0xbf])
        .unwrap_or(head);
    let Ok(text) = std::str::from_utf8(head) else {
        return false;
    };
    let lower = text.trim_start().to_ascii_lowercase();
    if lower.starts_with("<!doctype html") || lower.starts_with("<html") {
        return false;
    }
    lower.starts_with("<svg") || (lower.starts_with("<?xml") && lower.contains("<svg"))
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
    fn accepts_svg_jxl_and_other_images() {
        assert_eq!(
            image_content_type("a.svg", b"<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
            Some("image/svg+xml")
        );
        assert_eq!(image_content_type("a.jxl", &[0xff, 0x0a, 0x00]), Some("image/jxl"));
        assert_eq!(image_content_type("a.tif", b"II*\x00rest"), Some("image/tiff"));
        let heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heic";
        assert_eq!(image_content_type("a.heic", heic), Some("image/heic"));
    }

    #[test]
    fn rejects_non_images() {
        assert_eq!(image_content_type("a.svg", b"<html><svg></svg>"), None);
        assert_eq!(image_content_type("a.pdf", b"%PDF-1.7"), None);
        assert_eq!(image_content_type("a.html", b"<html>"), None);
        assert_eq!(image_content_type("a.svg", b"<?xml version='1.0'?><html>"), None);
    }
}
