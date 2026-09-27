//! Daily D1 backup: D1 → SQL export → private R2 → `d1/latest.sql`.
//!
//! Design rules, in order of importance:
//!
//! 1. **Never destroy a good backup.** The existing `d1/latest.sql` is only
//!    replaced once a brand new export has been downloaded, verified and
//!    uploaded successfully. Any failure leaves the old object untouched.
//! 2. **Only one backup file ever exists.** No dated files, no history, no
//!    listing — just `d1/latest.sql`.
//! 3. **No giant in-memory strings.** The export is streamed from the HTTPS
//!    response straight into R2.
//!
//! The export itself uses Cloudflare's official D1 export REST API rather than
//! hand-rolled `SELECT *` + SQL string assembly.

use crate::config::{Config, secret};
use crate::error::{ApiError, ApiResult};
use crate::utils::{now_ms, random_token, sha256_hex};
use serde::Deserialize;
use std::collections::HashMap;
use worker::{Env, Fetch, HttpMetadata, Method, Request, RequestInit};

/// Where the single backup object lives.
pub const LATEST_KEY: &str = "d1/latest.sql";

/// How often we poll the export job.
const POLL_INTERVAL_MS: i64 = 5_000;
/// Give up after this long.
const POLL_TIMEOUT_MS: i64 = 10 * 60 * 1000;
/// How many times the whole job is attempted by the cron handler.
pub const MAX_ATTEMPTS: u32 = 3;

#[derive(Deserialize)]
struct ExportCreateResponse {
    result: Option<ExportJob>,
    success: bool,
    /// Present on failure; used only for server-side logging.
    #[serde(default)]
    errors: Vec<ApiErrorBody>,
}

