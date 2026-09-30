//! R2 via the S3 API.
//!
//! The bucket is not a Worker binding. Credentials are an access key the
//! operator creates in the dashboard and reuses from whatever else syncs the
//! same bucket.

use crate::config::R2Settings;
use crate::error::{ApiError, ApiResult};
use crate::s3sign::{self, EMPTY_PAYLOAD_SHA256};
use crate::utils::{now_ms, sha256_bytes};
use std::collections::HashMap;
use worker::{CacheMode, Fetch, Headers, Method, Request, RequestInit, RequestRedirect, Response};

/// What `HEAD` tells us. Metadata keys have the `x-amz-meta-` prefix removed.
pub struct ObjectHead {
    pub content_type: Option<String>,
    pub size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub metadata: HashMap<String, String>,
}

/// Options for `PutObject`. The body hash is computed here and sent as
/// `x-amz-checksum-sha256`, so a corrupted transfer is rejected by R2.
#[derive(Clone)]
pub struct PutOptions {
    pub content_type: String,
    pub cache_control: Option<String>,
    pub metadata: Vec<(String, String)>,
}

pub struct R2 {
    account_id: String,
    access_key_id: String,
    secret_access_key: String,
    bucket: String,
}

impl R2 {
    pub fn new(settings: &R2Settings) -> Self {
        Self {
            account_id: settings.account_id.clone(),
            access_key_id: settings.access_key_id.clone(),
            secret_access_key: settings.secret_access_key.clone(),
            bucket: settings.bucket.clone(),
        }
    }

    /// Upload `body`. Returns the ETag R2 assigned, which may be empty.
    pub async fn put(&self, key: &str, body: &[u8], opts: PutOptions) -> ApiResult<String> {
        self.put_body(
            key,
            worker::js_sys::Uint8Array::from(body).into(),
            &sha256_bytes(body),
            opts,
        )
        .await
    }

    pub async fn put_file(
        &self,
        key: &str,
        file: &worker::web_sys::File,
        digest: &[u8; 32],
        opts: PutOptions,
    ) -> ApiResult<String> {
        self.put_body(key, file.clone().into(), digest, opts).await
    }

    async fn put_body(
        &self,
        key: &str,
        body: worker::wasm_bindgen::JsValue,
        digest: &[u8; 32],
        opts: PutOptions,
    ) -> ApiResult<String> {
        let payload_hash = crate::utils::to_hex(digest);
        let mut extra = vec![
            ("content-type".to_string(), opts.content_type),
            ("x-amz-checksum-sha256".to_string(), s3sign::base64(digest)),
        ];
        if let Some(cache) = opts.cache_control {
            extra.push(("cache-control".to_string(), cache));
        }
        for (name, value) in opts.metadata {
            extra.push((
                format!("x-amz-meta-{}", name.to_ascii_lowercase()),
                header_safe(&value),
            ));
        }

        let mut resp = self
            .call(Method::Put, key, Some(body), &payload_hash, extra)
            .await?;
        ensure_success(&mut resp, "put").await?;
        Ok(resp
            .headers()
            .get("etag")
            .ok()
            .flatten()
            .unwrap_or_default())
    }

    /// Download an object. `404` is [`ApiError::NotFound`].
    pub async fn get(&self, key: &str) -> ApiResult<Response> {
        self.get_range(key, None).await
    }

    pub async fn get_range(&self, key: &str, range: Option<&str>) -> ApiResult<Response> {
        let mut resp = self
            .call(
                Method::Get,
                key,
                None,
                EMPTY_PAYLOAD_SHA256,
                range
                    .map(|r| vec![("range".into(), r.into())])
                    .unwrap_or_default(),
            )
            .await?;
        if resp.status_code() == 404 {
            return Err(ApiError::NotFound("not_found"));
        }
        ensure_success(&mut resp, "get").await?;
        Ok(resp)
    }

