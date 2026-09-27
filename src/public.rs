//! Public file serving: `GET /f/<sha256>`.
//!
//! Uploaded files are public — no session, no cookie, no token, no Turnstile.
//! Every other route on this origin requires authentication.
//!
//! Because the admin panel shares this origin, an upload that a browser is
//! willing to *execute as a document* would be a session-stealing XSS hole: the
//! script would run on the panel origin, so the CSRF `Origin` check would pass
//! (the origin genuinely matches) and it could call the API with the admin's
//! cookie. The response type is therefore chosen defensively:
//!
//! | Stored type | Served as | Why |
//! |---|---|---|
//! | images, `application/pdf`, `text/*`, `application/json`, archives | real type | not documents that can run script |
//! | `image/svg+xml` | real type + `sandbox` | renders as an image; `sandbox` blocks the embedded script an SVG may carry |
//! | `text/html`, `application/xml` | `text/plain` | these execute on navigation; source is still readable |
//! | `application/javascript` | real type + `sandbox` | a top-level JS navigation displays as text rather than running, and nothing here injects it via `<script src>`; keeping the real type is what lets `.user.js` URLs be installed by Tampermonkey |
//!
//! `Content-Security-Policy: sandbox` is the load-bearing part: it gives the
//! document an opaque origin and blocks script execution. `nosniff` is applied
//! everywhere so a browser cannot override the declared type.

use crate::config::Config;
use crate::error::{ApiError, ApiResult};
use crate::response;
use crate::utils::normalize_sha256;
use worker::{Env, Request, Response};

/// How a stored content type should be handed back.
pub struct Serving {
    pub content_type: &'static str,
    /// Adds `Content-Security-Policy: sandbox` to neutralise active content.
    pub sandbox: bool,
}

/// Decide how to serve a stored content type.
pub fn plan_serving(stored_type: &str) -> Serving {
    let base = stored_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    match base.as_str() {
        // --- render inline, real type, no active content ------------------
        "image/png" => plain("image/png"),
        "image/jpeg" => plain("image/jpeg"),
        "image/webp" => plain("image/webp"),
        "image/gif" => plain("image/gif"),
        "image/avif" => plain("image/avif"),
        "image/bmp" => plain("image/bmp"),
        "image/x-icon" => plain("image/x-icon"),
        "text/plain" => plain("text/plain; charset=utf-8"),
        "text/css" => plain("text/css; charset=utf-8"),
        "application/json" => plain("application/json"),
        "application/zip" => plain("application/zip"),
        "application/x-7z-compressed" => plain("application/x-7z-compressed"),

        // --- real type, but sandboxed -------------------------------------
        // SVGs must keep their type to render in Markdown; the sandbox blocks
        // any `<script>` they carry if the URL is opened directly.
        "image/svg+xml" => sandboxed("image/svg+xml"),
        "application/pdf" => sandboxed("application/pdf"),
        // Keeping the real type is what makes `.user.js` URLs installable by
        // Tampermonkey. A top-level navigation to a JS URL shows source rather
        // than running it, and the sandbox covers the rest.
        "application/javascript" => sandboxed("application/javascript"),

        // --- these execute on navigation: downgrade to source text --------
        "text/html" | "text/xml" | "application/xml" => {
            sandboxed("text/plain; charset=utf-8")
        }

        // --- unrecognised: let the browser do nothing clever --------------
        _ => sandboxed("application/octet-stream"),
    }
}

const fn plain(content_type: &'static str) -> Serving {
    Serving {
        content_type,
        sandbox: false,
    }
}

const fn sandboxed(content_type: &'static str) -> Serving {
    Serving {
        content_type,
        sandbox: true,
    }
}

/// `GET|HEAD /f/<sha256>`
pub async fn handle_get(req: &Request, env: &Env, _cfg: &Config, hash: &str) -> ApiResult<Response> {
    let sha256 = normalize_sha256(hash).ok_or(ApiError::NotFound("not_found"))?;

    let bucket = env
        .bucket("BUCKET")
        .map_err(|e| ApiError::Internal(format!("R2 binding `BUCKET` unavailable: {e}")))?;

    let object = bucket
        .get(format!("f/{sha256}"))
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 get failed: {e}")))?
        .ok_or(ApiError::NotFound("not_found"))?;

    let stored_type = object
        .http_metadata()
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let plan = plan_serving(&stored_type);

    let headers = worker::Headers::new();
    let mut set = vec![
        ("Content-Type", plan.content_type),
        // Content addressed: the bytes behind a key can never change.
        ("Cache-Control", "public, max-age=31536000, immutable"),
        ("X-Content-Type-Options", "nosniff"),
    ];
    if plan.sandbox {
        set.push(("Content-Security-Policy", "sandbox"));
    }
    for (name, value) in set {
        headers
            .set(name, value)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
    }

    // `HEAD` carries the same headers but no body.
    if req.method() == worker::Method::Head {
        return Ok(response::with_headers(200, headers, Vec::new()));
    }

    match object.body() {
        // Hand the stream to the runtime so the Worker spends no CPU time
        // copying bytes through Wasm.
        Some(body) => {
            let stream = body
                .response_body()
                .map_err(|e| ApiError::Internal(format!("R2 body failed: {e}")))?;
            Response::from_body(stream)
                .map(|r| r.with_headers(headers))
                .map_err(|e| ApiError::Internal(format!("response build failed: {e}")))
        }
        None => Ok(response::with_headers(200, headers, Vec::new())),
    }
}
