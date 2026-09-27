//! Upload handling: `/api/upload/check` and `/api/upload`.
//!
//! The deduplication contract:
//!
//! * The R2 key is `f/<sha256>` — content addressed, so identical bytes always
//!   map to the same key and therefore the same public URL.
//! * `/api/upload/check` is a fast path only. `/api/upload` re-checks the hash
//!   itself, because two clients can race past the check simultaneously.
//! * If the INSERT loses a race, the UNIQUE constraint on `sha256` fires and we
//!   re-read the winning row instead of returning an error.

use crate::config::Config;
use crate::db::{Db, FileRecord};
use crate::error::{ApiError, ApiResult};
use crate::utils::{
    content_type_for_filename, escape_markdown_text, normalize_sha256, now_ms, random_token,
};
use serde::{Deserialize, Serialize};
use worker::{Bucket, Env, FormEntry, HttpMetadata};

/// The JSON shape of a stored file, shared verbatim with the TypeScript clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub id: String,
    pub sha256: String,
    pub name: String,
    pub content_type: String,
    pub size: i64,
    pub url: String,
    pub markdown: String,
    pub created_at: i64,
}

impl FileInfo {
    /// Build the client-facing view of a row, including URL and Markdown.
    pub fn from_record(record: &FileRecord, cfg: &Config) -> Self {
        let url = cfg.public_url(&record.sha256);
        Self {
            id: record.id.clone(),
            sha256: record.sha256.clone(),
            name: record.original_name.clone(),
            content_type: record.content_type.clone(),
            size: record.size,
            markdown: build_markdown(&record.original_name, &record.content_type, &url),
            url,
            created_at: record.created_at,
        }
    }
}

/// Images get `![name](url)`; everything else gets `[name](url)`.
///
/// The filename is escaped so brackets or parentheses in a name cannot break out
/// of the Markdown construct.
pub fn build_markdown(name: &str, content_type: &str, url: &str) -> String {
    let label = escape_markdown_text(name);
    if content_type.starts_with("image/") {
        format!("![{label}]({url})")
    } else {
        format!("[{label}]({url})")
    }
}

/// The R2 key for a given content hash.
pub fn r2_key_for(sha256: &str) -> String {
    format!("f/{sha256}")
}

// ---------------------------------------------------------------------------
// /api/upload/check
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CheckRequest {
    pub sha256: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub size: Option<i64>,
}

/// Body of a successful check.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResponse {
    pub success: bool,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<FileInfo>,
}

/// Look up a hash without uploading. Requires authentication, otherwise this
/// would be an oracle for probing arbitrary content.
pub async fn handle_check(
    db: &Db,
    cfg: &Config,
    body: CheckRequest,
) -> ApiResult<CheckResponse> {
    let sha256 =
        normalize_sha256(&body.sha256).ok_or(ApiError::BadRequest("invalid_sha256"))?;

    match db.find_file_by_sha256(&sha256).await? {
        Some(record) => Ok(CheckResponse {
            success: true,
            exists: true,
            file: Some(FileInfo::from_record(&record, cfg)),
        }),
        None => Ok(CheckResponse {
            success: true,
            exists: false,
            file: None,
        }),
    }
}

// ---------------------------------------------------------------------------
// /api/upload
// ---------------------------------------------------------------------------

/// Outcome of an upload: either freshly stored or deduplicated.
pub struct UploadOutcome {
    pub file: FileInfo,
    pub deduplicated: bool,
}

