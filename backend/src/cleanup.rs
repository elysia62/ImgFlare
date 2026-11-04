//! Durable R2 cleanup. A D1 failure never loses the object key to retry.
use crate::{db::Db, error::ApiResult, r2::R2};

pub async fn key(db: &Db, r2: &R2, key: &str) -> ApiResult<()> {
    if key.starts_with("back/") {
        let Some(owner) = db.acquire_backup_lock().await? else {
            // An active backup may reuse a dated key. Leave this job queued.
            return Ok(());
        };
        let result: ApiResult<()> = async {
            if db.cleanup_is_due(key).await? {
                db.renew_backup_lock(&owner).await?;
                delete_unreferenced(db, r2, key).await?;
            }
            Ok(())
        }
        .await;
        let released = db.release_backup_lock(&owner).await;
        result?;
        return released;
    }
    delete_unreferenced(db, r2, key).await
}

async fn delete_unreferenced(db: &Db, r2: &R2, key: &str) -> ApiResult<()> {
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
