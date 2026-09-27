//! Daily D1 backup: D1 → SQL dump → private R2 → `d1/latest.sql`.
//!
//! Design rules, in order of importance:
//!
//! 1. **Never destroy a good backup.** The existing `d1/latest.sql` is only
//!    replaced once a brand new dump has been produced, verified and uploaded
//!    successfully. Any failure leaves the old object untouched.
//! 2. **Only one backup file ever exists.** No dated files, no history, no
//!    listing — just `d1/latest.sql`.
//! 3. **No account-wide credentials.** The dump comes from the D1 *binding*
//!    (`D1Database::dump`), so there is no REST call and no Cloudflare API
//!    token to manage or leak.

use crate::config::Config;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::utils::{now_ms, random_token, sha256_hex};
use std::collections::HashMap;
use worker::{Env, HttpMetadata};

/// Where the single backup object lives.
pub const LATEST_KEY: &str = "d1/latest.sql";

/// How many times the whole job is attempted by the cron handler.
pub const MAX_ATTEMPTS: u32 = 3;

/// Summary of a completed backup, logged and surfaced to the admin.
#[derive(Debug)]
pub struct BackupReport {
    pub bytes: u64,
    pub sha256: String,
    pub finished_at: i64,
}

/// Run one complete backup attempt.
///
/// Returns `Ok(report)` only when a verified SQL dump is sitting in the private
/// bucket under `d1/latest.sql`.
pub async fn run_backup(env: &Env, _cfg: &Config) -> ApiResult<BackupReport> {
    // --- 1. Produce the dump ----------------------------------------------
    let db = Db::from_env(env)?;
    let sql = db
        .dump()
        .await
        .map_err(|e| ApiError::Internal(format!("D1 dump failed: {e}")))?;

    if sql.is_empty() {
        return Err(ApiError::Internal("D1 dump produced an empty file".into()));
    }

    let sha256 = sha256_hex(&sql);
    let size = sql.len() as u64;
    // R2's checksum argument wants the raw 32 digest bytes.
    let checksum = crate::utils::from_hex(&sha256).unwrap_or_default();

    // --- 2. Upload to the private backup bucket ---------------------------
    let bucket = env
        .bucket("BACKUP_BUCKET")
        .map_err(|e| ApiError::Internal(format!("R2 binding `BACKUP_BUCKET` unavailable: {e}")))?;

    let mut custom = HashMap::new();
    custom.insert("backup_type".to_string(), "d1".to_string());
    custom.insert("format".to_string(), "sql".to_string());
    custom.insert("backup_sha256".to_string(), sha256.clone());
    custom.insert("backup_at".to_string(), now_ms().to_string());

    let metadata = HttpMetadata {
        content_type: Some("application/sql".to_string()),
        ..Default::default()
    };

    let tmp_key = format!("d1/.tmp/latest-{}.sql", random_token(16));

    // Stage the object first, then promote it. A failure part-way through
    // therefore never leaves `latest.sql` half-written or truncated.
    bucket
        .put(tmp_key.clone(), sql.clone())
        .http_metadata(metadata.clone())
        .custom_metadata(custom.clone())
        .sha256(checksum.clone())
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 backup staging failed: {e}")))?;

    // Promote: overwriting `latest.sql` here is the only destructive step, and
    // it only runs once the new bytes are safely stored.
    bucket
        .put(LATEST_KEY, sql)
        .http_metadata(metadata)
        .custom_metadata(custom)
        .sha256(checksum)
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 backup promote failed: {e}")))?;

    // Clean up the temporary object; `latest.sql` is the only thing that stays.
    // A leftover staging object is harmless and gets overwritten next run.
    let _ = bucket.delete(tmp_key).await;

    // Rate-limit counters are only meaningful for a 15-minute window; sweeping
    // them once a day keeps `kv_meta` from accumulating dead keys. Best effort:
    // a failure here must not fail the backup.
    let _ = db.meta_delete_prefix("login_fail:").await;

    let finished_at = now_ms();

    Ok(BackupReport {
        bytes: size,
        sha256,
        finished_at,
    })
}

/// Run the backup with up to [`MAX_ATTEMPTS`] attempts.
///
/// A failed attempt is retried after a short pause. If every attempt fails, the
/// previous `d1/latest.sql` is still intact — nothing is ever deleted on failure.
pub async fn run_backup_with_retries(env: &Env, cfg: &Config) -> ApiResult<BackupReport> {
    let mut last_err: Option<ApiError> = None;

    for attempt in 1..=MAX_ATTEMPTS {
        match run_backup(env, cfg).await {
            Ok(report) => return Ok(report),
            Err(err) => {
                last_err = Some(err);
                if attempt < MAX_ATTEMPTS {
                    // Back off between attempts.
                    Delay::new(2_000 * attempt as u64).await;
                }
            }
        }
    }

    Err(last_err.unwrap_or_else(|| ApiError::Internal("backup failed".into())))
}

/// Metadata describing the current backup, for the admin settings card.
#[derive(Debug, Clone)]
pub struct BackupStatus {
    pub exists: bool,
    pub size: u64,
    pub sha256: Option<String>,
    pub uploaded_at: Option<i64>,
}

/// Read the status of `d1/latest.sql` without downloading its body.
pub async fn read_status(env: &Env) -> ApiResult<BackupStatus> {
    let bucket = env.bucket("BACKUP_BUCKET").map_err(|e| {
        ApiError::Internal(format!("R2 binding `BACKUP_BUCKET` unavailable: {e}"))
    })?;

    let object = bucket
        .head(LATEST_KEY.to_string())
        .await
        .map_err(|e| ApiError::Internal(format!("R2 head failed: {e}")))?;

    match object {
        Some(obj) => {
            let custom = obj.custom_metadata().unwrap_or_default();
            Ok(BackupStatus {
                exists: true,
                size: obj.size(),
                sha256: custom.get("backup_sha256").cloned(),
                uploaded_at: custom.get("backup_at").and_then(|v| v.parse::<i64>().ok()),
            })
        }
        None => Ok(BackupStatus {
            exists: false,
            size: 0,
            sha256: None,
            uploaded_at: None,
        }),
    }
}

/// Download `d1/latest.sql` for the admin.
pub async fn download_latest(env: &Env) -> ApiResult<Vec<u8>> {
    let bucket = env.bucket("BACKUP_BUCKET").map_err(|e| {
        ApiError::Internal(format!("R2 binding `BACKUP_BUCKET` unavailable: {e}"))
    })?;

    let object = bucket
        .get(LATEST_KEY.to_string())
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 get failed: {e}")))?
        .ok_or(ApiError::NotFound("no_backup_available"))?;

    let body = object
        .body()
        .ok_or(ApiError::NotFound("no_backup_available"))?;

    body.bytes()
        .await
        .map_err(|e| ApiError::Internal(format!("reading backup failed: {e}")))
}

/// Sleep helper.
///
/// `worker::Delay` is the runtime's timer; using it avoids pulling in a tokio
/// dependency just for `sleep`.
struct Delay;

impl Delay {
    #[allow(clippy::new_ret_no_self)]
    async fn new(ms: u64) {
        use worker::Delay as WorkerDelay;
        WorkerDelay::from(std::time::Duration::from_millis(ms)).await;
    }
}
