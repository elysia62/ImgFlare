//! Public images: `GET /i/<sha256>`.
//!
//! No session, no cookie, no token. Only the image types accepted at upload are
//! served with their real content type. Anything else is sent as
//! `application/octet-stream` with `Content-Security-Policy: sandbox`, so a
//! stored object cannot execute on the panel origin.

use crate::error::{ApiError, ApiResult};
use crate::r2::R2;
use crate::response;
use crate::utils::normalize_sha256;
use worker::{Headers, Request, Response};

/// How a stored content type should be handed back.
pub struct Serving {
    pub content_type: &'static str,
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
        "image/png" => plain("image/png"),
        "image/jpeg" => plain("image/jpeg"),
        "image/webp" => plain("image/webp"),
        "image/gif" => plain("image/gif"),
        "image/avif" => plain("image/avif"),
        "image/bmp" => plain("image/bmp"),
        "image/x-icon" => plain("image/x-icon"),
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

/// `GET|HEAD /i/<sha256>`
pub async fn handle_get(req: &Request, r2: &R2, hash: &str) -> ApiResult<Response> {
    let sha256 = normalize_sha256(hash).ok_or(ApiError::NotFound("not_found"))?;
    let key = format!("i/{sha256}");
    let bucket = r2.bucket.clone();

    if req.method() == worker::Method::Head {
        let head = r2
            .head(&bucket, &key)
            .await?
            .ok_or(ApiError::NotFound("not_found"))?;
        let plan = plan_serving(head.content_type.as_deref().unwrap_or(""));
        return Ok(response::with_headers(200, image_headers(&plan), Vec::new()));
    }

    let object = r2.get(&bucket, &key).await?;
    let stored = object
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let plan = plan_serving(&stored);
    Ok(object
        .with_status(200)
        .with_headers(image_headers(&plan)))
}

fn image_headers(plan: &Serving) -> Headers {
    let headers = Headers::new();
    let _ = headers.set("Content-Type", plan.content_type);
    let _ = headers.set("Cache-Control", "public, max-age=31536000, immutable");
    let _ = headers.set("X-Content-Type-Options", "nosniff");
    if plan.sandbox {
        let _ = headers.set("Content-Security-Policy", "sandbox");
    }
    headers
}
