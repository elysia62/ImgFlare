//! Response helpers.
//!
//! All success responses share the shape:
//!
//! ```json
//! { "success": true, ...payload }
//! ```
//!
//! Errors are produced by [`crate::error::ApiError`] and always look like:
//!
//! ```json
//! { "success": false, "error": "unauthorized" }
//! ```

use serde::Serialize;
use worker::{Headers, Response, ResponseBuilder};

/// `200 { "success": true, ... }`
pub fn ok<T: Serialize>(payload: T) -> Response {
    let body = serde_json::json!({ "success": true, "data": payload });
    json(body, 200)
}

/// `200` with an explicit top-level object (used where the spec dictates the
/// exact field layout, e.g. `{ success, exists, file }`).
pub fn ok_raw(body: serde_json::Value) -> Response {
    json(body, 200)
}

/// An empty `204`.
pub fn no_content() -> Response {
    Response::empty().unwrap().with_status(204)
}

/// Serialise a JSON value with the right headers.
pub fn json(body: serde_json::Value, status: u16) -> Response {
    Response::from_json(&body)
        .unwrap_or_else(|_| Response::error("internal_error", 500).unwrap())
        .with_status(status)
}

/// Build a response with explicit headers, for things like file downloads.
///
/// Uses `fixed()` because the body is already fully materialised — a fixed
/// `Content-Length` is preferable to a stream here.
pub fn with_headers(status: u16, headers: Headers, body: Vec<u8>) -> Response {
    ResponseBuilder::new()
        .with_status(status)
        .with_headers(headers)
        .fixed(body)
}

/// `Content-Security-Policy` used on the admin HTML pages.
///
/// Everything is self-hosted; Turnstile is the only external origin allowed, and
/// it is loaded as a script.
pub fn admin_csp() -> &'static str {
    "default-src 'self'; \
     script-src 'self' https://challenges.cloudflare.com; \
     frame-src 'self' https://challenges.cloudflare.com; \
     style-src 'self'; \
     img-src 'self' data: https:; \
     connect-src 'self'; \
     form-action 'self'; \
     base-uri 'none'; \
     object-src 'none'"
}
