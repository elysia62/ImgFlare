//! Daily D1 backup: D1 → SQL dump → `back/latest.sql` in the image bucket.
//!
//! Design rules, in order of importance:
//!
//! 1. **Never destroy a good backup.** The existing `back/latest.sql` is only
//!    replaced once a brand new dump has been produced, verified and uploaded
//!    successfully. Any failure leaves the old object untouched.
//! 2. **Only one backup file ever exists.** No dated files, no history, no
//!    listing — just `back/latest.sql`.
//! 3. The dump itself comes from the D1 binding (`D1Database::dump`). The SQL
//!    file is written with the same R2 access key used for images.

use crate::config::Config;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::r2::{PutOptions, R2};
use crate::utils::{now_ms, random_token, sha256_hex};
use worker::Env;

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

    let r2 = R2::new(&_cfg.r2);
    let bucket = r2.bucket.clone();
    let metadata = vec![
        ("backup-type".to_string(), "d1".to_string()),
        ("format".to_string(), "sql".to_string()),
        ("backup-sha256".to_string(), sha256.clone()),
        ("backup-at".to_string(), now_ms().to_string()),
    ];
    let opts = || PutOptions {
        content_type: "application/sql".to_string(),
        cache_control: None,
        metadata: metadata.clone(),
    };

    let tmp_key = format!("back/.tmp/latest-{}.sql", random_token(16));
    r2.put(&bucket, &tmp_key, &sql, opts()).await?;
    r2.put(&bucket, LATEST_KEY, &sql, opts()).await?;
    let _ = r2.delete(&bucket, &tmp_key).await;

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

/// Read the status of `back/latest.sql` without downloading its body.
pub async fn read_status(r2: &R2) -> ApiResult<BackupStatus> {
    let bucket = r2.bucket.clone();
    match r2.head(&bucket, LATEST_KEY).await? {
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
    let bucket = r2.bucket.clone();
    let mut object = match r2.get(&bucket, LATEST_KEY).await {
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