    /// `None` when the key does not exist.
    pub async fn head(&self, key: &str) -> ApiResult<Option<ObjectHead>> {
        let mut resp = self
            .call(Method::Head, key, None, EMPTY_PAYLOAD_SHA256, Vec::new())
            .await?;
        if resp.status_code() == 404 {
            return Ok(None);
        }
        ensure_success(&mut resp, "head").await?;

        let headers = resp.headers();
        let content_type = headers.get("content-type").ok().flatten();
        let size = headers
            .get("content-length")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        let mut metadata = HashMap::new();
        for (name, value) in headers.entries() {
            let lower = name.to_ascii_lowercase();
            if let Some(key) = lower.strip_prefix("x-amz-meta-") {
                metadata.insert(key.to_string(), value);
            }
        }

        Ok(Some(ObjectHead {
            content_type,
            size,
            etag: headers.get("etag")?,
            last_modified: headers.get("last-modified")?,
            metadata,
        }))
    }

    /// Delete an object. A missing key is not an error.
    pub async fn delete(&self, key: &str) -> ApiResult<()> {
        let mut resp = self
            .call(Method::Delete, key, None, EMPTY_PAYLOAD_SHA256, Vec::new())
            .await?;
        if resp.status_code() == 404 {
            return Ok(());
        }
        ensure_success(&mut resp, "delete").await
    }

    async fn call(
        &self,
        method: Method,
        key: &str,
        body: Option<worker::wasm_bindgen::JsValue>,
        payload_hash: &str,
        extra: Vec<(String, String)>,
    ) -> ApiResult<Response> {
        let started = now_ms();
        let method_name = method.as_ref().to_string();
        let host = format!("{}.r2.cloudflarestorage.com", self.account_id);
        let canonical_uri = s3sign::encode_uri_path(&format!("/{}/{key}", self.bucket));
        let url = format!("https://{host}{canonical_uri}");
        let (date, amz_date) = s3sign::aws_timestamps(now_ms());

        let mut pairs = vec![
            ("host".to_string(), host),
            ("x-amz-date".to_string(), amz_date.clone()),
            ("x-amz-content-sha256".to_string(), payload_hash.to_string()),
        ];
        pairs.extend(extra);

        let refs: Vec<(&str, &str)> = pairs
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let auth = s3sign::authorization(&s3sign::SignRequest {
            method: method.as_ref(),
            canonical_uri: &canonical_uri,
            headers: &refs,
            payload_hash,
            access_key: &self.access_key_id,
            secret: &self.secret_access_key,
            date: &date,
            amz_date: &amz_date,
        });

        let headers = Headers::new();
        for (name, value) in &pairs {
            if name == "host" {
                continue;
            }
            headers.set(name, value)?;
        }
        headers.set("Authorization", &auth)?;

        let mut init = RequestInit::new();
        init.with_method(method)
            .with_headers(headers)
            .with_redirect(RequestRedirect::Manual)
            .with_cache(CacheMode::NoStore);
        init.with_body(body);

        let request = Request::new_with_init(&url, &init)?;
        use worker::wasm_bindgen::JsCast;
        let constructor =
            worker::js_sys::Reflect::get(&worker::js_sys::global(), &"AbortSignal".into())?;
        let timeout: worker::js_sys::Function =
            worker::js_sys::Reflect::get(&constructor, &"timeout".into())?.dyn_into()?;
        let signal: worker::web_sys::AbortSignal =
            timeout.call1(&constructor, &60_000.into())?.dyn_into()?;
        let signal = worker::AbortSignal::from(signal);
        let result = Fetch::Request(request)
            .send_with_signal(&signal)
            .await
            .map_err(|e| ApiError::Internal(format!("R2 request failed: {e}")));
        worker::console_log!(
            "{}",
            serde_json::json!({"event":"r2", "method":method_name, "key":key, "status":result.as_ref().ok().map(|r| r.status_code()), "duration_ms":now_ms()-started})
        );
        result
    }
}

async fn ensure_success(resp: &mut Response, op: &str) -> ApiResult<()> {
    let status = resp.status_code();
    if (200..300).contains(&status) {
        return Ok(());
    }
    let body = resp.text().await.unwrap_or_default();
    let body: String = body.chars().take(240).collect();
    if status == 400 && body.contains("BadDigest") {
        return Err(ApiError::BadRequest("checksum_mismatch"));
    }
    Err(ApiError::Internal(format!(
        "R2 {op} failed: {status} {body}"
    )))
}

/// Header values must be ASCII. Percent-encode everything else.
fn header_safe(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