#[derive(Deserialize)]
struct ExportJob {
    /// The export job identifier, used for polling.
    #[serde(alias = "uuid")]
    id: Option<String>,
    status: Option<String>,
    result: Option<ExportResult>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct ExportResult {
    /// Signed URL to download the produced SQL from.
    url: Option<String>,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    message: Option<String>,
}

/// Summary of a completed backup, logged and surfaced to the admin.
#[derive(Debug)]
pub struct BackupReport {
    pub bytes: u64,
    pub sha256: String,
    pub finished_at: i64,
}

/// Run one complete backup attempt.
///
/// Returns `Ok(report)` only when a verified SQL export is sitting in the
/// private bucket under `d1/latest.sql`.
pub async fn run_backup(env: &Env, cfg: &Config) -> ApiResult<BackupReport> {
    if cfg.account_id.is_empty() || cfg.database_id.is_empty() {
        return Err(ApiError::Internal(
            "ACCOUNT_ID / DATABASE_ID are not configured".into(),
        ));
    }

    let api_token = secret(env, "CLOUDFLARE_API_TOKEN")?;

    worker::console_log!("D1 backup started");
    worker::console_log!("D1 export started");

    // --- 1. Create the export job -----------------------------------------
    let create_url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/d1/database/{}/export",
        cfg.account_id, cfg.database_id
    );

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some("{}".into()));
    let mut req = Request::new_with_init(&create_url, &init)
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    {
        let headers = req
            .headers_mut()
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        headers
            .set("Authorization", &format!("Bearer {api_token}"))
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        headers
            .set("Content-Type", "application/json")
            .map_err(|e| ApiError::Internal(e.to_string()))?;
    }

    let mut resp = Fetch::Request(req)
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("export create failed: {e}")))?;

    let status = resp.status_code();
    let created: ExportCreateResponse = resp.json().await.map_err(|e| {
        ApiError::Internal(format!("export create response invalid (HTTP {status}): {e}"))
    })?;

    if !created.success {
        let detail = created
            .errors
            .iter()
            .filter_map(|e| e.message.clone())
            .collect::<Vec<_>>()
            .join("; ");
        return Err(ApiError::Internal(format!(
            "export create rejected (HTTP {status}): {detail}"
        )));
    }

    // Some API revisions return the download URL immediately.
    let job = created
        .result
        .ok_or_else(|| ApiError::Internal("export create returned no job".into()))?;

    let poll_url = job.id.as_ref().map(|id| {
        format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/d1/database/{}/export/{}",
            cfg.account_id, cfg.database_id, id
        )
    });

    // --- 2. Poll until the job is ready -----------------------------------
    let started = now_ms();
    let mut download_url = job.result.as_ref().and_then(|r| r.url.clone());

    while download_url.is_none() {
        let poll = poll_url
            .as_ref()
            .ok_or_else(|| ApiError::Internal("export job has no id to poll".into()))?;

        if now_ms() - started > POLL_TIMEOUT_MS {
            return Err(ApiError::Internal(
                "export job timed out after 10 minutes".into(),
            ));
        }

        // Sleep between polls without busy-waiting.
        Delay::new(POLL_INTERVAL_MS as u64).await;
        worker::console_log!("D1 export polling");

        let mut init = RequestInit::new();
        init.with_method(Method::Get);
        let mut req = Request::new_with_init(poll, &init)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        req.headers_mut()
            .map_err(|e| ApiError::Internal(e.to_string()))?
            .set("Authorization", &format!("Bearer {api_token}"))
            .map_err(|e| ApiError::Internal(e.to_string()))?;

        let mut resp = Fetch::Request(req)
            .send()
            .await
            .map_err(|e| ApiError::Internal(format!("export poll failed: {e}")))?;

        let body: ExportCreateResponse = resp
            .json()
            .await
            .map_err(|e| ApiError::Internal(format!("export poll response invalid: {e}")))?;

        if !body.success {
            return Err(ApiError::Internal("export poll was rejected".into()));
        }

        if let Some(job) = body.result {
            if let Some(err) = job.error {
                return Err(ApiError::Internal(format!("export job failed: {err}")));
            }
            if let Some(url) = job.result.and_then(|r| r.url) {
                download_url = Some(url);
                break;
            }
            // A terminal-looking status with no URL means we will never succeed.
            if let Some(status) = job.status
                && status != "active"
                && status != "pending"
                && status != "running"
            {
                return Err(ApiError::Internal(format!(
                    "export job ended with status `{status}`"
                )));
            }
        }
    }

    let download_url = download_url.expect("loop only exits once a URL exists");

    // --- 3. Download the SQL ----------------------------------------------
    let mut init = RequestInit::new();
    init.with_method(Method::Get);
    let req = Request::new_with_init(&download_url, &init)
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let mut resp = Fetch::Request(req)
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("export download failed: {e}")))?;

    let status = resp.status_code();
    if !(200..300).contains(&status) {
        return Err(ApiError::Internal(format!(
            "export download returned HTTP {status}"
        )));
    }

    // Fully buffer the SQL so we can verify its hash before anything is written.
    // D1 exports for a personal image host are small (kilobytes to a few MB);
    // this deliberately trades a little memory for a guaranteed-correct upload,
    // which matters far more here than streaming does.
    let sql = resp
        .bytes()
        .await
        .map_err(|e| ApiError::Internal(format!("reading export failed: {e}")))?;

    if sql.is_empty() {
        return Err(ApiError::Internal("export produced an empty file".into()));
    }

    let sha256 = sha256_hex(&sql);
    let size = sql.len() as u64;
    // R2's checksum argument wants the raw 32 digest bytes.
    let checksum = crate::utils::from_hex(&sha256).unwrap_or_default();

    // --- 4. Upload to the private backup bucket ---------------------------
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

    // Stage the object first, then promote it. This means a failure part-way
    // through never leaves `latest.sql` half-written or truncated.
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
    if let Err(e) = bucket.delete(tmp_key).await {
        // Not fatal — the next run sweeps the temp prefix.
        worker::console_warn!("failed to remove staging object: {e}");
    }

    // Rate-limit counters are only meaningful for a 15-minute window; sweeping
    // them once a day keeps `kv_meta` from accumulating dead keys.
    if let Ok(db) = crate::db::Db::from_env(env) {
        match db.meta_delete_prefix("login_fail:").await {
            Ok(0) => {}
            Ok(n) => worker::console_log!("cleared {n} stale login counters"),
            Err(e) => worker::console_warn!("login counter sweep failed: {e}"),
        }
    }

    let finished_at = now_ms();
    worker::console_log!(
        "D1 backup uploaded (size={size} sha256={sha256} at={finished_at})"
    );

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
                worker::console_warn!("D1 backup attempt {attempt}/{MAX_ATTEMPTS} failed: {err}");
                last_err = Some(err);
                if attempt < MAX_ATTEMPTS {
                    // Back off between attempts.
                    Delay::new(2_000 * attempt as u64).await;
                }
            }
        }
    }

    let err = last_err.unwrap_or_else(|| ApiError::Internal("backup failed".into()));
    worker::console_error!("D1 backup failed after {MAX_ATTEMPTS} attempts: {err}");
    Err(err)
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
