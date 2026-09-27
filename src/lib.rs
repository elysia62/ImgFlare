//! Personal Image Host — a minimal, single-administrator image and file host.
//!
//! ```text
//! imgflare.example.com  -> this Rust/Wasm Worker
//!   ├── GET  /i/<sha256>   public files, no auth
//!   ├── POST /api/login    username + password + Turnstile
//!   ├── upload, dedup, list, search, delete
//!   ├── API tokens for the userscript
//!   └── daily D1 -> SQL -> private R2 backup
//! ```
//!
//! One origin. Public reads need no credentials; everything else does.
//!
//! Storage layout:
//!
//! ```text
//! R2 (public)   BUCKET         f/<sha256>
//! R2 (private)  BACKUP_BUCKET  d1/latest.sql
//! D1            DB             files, api_tokens, kv_meta
//! ```

mod auth;
mod backup;
mod config;
mod db;
mod error;
mod files;
mod public;
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
/// The error is converted here rather than by the macro: `ApiError` knows its
/// own status code and JSON body, and letting it escape would collapse every
/// failure into a 500 with a plain-text payload.
#[event(fetch)]
pub async fn main(req: Request, env: Env, ctx: Context) -> Result<Response, worker::Error> {
    Ok(match router::route(req, env, ctx).await {
        Ok(response) => response,
        Err(err) => err.to_response(),
    })
}

/// Cron entry point: `0 4 * * *` (04:00 UTC / 12:00 Asia/Taipei).
///
/// This handler does exactly one thing — back D1 up to the private R2 bucket.
/// Public file access never touches this path.
#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    // The cron handler reports through the return value only — see the note on
    // logging in `error.rs`.
    if let Ok(cfg) = config::Config::from_env(&env) {
        // Already retried inside; on failure the previous `d1/latest.sql` is
        // left untouched, which is the outcome that matters.
        let _ = backup::run_backup_with_retries(&env, &cfg).await;
    }
}
