//! D1 access layer.
//!
//! Every query in this crate goes through here, and every user-supplied value is
//! passed as a *bound parameter* — there is no string interpolation of user
//! input into SQL anywhere in the project.

use crate::error::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use worker::d1::{D1Database, D1PreparedStatement};
use worker::wasm_bindgen::JsValue;
use worker::Env;

/// A row from the `files` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRecord {
    pub id: String,
    pub sha256: String,
    pub r2_key: String,
    pub original_name: String,
    pub content_type: String,
    pub size: i64,
    pub etag: Option<String>,
    pub created_at: i64,
}

/// A row from the `api_tokens` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenRecord {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

/// Thin wrapper over the D1 binding.
pub struct Db {
    inner: D1Database,
}

impl Db {
    pub fn from_env(env: &Env) -> ApiResult<Self> {
        let inner = env
            .d1("DB")
            .map_err(|e| ApiError::Internal(format!("D1 binding `DB` unavailable: {e}")))?;
        Ok(Self { inner })
    }

    /// Build a statement. The SQL string here is always a constant.
    fn prepare(&self, sql: &str) -> D1PreparedStatement {
        self.inner.prepare(sql)
    }

    // -----------------------------------------------------------------------
    // files
    // -----------------------------------------------------------------------

    /// Look up a file by its SHA-256 (the deduplication key).
    pub async fn find_file_by_sha256(&self, sha256: &str) -> ApiResult<Option<FileRecord>> {
        let stmt = self
            .prepare(
                "SELECT id, sha256, r2_key, original_name, content_type, size, etag, created_at \
                 FROM files WHERE sha256 = ?",
            )
            .bind(&[JsValue::from_str(sha256)])
            .map_err(ApiError::from)?;

        stmt.first::<FileRecord>(None).await.map_err(ApiError::from)
    }

    /// Look up a file by primary key.
    pub async fn find_file_by_id(&self, id: &str) -> ApiResult<Option<FileRecord>> {
        let stmt = self
            .prepare(
                "SELECT id, sha256, r2_key, original_name, content_type, size, etag, created_at \
                 FROM files WHERE id = ?",
            )
            .bind(&[JsValue::from_str(id)])
            .map_err(ApiError::from)?;

        stmt.first::<FileRecord>(None).await.map_err(ApiError::from)
    }

    /// Insert a new file row.
    ///
    /// Returns [`ApiError::Internal`] wrapping the UNIQUE violation when a
    /// concurrent request won the race — callers must handle that by re-reading
    /// the row rather than surfacing an error.
    pub async fn insert_file(&self, file: &FileRecord) -> ApiResult<()> {
        let stmt = self
            .prepare(
                "INSERT INTO files \
                 (id, sha256, r2_key, original_name, content_type, size, etag, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                JsValue::from_str(&file.id),
                JsValue::from_str(&file.sha256),
                JsValue::from_str(&file.r2_key),
                JsValue::from_str(&file.original_name),
                JsValue::from_str(&file.content_type),
                JsValue::from_f64(file.size as f64),
                match &file.etag {
                    Some(e) => JsValue::from_str(e),
                    None => JsValue::NULL,
                },
                JsValue::from_f64(file.created_at as f64),
            ])
            .map_err(ApiError::from)?;

