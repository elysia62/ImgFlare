//! Durable R2 cleanup. A D1 failure never loses the object key to retry.
use crate::{db::Db, error::ApiResult, r2::R2};

pub async fn key(db: &Db, r2: &R2, key: &str) -> ApiResult<()> {
    // Protect an upload whose transaction committed but whose reply was lost.
    if !db.object_referenced(key).await? {
        r2.delete(key).await?;
    }
    db.finish_cleanup(key).await
}

pub async fn run(db: &Db, r2: &R2) -> ApiResult<()> {
    // Bound maintenance work and leave unsuccessful jobs queued.
    for job in db.due_cleanup().await? {
        if let Err(error) = key(db, r2, &job.r2_key).await {
            worker::console_error!(
                "{}",
                serde_json::json!({"event":"cleanup_failed", "key":job.r2_key, "error":error.to_string()})
            );
        }
    }
    Ok(())
}
