//! File listing, lookup and deletion.

use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::r2::R2;
use crate::upload::FileInfo;
use serde::{Deserialize, Serialize};

/// Query string accepted by `GET /api/files`.
#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

const DEFAULT_LIMIT: u32 = 30;
const MAX_LIMIT: u32 = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResponse {
    pub files: Vec<FileInfo>,
    pub total: i64,
    pub limit: u32,
    pub offset: u32,
}

/// Paginated listing, newest first.
///
/// Uses offset/limit pagination.
pub async fn handle_list(db: &Db, origin: &str, query: ListQuery) -> ApiResult<ListResponse> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0);

    let search = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let (rows, total) = db.list_files(search, limit, offset).await?;

    Ok(ListResponse {
        files: rows
            .iter()
            .map(|r| FileInfo::from_record(r, origin))
            .collect(),
        total,
        limit,
        offset,
    })
}

/// `GET /api/files/:id`
pub async fn handle_get(db: &Db, origin: &str, id: &str) -> ApiResult<FileInfo> {
    let record = db
        .find_file_by_id(id)
        .await?
        .ok_or(ApiError::NotFound("file_not_found"))?;
    Ok(FileInfo::from_record(&record, origin))
}

/// `DELETE /api/files/:id`
///
/// Admin session only — an API token cannot delete. The R2 object and the D1 row
/// are both removed.
pub async fn handle_delete(r2: &R2, db: &Db, id: &str) -> ApiResult<()> {
    let record = db
        .find_file_by_id(id)
        .await?
        .ok_or(ApiError::NotFound("file_not_found"))?;

    // Object first: if this fails we keep the index row so the admin can retry,
    // rather than orphaning bytes in the bucket with no record of them.
    r2.delete(&record.r2_key).await?;

    let removed = db.delete_file(id).await?;
    if removed == 0 {
        return Err(ApiError::NotFound("file_not_found"));
    }

    Ok(())
}
