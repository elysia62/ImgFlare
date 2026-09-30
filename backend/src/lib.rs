//! Personal image host: session login, API-key uploads, R2 images and D1 metadata.

mod auth;
mod backup;
mod cleanup;
mod config;
mod db;
mod error;
mod files;
mod payload;
mod public;
mod r2;
mod response;
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
    let started = utils::now_ms();
    let method = req.method().to_string();
    let path = req.path();
    let request_id = req
        .headers()
        .get("CF-Ray")
        .ok()
        .flatten()
        .unwrap_or_else(|| utils::random_token(12));
    let response = match router::route(req, env, ctx).await {
        Ok(response) => response,
        Err(err) => err.to_response(),
    };
    worker::console_log!(
        "{}",
        serde_json::json!({"event":"request", "method":method, "path":path, "status":response.status_code(), "duration_ms":utils::now_ms()-started, "request_id":request_id})
    );
    Ok(response)
}

/// Daily backup and 15-minute cleanup entry point.
///
/// Failed storage operations remain in the durable cleanup queue.
#[event(scheduled)]
pub async fn scheduled(event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let result: error::ApiResult<()> = async {
        let cfg = config::Config::from_env(&env)?;
        let db = db::Db::from_env(&env)?;
        if event.cron() == "0 4 * * *" {
            let report = backup::run_backup_with_retries(&env, &cfg).await?;
            worker::console_log!("{}", serde_json::json!({"event":"backup_completed", "bytes":report.bytes, "sha256":report.sha256}));
        }
        cleanup::run(&db, &r2::R2::new(&cfg.r2)).await
    }.await;
    if let Err(err) = result {
        worker::console_error!("scheduled maintenance failed: {err}");
    }
}
