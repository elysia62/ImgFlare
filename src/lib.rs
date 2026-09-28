//! Personal image host: session login, API-key uploads, R2 images and D1 metadata.

mod auth;
mod backup;
mod config;
mod db;
mod error;
mod files;
mod public;
mod response;
mod r2;
mod router;
mod s3sign;
mod tokens;
mod turnstile;
mod upload;
mod utils;

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
/// Writes the database backup to the image bucket.
#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let result = match config::Config::from_env(&env) {
        Ok(cfg) => backup::run_backup_with_retries(&env, &cfg).await,
        Err(err) => Err(err),
    };
    if let Err(err) = result {
        worker::console_error!("scheduled backup failed: {err}");
    }
}