        stmt.run().await.map_err(ApiError::from)?;
        Ok(())
    }

    /// Delete a file row by id. Returns the number of rows removed.
    pub async fn delete_file(&self, id: &str) -> ApiResult<u64> {
        let stmt = self
            .prepare("DELETE FROM files WHERE id = ?")
            .bind(&[JsValue::from_str(id)])
            .map_err(ApiError::from)?;

        let result = stmt.run().await.map_err(ApiError::from)?;
        Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) as u64)
    }

    /// Paginated file listing, newest first, with an optional name filter.
    ///
    /// `LIKE` is applied to a bound parameter, never interpolated.
    pub async fn list_files(
        &self,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> ApiResult<(Vec<FileRecord>, i64)> {
        let (rows_sql, count_sql, pattern) = match search {
            Some(s) if !s.is_empty() => (
                "SELECT id, sha256, r2_key, original_name, content_type, size, etag, created_at \
                 FROM files WHERE original_name LIKE ? ESCAPE '\\' \
                 ORDER BY created_at DESC LIMIT ? OFFSET ?",
                "SELECT COUNT(*) AS n FROM files WHERE original_name LIKE ? ESCAPE '\\'",
                Some(format!("%{}%", escape_like(s))),
            ),
            _ => (
                "SELECT id, sha256, r2_key, original_name, content_type, size, etag, created_at \
                 FROM files ORDER BY created_at DESC LIMIT ? OFFSET ?",
                "SELECT COUNT(*) AS n FROM files",
                None,
            ),
        };

        // Count first so the caller can render pagination.
        let total: i64 = match &pattern {
            Some(p) => {
                let stmt = self
                    .prepare(count_sql)
                    .bind(&[JsValue::from_str(p)])
                    .map_err(ApiError::from)?;
                stmt.first::<CountRow>(None)
                    .await
                    .map_err(ApiError::from)?
                    .map(|r| r.n)
                    .unwrap_or(0)
            }
            None => {
                let stmt = self.prepare(count_sql);
                stmt.first::<CountRow>(None)
                    .await
                    .map_err(ApiError::from)?
                    .map(|r| r.n)
                    .unwrap_or(0)
            }
        };

        let mut params: Vec<JsValue> = Vec::new();
        if let Some(p) = &pattern {
            params.push(JsValue::from_str(p));
        }
        params.push(JsValue::from_f64(limit as f64));
        params.push(JsValue::from_f64(offset as f64));

        let stmt = self.prepare(rows_sql).bind(&params).map_err(ApiError::from)?;
        let result = stmt.all().await.map_err(ApiError::from)?;
        let rows: Vec<FileRecord> = result.results().map_err(ApiError::from)?;

        Ok((rows, total))
    }

    /// Total bytes stored, and object count — shown on the settings panel.
    pub async fn storage_stats(&self) -> ApiResult<(i64, i64)> {
        let stmt = self.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM files");
        let row = stmt
            .first::<StatsRow>(None)
            .await
            .map_err(ApiError::from)?;
        Ok(row.map(|r| (r.n, r.total)).unwrap_or((0, 0)))
    }

    // -----------------------------------------------------------------------
    // api_tokens
    // -----------------------------------------------------------------------

    pub async fn find_token_by_hash(&self, token_hash: &str) -> ApiResult<Option<TokenRecord>> {
        let stmt = self
            .prepare(
                "SELECT id, name, token_hash, created_at, last_used_at, revoked_at \
                 FROM api_tokens WHERE token_hash = ?",
            )
            .bind(&[JsValue::from_str(token_hash)])
            .map_err(ApiError::from)?;

        stmt.first::<TokenRecord>(None).await.map_err(ApiError::from)
    }

    pub async fn list_tokens(&self) -> ApiResult<Vec<TokenRecord>> {
        let stmt = self.prepare(
            "SELECT id, name, token_hash, created_at, last_used_at, revoked_at \
             FROM api_tokens ORDER BY created_at DESC",
        );
        let result = stmt.all().await.map_err(ApiError::from)?;
        result.results().map_err(ApiError::from)
    }

    pub async fn insert_token(&self, token: &TokenRecord) -> ApiResult<()> {
        let stmt = self
            .prepare(
                "INSERT INTO api_tokens \
                 (id, name, token_hash, created_at, last_used_at, revoked_at) \
                 VALUES (?, ?, ?, ?, NULL, NULL)",
            )
            .bind(&[
                JsValue::from_str(&token.id),
                JsValue::from_str(&token.name),
                JsValue::from_str(&token.token_hash),
                JsValue::from_f64(token.created_at as f64),
            ])
            .map_err(ApiError::from)?;

        stmt.run().await.map_err(ApiError::from)?;
        Ok(())
    }

    /// Soft-revoke a token. Revocation is permanent — the row is kept so the
    /// admin can still see that the token existed.
    pub async fn revoke_token(&self, id: &str) -> ApiResult<u64> {
        let stmt = self
            .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
            .bind(&[
                JsValue::from_f64(crate::utils::now_ms() as f64),
                JsValue::from_str(id),
            ])
            .map_err(ApiError::from)?;

        let result = stmt.run().await.map_err(ApiError::from)?;
        Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) as u64)
    }

    pub async fn touch_token(&self, id: &str) -> ApiResult<()> {
        let stmt = self
            .prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
            .bind(&[
                JsValue::from_f64(crate::utils::now_ms() as f64),
                JsValue::from_str(id),
            ])
            .map_err(ApiError::from)?;
        stmt.run().await.map_err(ApiError::from)?;
        Ok(())
    }

    /// Hard-delete a token row. Used only by the admin UI's "remove" action.
    pub async fn delete_token(&self, id: &str) -> ApiResult<u64> {
        let stmt = self
            .prepare("DELETE FROM api_tokens WHERE id = ?")
            .bind(&[JsValue::from_str(id)])
            .map_err(ApiError::from)?;
        let result = stmt.run().await.map_err(ApiError::from)?;
        Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) as u64)
    }

    // -----------------------------------------------------------------------
    // kv_meta — used solely to throttle `last_used_at` writes
    // -----------------------------------------------------------------------

    pub async fn meta_get(&self, key: &str) -> ApiResult<Option<String>> {
        let stmt = self
            .prepare("SELECT value FROM kv_meta WHERE key = ?")
            .bind(&[JsValue::from_str(key)])
            .map_err(ApiError::from)?;
        Ok(stmt
            .first::<MetaRow>(None)
            .await
            .map_err(ApiError::from)?
            .map(|r| r.value))
    }

    pub async fn meta_set(&self, key: &str, value: &str) -> ApiResult<()> {
        let stmt = self
            .prepare(
                "INSERT INTO kv_meta (key, value) VALUES (?, ?) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(&[JsValue::from_str(key), JsValue::from_str(value)])
            .map_err(ApiError::from)?;
        stmt.run().await.map_err(ApiError::from)?;
        Ok(())
    }
}

/// Escape `%`, `_` and `\` so a user's search text is matched literally.
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '%' | '_' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

#[derive(Deserialize)]
struct CountRow {
    n: i64,
}

#[derive(Deserialize)]
struct StatsRow {
    n: i64,
    total: i64,
}

#[derive(Deserialize)]
struct MetaRow {
    value: String,
}
