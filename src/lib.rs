//! Personal Image Host — a minimal, single-administrator image and file host.
//!
//! ```text
//! panel.example.com  -> this Rust/Wasm Worker
//!   ├── login (password + Turnstile)
//!   ├── upload, dedup, list, search, delete
//!   ├── API tokens for the userscript
//!   └── daily D1 -> SQL -> private R2 backup
//!
//! img.example.com    -> the public R2 bucket, bound as a Custom Domain
//!   └── GET /f/<sha256>   (no auth, no cookies, no Worker in the path)
//! ```
//!
//! Storage layout:
//!
//! ```text
//! R2 (public)   personal-image-host         f/<sha256>
//! R2 (private)  personal-image-host-backup  d1/latest.sql
//! D1            files, api_tokens, kv_meta
//! ```

mod auth;
mod backup;
mod config;
mod db;
mod error;
mod files;
mod response;
mod router;
mod tokens;
mod turnstile;
mod upload;
mod utils;

// `event`, `console_log` and friends are exported by worker-macros / worker-sys
// at the crate root. In edition 2024 a derive-like attribute macro has to be
// brought into scope explicitly, so pull the macro in rather than relying on
// textual scope resolution.
use worker::event;
use worker::{Context, Env, Request, Response, ScheduleContext, ScheduledEvent};

/// HTTP entry point.
///
/// `respond_with_errors` turns a panic or an unhandled error into a 500 rather
/// than an opaque runtime crash.
#[event(fetch, respond_with_errors)]
pub async fn main(req: Request, env: Env, ctx: Context) -> error::ApiResult<Response> {
    router::route(req, env, ctx).await
}

/// Cron entry point: `0 4 * * *` (04:00 UTC / 12:00 Asia/Taipei).
///
/// This handler does exactly one thing — back D1 up to the private R2 bucket.
/// Public file access never touches this path.
#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let cfg = match config::Config::from_env(&env) {
        Ok(cfg) => cfg,
        Err(err) => {
            worker::console_error!("backup aborted: config error: {err}");
            return;
        }
    };

    match backup::run_backup_with_retries(&env, &cfg).await {
        Ok(report) => {
            worker::console_log!(
                "scheduled backup complete: {} bytes, sha256 {}, at {}",
                report.bytes,
                report.sha256,
                report.finished_at
            );
        }
        // Already retried inside; the previous `d1/latest.sql` remains in place.
        Err(err) => worker::console_error!("scheduled backup failed: {err}"),
    }
}
