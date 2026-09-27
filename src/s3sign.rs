//! AWS Signature Version 4 for the R2 S3 API.
//!
//! Pure functions: no Worker types, so the signing rules can be checked on the
//! host. Region is `auto`, which is what R2 expects.

use crate::utils::{hmac_sha256, sha256_hex};

/// SHA-256 of an empty payload. GET, HEAD and DELETE sign this.
pub const EMPTY_PAYLOAD_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// `(YYYYMMDD, YYYYMMDDTHHMMSSZ)` for an instant, in UTC.
pub fn aws_timestamps(unix_ms: i64) -> (String, String) {
    let secs = unix_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400) as u32;
    let (year, month, day) = civil_from_days(days);
    let hour = sod / 3600;
    let minute = (sod % 3600) / 60;
    let second = sod % 60;
    let date = format!("{year:04}{month:02}{day:02}");
    let amz = format!("{date}T{hour:02}{minute:02}{second:02}Z");
    (date, amz)
}

/// Encode a URL path the way SigV4 requires: every byte except unreserved
/// characters and `/` becomes `%HH`.
pub fn encode_uri_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if is_unreserved(byte) || byte == b'/' {
            out.push(byte as char);
        } else {
            out.push('%');
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

/// Standard base64 (with padding). Checksum headers want this, not base64url.
pub fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | data[i + 2] as u32;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        out.push(TABLE[(n & 0x3f) as usize] as char);
        i += 3;
    }
    if i < data.len() {
        let b0 = data[i] as u32;
        let b1 = data.get(i + 1).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8);
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        if i + 1 < data.len() {
            out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
            out.push('=');
        } else {
            out.push('=');
            out.push('=');
        }
    }
    out
}

/// Inputs for one SigV4 signature. Header names must already be lowercase.
pub struct SignRequest<'a> {
    pub method: &'a str,
    pub canonical_uri: &'a str,
    pub headers: &'a [(&'a str, &'a str)],
    pub payload_hash: &'a str,
    pub access_key: &'a str,
    pub secret: &'a str,
    pub date: &'a str,
    pub amz_date: &'a str,
}

/// Build the `Authorization` header value.
///
/// `headers` must already include `host`, `x-amz-date` and `x-amz-content-sha256`.
/// They are sorted here.
pub fn authorization(req: &SignRequest<'_>) -> String {
    let mut headers: Vec<(&str, &str)> = req.headers.to_vec();
    headers.sort_by(|a, b| a.0.cmp(b.0));

    let mut canonical_headers = String::new();
    let mut signed = String::new();
    for (i, (name, value)) in headers.iter().enumerate() {
        canonical_headers.push_str(name);
        canonical_headers.push(':');
        canonical_headers.push_str(value.trim());
        canonical_headers.push('\n');
        if i > 0 {
            signed.push(';');
        }
        signed.push_str(name);
    }

    let canonical_request = format!(
        "{method}\n{uri}\n\n{canonical_headers}\n{signed}\n{payload}",
        method = req.method,
        uri = req.canonical_uri,
        payload = req.payload_hash,
    );
    let scope = format!("{}/auto/s3/aws4_request", req.date);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        req.amz_date,
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac_sha256(format!("AWS4{}", req.secret).as_bytes(), req.date.as_bytes());
    let k_region = hmac_sha256(&k_date, b"auto");
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = sha256_hex_from_hmac(&k_signing, string_to_sign.as_bytes());

    format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={signed}, Signature={signature}",
        req.access_key, scope
    )
}

fn sha256_hex_from_hmac(key: &[u8], message: &[u8]) -> String {
    crate::utils::to_hex(&hmac_sha256(key, message))
}

fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
}

/// Howard Hinnant's `civil_from_days`, days since Unix epoch.
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_and_known_date() {
        assert_eq!(aws_timestamps(0), ("19700101".into(), "19700101T000000Z".into()));
        assert_eq!(
            aws_timestamps(1_735_689_600_000),
            ("20250101".into(), "20250101T000000Z".into())
        );
    }

    #[test]
    fn path_encoding_leaves_slashes() {
        assert_eq!(encode_uri_path("/bkt/i/abc"), "/bkt/i/abc");
        assert_eq!(encode_uri_path("/bkt/a b"), "/bkt/a%20b");
    }

    #[test]
    fn base64_padding() {
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
    }

    #[test]
    fn signs_a_fixed_request() {
        let headers = [
            ("host", "abc.r2.cloudflarestorage.com"),
            ("x-amz-content-sha256", EMPTY_PAYLOAD_SHA256),
            ("x-amz-date", "20250101T000000Z"),
        ];
        let header = authorization(&SignRequest {
            method: "GET",
            canonical_uri: "/bucket/i/abc",
            headers: &headers,
            payload_hash: EMPTY_PAYLOAD_SHA256,
            access_key: "AKIDEXAMPLE",
            secret: "secret",
            date: "20250101",
            amz_date: "20250101T000000Z",
        });
        assert_eq!(
            header,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20250101/auto/s3/aws4_request, \
             SignedHeaders=host;x-amz-content-sha256;x-amz-date, \
             Signature=b69f498258603753d60b3eabbc39db7c4540f77471ec8a9413982d622d7ee6ac"
        );
    }
}
