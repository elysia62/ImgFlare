//! Public images: `GET /i/<id>.<ext>`.
//!
//! No session, no cookie, no token. The name looks like
//! `4L4V3tZnrvk16TmODWWOyZWDTzov1YY4.png`. A wrong extension, or anything that
//! is not an image, is a 404 and the body is not sent.

use crate::error::{ApiError, ApiResult};
use crate::r2::R2;
use crate::response;
use crate::utils::{canonical_image_type, extension_matches, parse_public_image};
use worker::{Headers, Request, Response};

/// `GET|HEAD /i/<id>.<ext>`
pub async fn handle_get(req: &Request, r2: &R2, name: &str) -> ApiResult<Response> {
    let (id, ext) = parse_public_image(name).ok_or(ApiError::NotFound("not_found"))?;
    let key = format!("i/{id}.{ext}");

    if req.method() == worker::Method::Head {
        let head = r2
            .head(&key)
            .await?
            .ok_or(ApiError::NotFound("not_found"))?;
        let content_type = canonical_image_type(head.content_type.as_deref().unwrap_or(""))
            .ok_or(ApiError::NotFound("not_found"))?;
        if !extension_matches(&ext, content_type) {
            return Err(ApiError::NotFound("not_found"));
        }
        return Ok(response::with_headers(
            200,
            image_headers(content_type),
            Vec::new(),
        ));
    }

    let object = r2.get(&key).await?;
    let stored = object
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default();
    let Some(content_type) = canonical_image_type(&stored) else {
        return Err(ApiError::NotFound("not_found"));
    };
    if !extension_matches(&ext, content_type) {
        return Err(ApiError::NotFound("not_found"));
    }
    Ok(object
        .with_status(200)
        .with_headers(image_headers(content_type)))
}

fn image_headers(content_type: &str) -> Headers {
    let headers = Headers::new();
    let _ = headers.set("Content-Type", content_type);
    let _ = headers.set("Cache-Control", "public, max-age=31536000, immutable");
    let _ = headers.set("X-Content-Type-Options", "nosniff");
    // SVG can carry script. Sandbox keeps a direct open from touching the
    // login cookie; `<img>` still paints the picture.
    if content_type == "image/svg+xml" {
        let _ = headers.set("Content-Security-Policy", "sandbox");
    }
    headers
}