/// Parse and store an uploaded file.
///
/// `declared_sha256` comes from the `X-File-SHA256` header. It is validated for
/// shape, then enforced as an R2 checksum so corrupted transfers are rejected at
/// the storage layer as well.
pub async fn handle_upload(
    req: &mut worker::Request,
    env: &Env,
    db: &Db,
    cfg: &Config,
    declared_sha256: Option<String>,
) -> ApiResult<UploadOutcome> {
    let declared = declared_sha256
        .as_deref()
        .and_then(normalize_sha256)
        .ok_or(ApiError::BadRequest("invalid_sha256"))?;

    let form = req
        .form_data()
        .await
        .map_err(|_| ApiError::BadRequest("invalid_multipart"))?;

    let entry = form.get("file").ok_or(ApiError::BadRequest("missing_file"))?;

    let file = match entry {
        FormEntry::File(f) => f,
        FormEntry::Field(_) => return Err(ApiError::BadRequest("file_must_be_a_file")),
    };

    let original_name = sanitize_filename(&file.name());
    if original_name.is_empty() {
        return Err(ApiError::BadRequest("empty_filename"));
    }

    let size = file.size();
    if size == 0 {
        return Err(ApiError::BadRequest("empty_file"));
    }
    if size > cfg.max_upload_size {
        return Err(ApiError::PayloadTooLarge);
    }

    // Content-Type is derived from the extension, never trusted from the client.
    let content_type = content_type_for_filename(&original_name)
        .ok_or(ApiError::UnsupportedMediaType("unsupported_file_type"))?;

    let bytes = file
        .bytes()
        .await
        .map_err(|e| ApiError::Internal(format!("reading upload failed: {e}")))?;

    // Re-check against the header — the client could have lied, or the multipart
    // body could have been mangled in transit.
    if bytes.len() != size {
        return Err(ApiError::BadRequest("size_mismatch"));
    }

    // Fast path: someone already stored these exact bytes.
    if let Some(existing) = db.find_file_by_sha256(&declared).await? {
        return Ok(UploadOutcome {
            file: FileInfo::from_record(&existing, cfg),
            deduplicated: true,
        });
    }

    let key = r2_key_for(&declared);
    let bucket = env
        .bucket("BUCKET")
        .map_err(|e| ApiError::Internal(format!("R2 binding `BUCKET` unavailable: {e}")))?;

    // Reject the transfer at the storage layer if the bytes do not hash to what
    // the client claimed. `declared` is 32 raw bytes as hex-decoded.
    let checksum = crate::utils::from_hex(&declared).ok_or(ApiError::BadRequest("invalid_sha256"))?;

    let metadata = HttpMetadata {
        content_type: Some(content_type.to_string()),
        // Immutable: the key is a content hash, so the bytes behind it can never
        // change. Safe to cache essentially forever.
        cache_control: Some("public, max-age=31536000, immutable".to_string()),
        ..Default::default()
    };

    let mut custom = std::collections::HashMap::new();
    custom.insert("original_name".to_string(), original_name.clone());
    custom.insert("sha256".to_string(), declared.clone());

    let object = bucket
        .put(key.clone(), bytes)
        .http_metadata(metadata)
        .custom_metadata(custom)
        .sha256(checksum)
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 put failed: {e}")))?;

    let etag = object.map(|o| o.etag()).unwrap_or_default();

    let record = FileRecord {
        id: random_token(22),
        sha256: declared.clone(),
        r2_key: key,
        original_name: original_name.clone(),
        content_type: content_type.to_string(),
        size: size as i64,
        etag: Some(etag),
        created_at: now_ms(),
    };

    match db.insert_file(&record).await {
        Ok(()) => Ok(UploadOutcome {
            file: FileInfo::from_record(&record, cfg),
            deduplicated: false,
        }),

        // Lost a race against a concurrent upload of the same bytes. The R2
        // object is identical (same content hash, same key), so we simply adopt
        // the winner's row. One object, one row, one URL.
        Err(_) => match db.find_file_by_sha256(&declared).await? {
            Some(existing) => Ok(UploadOutcome {
                file: FileInfo::from_record(&existing, cfg),
                deduplicated: true,
            }),
            // The insert failed for some reason *other* than a duplicate, and
            // there is nothing to fall back to.
            None => Err(ApiError::Internal(
                "insert failed and no duplicate row found".into(),
            )),
        },
    }
}

/// Strip any path component from an uploaded filename.
///
/// A browser normally sends only the basename, but a hand-rolled client could
/// send `../../etc/passwd`. The R2 key never uses the filename anyway; this only
/// protects the stored `original_name` and the rendered UI.
pub fn sanitize_filename(name: &str) -> String {
    let base = name
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(name)
        .trim();

    // Drop control characters, which have no place in a display name.
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();

    // Guard against absurdly long names.
    let limited: String = cleaned.chars().take(255).collect();
    limited.trim().to_string()
}

/// Is the request body a multipart upload?
pub fn is_multipart(req: &worker::Request) -> bool {
    req.headers()
        .get("Content-Type")
        .ok()
        .flatten()
        .map(|ct| ct.to_ascii_lowercase().starts_with("multipart/form-data"))
        .unwrap_or(false)
}

/// Delete an object from the public bucket.
pub async fn delete_object(env: &Env, r2_key: &str) -> ApiResult<()> {
    let bucket: Bucket = env
        .bucket("BUCKET")
        .map_err(|e| ApiError::Internal(format!("R2 binding `BUCKET` unavailable: {e}")))?;
    bucket
        .delete(r2_key.to_string())
        .await
        .map_err(|e| ApiError::Internal(format!("R2 delete failed: {e}")))?;
    Ok(())
}
