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
    #[serde(default)]
    pub cursor: Option<String>,
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
    pub next_cursor: Option<String>,
}

/// Paginated listing, newest first.
///
/// Uses a stable (created_at, id) cursor, with legacy offset support.
pub async fn handle_list(db: &Db, origin: &str, query: ListQuery) -> ApiResult<ListResponse> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0);

    let search = query.q.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let cursor = query.cursor.as_deref().map(decode_cursor).transpose()?;
    if cursor.is_some() && offset != 0 {
        return Err(ApiError::BadRequest("invalid_cursor"));
    }
    let (mut rows, total) = db
        .list_files(
            search,
            limit,
            offset,
            cursor.as_ref().map(|(t, id)| (*t, id.as_str())),
        )
        .await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        rows.last().map(|r| format!("{}:{}", r.created_at, r.id))
    } else {
        None
    };

    Ok(ListResponse {
        files: rows
            .iter()
            .map(|r| FileInfo::from_record(r, origin))
            .collect(),
        total,
        limit,
        offset,
        next_cursor,
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

    db.delete_file(id).await?;
    for key in std::iter::once(&record.r2_key).chain(record.thumbnail_r2_key.iter()) {
        if let Err(error) = crate::cleanup::key(db, r2, key).await {
            worker::console_error!("delete cleanup deferred: {error}");
        }
    }

    Ok(())
}

fn decode_cursor(value: &str) -> ApiResult<(i64, String)> {
    let (time, id) = value
        .split_once(':')
        .ok_or(ApiError::BadRequest("invalid_cursor"))?;
    let time = time
        .parse::<i64>()
        .map_err(|_| ApiError::BadRequest("invalid_cursor"))?;
    if time < 0
        || id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::BadRequest("invalid_cursor"));
    }
    Ok((time, id.into()))
}
