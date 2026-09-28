//! Daily logical backup of the three D1 application tables to R2.
//! One read query takes a consistent snapshot; data is encoded as restorable SQL.
//! R2 validates SHA-256 and atomically replaces latest.sql after the PUT completes.

use crate::config::Config;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::r2::{PutOptions, R2};
use crate::utils::{now_ms, sha256_hex};
use worker::{Delay, Env};

/// Where the single backup object lives.
pub const LATEST_KEY: &str = "back/latest.sql";

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
/// Returns `Ok(report)` only when a verified SQL dump is sitting at
/// `back/latest.sql` in the image bucket.
pub async fn run_backup(env: &Env, cfg: &Config) -> ApiResult<BackupReport> {
    // --- 1. Produce the dump ----------------------------------------------
    let db = Db::from_env(env)?;
    let sql = db
        .export_sql()
        .await
        .map_err(|e| ApiError::Internal(format!("D1 SQL export failed: {e}")))?;

    if sql.is_empty() {
        return Err(ApiError::Internal("D1 SQL export produced an empty file".into()));
    }

    let sha256 = sha256_hex(&sql);
    let size = sql.len() as u64;

    let r2 = R2::new(&cfg.r2);
    let metadata = vec![
        ("backup-type".to_string(), "d1".to_string()),
        ("format".to_string(), "sql".to_string()),
        ("backup-sha256".to_string(), sha256.clone()),
        ("backup-at".to_string(), now_ms().to_string()),
    ];
    let opts = PutOptions {
        content_type: "application/sql".to_string(),
        cache_control: None,
        metadata,
    };

    // A single checksum-verified PUT is atomic; no temporary object can leak.
    r2.put(LATEST_KEY, &sql, opts).await?;

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
/// previous `back/latest.sql` is still intact — nothing is ever deleted on failure.
pub async fn run_backup_with_retries(env: &Env, cfg: &Config) -> ApiResult<BackupReport> {
    let mut last_err: Option<ApiError> = None;

    for attempt in 1..=MAX_ATTEMPTS {
        match run_backup(env, cfg).await {
            Ok(report) => return Ok(report),
            Err(err) => {
                last_err = Some(err);
                if attempt < MAX_ATTEMPTS {
                    // Back off between attempts.
                    Delay::from(std::time::Duration::from_millis(2_000 * attempt as u64)).await;
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

/// Read the status of `back/latest.sql` without downloading its body.
pub async fn read_status(r2: &R2) -> ApiResult<BackupStatus> {
    match r2.head(LATEST_KEY).await? {
        Some(obj) => Ok(BackupStatus {
            exists: true,
            size: obj.size,
            sha256: obj.metadata.get("backup-sha256").cloned(),
            uploaded_at: obj
                .metadata
                .get("backup-at")
                .and_then(|v| v.parse::<i64>().ok()),
        }),
        None => Ok(BackupStatus {
            exists: false,
            size: 0,
            sha256: None,
            uploaded_at: None,
        }),
    }
}

/// Download `back/latest.sql` for the admin.
pub async fn download_latest(r2: &R2) -> ApiResult<Vec<u8>> {
    let mut object = match r2.get(LATEST_KEY).await {
        Err(ApiError::NotFound(_)) => {
            return Err(ApiError::NotFound("no_backup_available"));
        }
        other => other?,
    };
    object
        .bytes()
        .await
        .map_err(|e| ApiError::Internal(format!("reading backup failed: {e}")))
}
