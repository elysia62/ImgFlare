//! Upload handling: `/api/upload/check` and `/api/upload`.
//!
//! The deduplication contract:
//!
//! * The public name is a random id plus the real extension, for example
//!   `i/4L4V3tZnrvk16TmODWWOyZWDTzov1YY4.png`. The same bytes still dedupe on
//!   SHA-256 and keep the first name.
//! * `/api/upload/check` is a fast path only. `/api/upload` re-checks the hash
//!   itself, because two clients can race past the check simultaneously.
//! * If the INSERT loses a race, the UNIQUE constraint on `sha256` fires and we
//!   re-read the winning row instead of returning an error.

use crate::config::Config;
use crate::db::{Db, FileRecord};
use crate::error::{ApiError, ApiResult};
use crate::r2::{PutOptions, R2};
use crate::utils::{
    escape_markdown_text, extension_for_type, image_content_type, normalize_sha256, now_ms,
    public_image_id, random_token, sha256_hex,
};
use serde::{Deserialize, Serialize};
use worker::FormEntry;

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
        let url = cfg.public_url(&record.r2_key);
        Self {
            id: record.id.clone(),
            sha256: record.sha256.clone(),
            name: record.original_name.clone(),
            content_type: record.content_type.clone(),
            size: record.size,
            markdown: build_markdown(&record.original_name, &url),
            url,
            created_at: record.created_at,
        }
    }
}

/// Every stored object is an image, so the Markdown form is always `![name](url)`.
///
/// The filename is escaped so brackets or parentheses in a name cannot break out
/// of the Markdown construct.
pub fn build_markdown(name: &str, url: &str) -> String {
    let label = escape_markdown_text(name);
    format!("![{label}]({url})")
}

/// Storage key and public path for one image.
pub fn r2_key_for(id: &str, ext: &str) -> String {
    format!("i/{id}.{ext}")
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
/// `declared_sha256` comes from the `X-File-SHA256` header. The bytes are hashed
/// again here, and R2 checks the same digest on `PutObject`.
pub async fn handle_upload(
    req: &mut worker::Request,
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
    if size > crate::config::MAX_UPLOAD_SIZE {
        return Err(ApiError::PayloadTooLarge);
    }

    let bytes = file
        .bytes()
        .await
        .map_err(|e| ApiError::Internal(format!("reading upload failed: {e}")))?;

    if bytes.len() != size {
        return Err(ApiError::BadRequest("size_mismatch"));
    }

    // Extension and file header both have to be a supported image.
    let content_type = image_content_type(&original_name, &bytes)
        .ok_or(ApiError::UnsupportedMediaType("unsupported_file_type"))?;

    let actual = sha256_hex(&bytes);
    if actual != declared {
        return Err(ApiError::BadRequest("checksum_mismatch"));
    }

    // Fast path: someone already stored these exact bytes.
    if let Some(existing) = db.find_file_by_sha256(&declared).await? {
        return Ok(UploadOutcome {
            file: FileInfo::from_record(&existing, cfg),
            deduplicated: true,
        });
    }

    let ext = extension_for_type(content_type)
        .ok_or(ApiError::UnsupportedMediaType("unsupported_file_type"))?;
    let key = r2_key_for(&public_image_id(), ext);
    let r2 = R2::new(&cfg.r2);
    let bucket = r2.bucket.clone();
    let etag = r2
        .put(
            &bucket,
            &key,
            &bytes,
            PutOptions {
                content_type: content_type.to_string(),
                cache_control: Some("public, max-age=31536000, immutable".to_string()),
                metadata: vec![
                    ("original-name".to_string(), original_name.clone()),
                    ("sha256".to_string(), declared.clone()),
                ],
            },
        )
        .await?;

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

        // Lost a race against a concurrent upload of the same bytes. That upload
        // owns the public name, so drop the object we just wrote.
        Err(_) => {
            let _ = r2.delete(&bucket, &record.r2_key).await;
            match db.find_file_by_sha256(&declared).await? {
            Some(existing) => Ok(UploadOutcome {
                file: FileInfo::from_record(&existing, cfg),
                deduplicated: true,
            }),
            // The insert failed for some reason *other* than a duplicate, and
            // there is nothing to fall back to.
            None => Err(ApiError::Internal(
                "insert failed and no duplicate row found".into(),
            )),
            }
        }
    }
}

/// Strip any path component from an uploaded filename.
///
/// A browser normally sends only the basename, but a hand-rolled client could
/// send `../../etc/passwd`. The R2 key never uses the filename anyway; this only
/// protects the stored `original_name` and the rendered UI.
pub fn sanitize_filename(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
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

/// Delete an object from the image bucket.
pub async fn delete_object(r2: &R2, r2_key: &str) -> ApiResult<()> {
    let bucket = r2.bucket.clone();
    r2.delete(&bucket, r2_key).await
}
