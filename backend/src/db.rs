//! D1 access layer.
//!
//! Every query in this crate goes through here, and every user-supplied value is
//! passed as a *bound parameter* — there is no string interpolation of user
//! input into SQL anywhere in the project.

use crate::error::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use worker::Env;
use worker::d1::{D1Database, D1PreparedStatement};
use worker::wasm_bindgen::JsValue;

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
    pub thumbnail_r2_key: Option<String>,
}

/// A row from the `api_tokens` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenRecord {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
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

    /// Export the known application schema and a consistent snapshot of its data.
    pub async fn export_sql(&self) -> ApiResult<Vec<u8>> {
        const MAX_DATA_BYTES: u32 = 8 * 1024 * 1024;
        const MAX_ROWS: u32 = 20_000;
        #[derive(Deserialize)]
        struct SqlRow {
            statement: Option<String>,
        }

        let result = self
            .prepare(include_str!("backup.sql"))
            .bind(&[
                JsValue::from_f64(MAX_DATA_BYTES as f64),
                JsValue::from_f64(MAX_ROWS as f64),
            ])?
            .all()
            .await?;
        if !result.success() {
            return Err(ApiError::Internal("D1 SQL export failed".into()));
        }
        let rows: Vec<SqlRow> = result.results()?;
        let mut sql =
            String::from("-- ImgFlare application backup. Restore into an empty database.\n");
        sql.push_str(include_str!("../schema.sql"));
        sql.push('\n');
        for row in rows {
            let statement = row.statement.ok_or_else(|| {
                ApiError::Internal(
                    "backup exceeds 8 MiB of SQL data or 20000 rows; use wrangler d1 export".into(),
                )
            })?;
            sql.push_str(&statement);
            sql.push('\n');
        }
        Ok(sql.into_bytes())
    }

    /// Build a statement. The SQL string here is always a constant.
    fn prepare(&self, sql: &str) -> D1PreparedStatement {
        self.inner.prepare(sql)
    }

    // files

    /// Look up a file by its SHA-256 (the deduplication key).
    pub async fn find_file_by_sha256(&self, sha256: &str) -> ApiResult<Option<FileRecord>> {
        let stmt = self
            .prepare(
                "SELECT id, sha256, r2_key, original_name, content_type, size, etag, created_at, thumbnail_r2_key \
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
                "SELECT id, sha256, r2_key, original_name, content_type, size, etag, created_at, thumbnail_r2_key \
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
        let stmt = self.prepare(
            "INSERT INTO files (id,sha256,r2_key,original_name,content_type,size,etag,created_at,thumbnail_r2_key) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(&[
            JsValue::from_str(&file.id), JsValue::from_str(&file.sha256),
            JsValue::from_str(&file.r2_key), JsValue::from_str(&file.original_name),
            JsValue::from_str(&file.content_type), JsValue::from_f64(file.size as f64),
            optional(&file.etag), JsValue::from_f64(file.created_at as f64), optional(&file.thumbnail_r2_key),
        ])?;
        let done = self
            .prepare("DELETE FROM cleanup_jobs WHERE r2_key IN (?,?)")
            .bind(&[
                JsValue::from_str(&file.r2_key),
                optional(&file.thumbnail_r2_key),
            ])?;
        self.inner.batch(vec![stmt, done]).await?;
        Ok(())
    }

    pub async fn stage_object(&self, key: &str) -> ApiResult<()> {
        let now = crate::utils::now_ms();
        self.prepare("INSERT INTO cleanup_jobs(r2_key,not_before,created_at) VALUES (?,?,?)")
            .bind(&[
                JsValue::from_str(key),
                JsValue::from_f64((now + 900_000) as f64),
                JsValue::from_f64(now as f64),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Enqueue both objects and remove the index in one D1 transaction.
    pub async fn delete_file(&self, id: &str) -> ApiResult<()> {
        let now = JsValue::from_f64(crate::utils::now_ms() as f64);
        let jobs = self.prepare(
            "INSERT OR IGNORE INTO cleanup_jobs(r2_key,not_before,created_at) SELECT r2_key,?,? FROM files WHERE id=? UNION ALL SELECT thumbnail_r2_key,?,? FROM files WHERE id=? AND thumbnail_r2_key IS NOT NULL"
        ).bind(&[now.clone(),now.clone(),JsValue::from_str(id),now.clone(),now,JsValue::from_str(id)])?;
        let remove = self
            .prepare("DELETE FROM files WHERE id=?")
            .bind(&[JsValue::from_str(id)])?;
        self.inner.batch(vec![jobs, remove]).await?;
        Ok(())
    }

    pub async fn find_file_by_key(&self, key: &str) -> ApiResult<Option<FileRecord>> {
        Ok(self
            .prepare("SELECT * FROM files WHERE r2_key=? OR thumbnail_r2_key=?")
            .bind(&[JsValue::from_str(key), JsValue::from_str(key)])?
            .first(None)
            .await?)
    }

    pub async fn object_referenced(&self, key: &str) -> ApiResult<bool> {
        let row = self.prepare("SELECT COUNT(*) AS n FROM (SELECT id FROM files WHERE r2_key=? OR thumbnail_r2_key=? UNION ALL SELECT r2_key FROM backup_snapshots WHERE r2_key=?)")
            .bind(&[JsValue::from_str(key),JsValue::from_str(key),JsValue::from_str(key)])?
            .first::<CountRow>(None).await?;
        Ok(row.is_some_and(|r| r.n > 0))
    }

    pub async fn finish_cleanup(&self, key: &str) -> ApiResult<()> {
        self.prepare("DELETE FROM cleanup_jobs WHERE r2_key=?")
            .bind(&[JsValue::from_str(key)])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn due_cleanup(&self) -> ApiResult<Vec<CleanupJob>> {
        Ok(self
            .prepare(
                "SELECT r2_key FROM cleanup_jobs WHERE not_before<=? ORDER BY created_at LIMIT 20",
            )
            .bind(&[JsValue::from_f64(crate::utils::now_ms() as f64)])?
            .all()
            .await?
            .results()?)
    }

    pub async fn attach_thumbnail(&self, id: &str, key: &str) -> ApiResult<()> {
        // Keep staging intent if the file disappeared or another thumbnail won.
        let attach = self
            .prepare("UPDATE files SET thumbnail_r2_key=? WHERE id=? AND thumbnail_r2_key IS NULL")
            .bind(&[JsValue::from_str(key), JsValue::from_str(id)])?;
        let done = self.prepare("DELETE FROM cleanup_jobs WHERE r2_key=? AND EXISTS(SELECT 1 FROM files WHERE thumbnail_r2_key=?)")
            .bind(&[JsValue::from_str(key),JsValue::from_str(key)])?;
        self.inner.batch(vec![attach, done]).await?;
        Ok(())
    }

    /// Stable keyset paging by creation time and file ID.
    pub async fn list_files(
        &self,
        search: Option<&str>,
        limit: u32,
        cursor: Option<(i64, &str)>,
    ) -> ApiResult<(Vec<FileRecord>, i64)> {
        let pattern = search
            .filter(|s| !s.is_empty())
            .map(|s| format!("%{}%", escape_like(s)));
        let count = self.prepare("SELECT COUNT(*) AS n FROM files WHERE (?1 IS NULL OR original_name LIKE ?1 ESCAPE '\\')")
            .bind(&[optional(&pattern)])?;
        let (time, id) = cursor
            .map(|(t, id)| (JsValue::from_f64(t as f64), JsValue::from_str(id)))
            .unwrap_or((JsValue::NULL, JsValue::NULL));
        let page = self.prepare("SELECT * FROM files WHERE (?1 IS NULL OR original_name LIKE ?1 ESCAPE '\\') AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3)) ORDER BY created_at DESC,id DESC LIMIT ?4")
            .bind(&[optional(&pattern),time,id,JsValue::from_f64((limit+1) as f64)])?;
        let results = self.inner.batch(vec![count, page]).await?;
        let total = results[0]
            .results::<CountRow>()?
            .first()
            .map(|r| r.n)
            .unwrap_or(0);
        Ok((results[1].results()?, total))
    }

    pub async fn record_backup(&self, key: &str, sha256: &str, size: u64) -> ApiResult<()> {
        let add = self
            .prepare("INSERT INTO backup_snapshots(r2_key,created_at,sha256,size) VALUES (?,?,?,?)")
            .bind(&[
                JsValue::from_str(key),
                JsValue::from_f64(crate::utils::now_ms() as f64),
                JsValue::from_str(sha256),
                JsValue::from_f64(size as f64),
            ])?;
        let done = self
            .prepare("DELETE FROM cleanup_jobs WHERE r2_key=?")
            .bind(&[JsValue::from_str(key)])?;
        self.inner.batch(vec![add, done]).await?;
        Ok(())
    }

    pub async fn prune_backups(&self) -> ApiResult<()> {
        // Newest 30 snapshots survive. Queue old keys before removing metadata.
        let now = JsValue::from_f64(crate::utils::now_ms() as f64);
        let jobs = self.prepare("INSERT OR IGNORE INTO cleanup_jobs(r2_key,not_before,created_at) SELECT r2_key,?,? FROM backup_snapshots ORDER BY created_at DESC,r2_key DESC LIMIT -1 OFFSET 30")
            .bind(&[now.clone(),now])?;
        let remove = self.prepare("DELETE FROM backup_snapshots WHERE r2_key IN (SELECT r2_key FROM backup_snapshots ORDER BY created_at DESC,r2_key DESC LIMIT -1 OFFSET 30)");
        self.inner.batch(vec![jobs, remove]).await?;
        Ok(())
    }

    // api_tokens

    pub async fn find_token_by_hash(&self, token_hash: &str) -> ApiResult<Option<TokenRecord>> {
        let stmt = self
            .prepare(
                "SELECT id, name, token_hash, created_at, last_used_at \
                 FROM api_tokens WHERE token_hash = ?",
            )
            .bind(&[JsValue::from_str(token_hash)])
            .map_err(ApiError::from)?;

        stmt.first::<TokenRecord>(None)
            .await
            .map_err(ApiError::from)
    }

    pub async fn list_tokens(&self) -> ApiResult<Vec<TokenRecord>> {
        let stmt = self.prepare(
            "SELECT id, name, token_hash, created_at, last_used_at \
             FROM api_tokens ORDER BY created_at DESC",
        );
        let result = stmt.all().await.map_err(ApiError::from)?;
        result.results().map_err(ApiError::from)
    }

    pub async fn insert_token(&self, token: &TokenRecord) -> ApiResult<()> {
        let stmt = self
            .prepare(
                "INSERT INTO api_tokens \
                 (id, name, token_hash, created_at, last_used_at) \
                 VALUES (?, ?, ?, ?, NULL)",
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

    /// Hard-delete a token row, so nothing can authenticate with it afterwards.
    pub async fn delete_token(&self, id: &str) -> ApiResult<u64> {
        let stmt = self
            .prepare("DELETE FROM api_tokens WHERE id = ?")
            .bind(&[JsValue::from_str(id)])
            .map_err(ApiError::from)?;
        let result = stmt.run().await.map_err(ApiError::from)?;
        Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) as u64)
    }

    // kv_meta — used solely to throttle `last_used_at` writes

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

    pub async fn meta_delete(&self, key: &str) -> ApiResult<()> {
        let stmt = self
            .prepare("DELETE FROM kv_meta WHERE key = ?")
            .bind(&[JsValue::from_str(key)])
            .map_err(ApiError::from)?;
        stmt.run().await.map_err(ApiError::from)?;
        Ok(())
    }

    /// Sweep only expired login windows, preserving current throttling.
    pub async fn prune_login_failures(&self) -> ApiResult<()> {
        self.prepare("DELETE FROM kv_meta WHERE key LIKE 'login\\_fail:%' ESCAPE '\\' AND CAST(substr(value,instr(value,':')+1) AS INTEGER) < ?")
            .bind(&[JsValue::from_f64((crate::utils::now_ms()-900_000) as f64)])?.run().await?;
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
struct MetaRow {
    value: String,
}

fn optional(value: &Option<String>) -> JsValue {
    value
        .as_deref()
        .map(JsValue::from_str)
        .unwrap_or(JsValue::NULL)
}
#[derive(Deserialize)]
pub struct CleanupJob {
    pub r2_key: String,
}
