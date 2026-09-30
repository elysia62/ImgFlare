//! Public originals and thumbnails. D1 is checked before every edge-cache hit.
use crate::utils::{canonical_image_type, extension_matches, parse_public_image};
use crate::{
    db::Db,
    error::{ApiError, ApiResult},
    r2::R2,
};
use worker::{Cache, Context, Headers, Method, Request, RequestInit, Response};

pub async fn handle_get(
    req: &Request,
    r2: &R2,
    db: &Db,
    ctx: &Context,
    prefix: &str,
    name: &str,
) -> ApiResult<Response> {
    let (id, ext) = parse_public_image(name).ok_or(ApiError::NotFound("not_found"))?;
    let key = format!("{prefix}/{id}.{ext}");
    let record = db
        .find_file_by_key(&key)
        .await?
        .ok_or(ApiError::NotFound("not_found"))?;
    let mut url = req.url()?;
    url.set_query(None);
    let cache_headers = Headers::new();
    // Range and conditional headers are interpreted by Cache.match().
    for name in ["Range", "If-None-Match", "If-Modified-Since"] {
        if name == "Range" && req.method() == Method::Head {
            continue;
        }
        if let Some(value) = req.headers().get(name)? {
            cache_headers.set(name, &value)?;
        }
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Get).with_headers(cache_headers);
    let cache_req = Request::new_with_init(url.as_str(), &init)?;
    // If-Range needs validation against origin metadata before interpreting Range.
    if req.headers().get("If-Range")?.is_none() {
        if let Some(cached) = Cache::default().get(&cache_req, false).await? {
            if req.method() != Method::Head {
                return Ok(cached);
            }
            return Ok(Response::empty()?
                .with_status(cached.status_code())
                .with_headers(cached.headers().clone()));
        }
    }
    let (content_type, size, etag, object_modified) = if prefix == "i" {
        (
            record.content_type.clone(),
            record.size as u64,
            record.etag.clone(),
            None,
        )
    } else {
        let head = r2
            .head(&key)
            .await?
            .ok_or(ApiError::NotFound("not_found"))?;
        (
            head.content_type.unwrap_or_default(),
            head.size,
            head.etag,
            head.last_modified,
        )
    };
    let content_type =
        canonical_image_type(&content_type).ok_or(ApiError::NotFound("not_found"))?;
    if !extension_matches(&ext, content_type) {
        return Err(ApiError::NotFound("not_found"));
    }
    let modified = object_modified.unwrap_or_else(|| {
        worker::js_sys::Date::new(&worker::wasm_bindgen::JsValue::from_f64(
            record.created_at as f64,
        ))
        .to_utc_string()
        .as_string()
        .unwrap_or_default()
    });
    let headers = image_headers(content_type, size, etag.as_deref(), &modified)?;
    let none_match = req.headers().get("If-None-Match")?;
    let not_modified = match none_match {
        Some(value) => {
            value.trim() == "*"
                || etag.as_deref().is_some_and(|e| {
                    value
                        .split(',')
                        .any(|v| v.trim().trim_start_matches("W/") == e)
                })
        }
        None => req.headers().get("If-Modified-Since")?.is_some_and(|v| {
            let date = worker::js_sys::Date::parse(&v);
            date.is_finite() && worker::js_sys::Date::parse(&modified) <= date
        }),
    };
    if not_modified {
        headers.delete("Content-Length")?;
        return Ok(Response::empty()?.with_status(304).with_headers(headers));
    }
    if req.method() == Method::Head {
        return Ok(Response::empty()?.with_headers(headers));
    }
    let range_header = req.headers().get("Range")?;
    let if_range = req.headers().get("If-Range")?;
    let allow_range = if_range
        .as_deref()
        .is_none_or(|v| etag.as_deref() == Some(v) || v == modified);
    let range = if allow_range { range_header } else { None };
    let normalized = match range {
        Some(value) => match byte_range(&value, size) {
            Some((start, end)) => {
                headers.set("Content-Range", &format!("bytes {start}-{end}/{size}"))?;
                headers.set("Content-Length", &(end - start + 1).to_string())?;
                Some(format!("bytes={start}-{end}"))
            }
            None => {
                headers.delete("Content-Length")?;
                headers.set("Content-Range", &format!("bytes */{size}"))?;
                return Ok(Response::empty()?.with_status(416).with_headers(headers));
            }
        },
        None => None,
    };
    let mut object = r2.get_range(&key, normalized.as_deref()).await?;
    // Preserve R2 validators; never forward S3 metadata or credentials.
    for name in ["ETag"] {
        if let Some(value) = object.headers().get(name)? {
            headers.set(name, &value)?;
        }
    }
    if normalized.is_some() && object.status_code() != 206 {
        return Err(ApiError::Internal("R2 ignored a byte range".into()));
    }
    object = object
        .with_headers(headers)
        .with_status(if normalized.is_some() { 206 } else { 200 });
    if normalized.is_none() {
        let cached = object.cloned()?;
        let key = url.to_string();
        ctx.wait_until(async move {
            if let Err(error) = Cache::default().put(key, cached).await {
                worker::console_error!("image cache write failed: {error}");
            }
        });
    }
    Ok(object)
}

fn image_headers(
    content_type: &str,
    size: u64,
    etag: Option<&str>,
    modified: &str,
) -> ApiResult<Headers> {
    let headers = Headers::new();
    headers.set("Content-Type", content_type)?;
    headers.set("Content-Length", &size.to_string())?;
    headers.set("Cache-Control", "public, max-age=60, s-maxage=86400")?;
    headers.set("Accept-Ranges", "bytes")?;
    headers.set("Last-Modified", modified)?;
    headers.set("X-Content-Type-Options", "nosniff")?;
    if let Some(etag) = etag.filter(|s| !s.is_empty()) {
        headers.set("ETag", etag)?;
    }
    if content_type == "image/svg+xml" {
        headers.set("Content-Security-Policy", "sandbox")?;
    }
    Ok(headers)
}

fn byte_range(value: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let value = value.strip_prefix("bytes=")?;
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let count = end.parse::<u64>().ok()?.min(size);
        return (count > 0).then_some((size - count, size - 1));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    (start < size && start <= end).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::byte_range;
    #[test]
    fn ranges_cover_suffix_open_end_and_invalid_requests() {
        assert_eq!(byte_range("bytes=2-4", 10), Some((2, 4)));
        assert_eq!(byte_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(byte_range("bytes=8-", 10), Some((8, 9)));
        assert_eq!(byte_range("bytes=1-99", 10), Some((1, 9)));
        for value in [
            "bytes=11-",
            "bytes=-0",
            "bytes=5-2",
            "bytes=0-1,3-4",
            "junk",
        ] {
            assert_eq!(byte_range(value, 10), None);
        }
    }
}
