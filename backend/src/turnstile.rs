//! Cloudflare Turnstile verification.
//!
//! The widget runs in the browser, but the token it produces is *always* checked
//! server-side against `siteverify`. A front-end-only check would be trivially
//! bypassed.

use crate::config::secret;
use crate::error::{ApiError, ApiResult};
use serde::Deserialize;
use worker::{Env, Fetch, Method, Request, RequestInit};

const SITEVERIFY: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

#[derive(Deserialize)]
struct SiteVerifyResponse {
    success: bool,
}

/// Verify a Turnstile token.
///
/// `remote_ip` is optional; passing it lets Cloudflare apply per-IP heuristics.
pub async fn verify(env: &Env, token: &str, remote_ip: Option<&str>) -> ApiResult<()> {
    if token.is_empty() {
        return Err(ApiError::Forbidden("turnstile_missing"));
    }

    let secret_key = secret(env, "TURNSTILE_SECRET")?;

    let mut form: Vec<(&str, &str)> = vec![("secret", secret_key.as_str()), ("response", token)];
    if let Some(ip) = remote_ip {
        form.push(("remoteip", ip));
    }
    let body = form
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");

    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_body(Some(body.into()));

    let mut req =
        Request::new_with_init(SITEVERIFY, &init).map_err(|e| ApiError::Internal(e.to_string()))?;
    req.headers_mut()
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .set("Content-Type", "application/x-www-form-urlencoded")
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let mut resp = Fetch::Request(req)
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("turnstile request failed: {e}")))?;

    let parsed: SiteVerifyResponse = resp
        .json()
        .await
        .map_err(|e| ApiError::Internal(format!("turnstile response invalid: {e}")))?;

    if parsed.success {
        Ok(())
    } else {
        // The error codes would reveal which widget/secret is misconfigured, so
        // they are never echoed to the client.
        Err(ApiError::Forbidden("turnstile_failed"))
    }
}

/// Minimal percent-encoding for the `application/x-www-form-urlencoded` body.
fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
