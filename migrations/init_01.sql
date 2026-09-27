-- init_01.sql
-- Personal Image Host — initial D1 schema.
--
-- Two real tables (`files`, `api_tokens`) plus one tiny helper table
-- (`kv_meta`) used only to throttle `last_used_at` writes so that a
-- high-traffic token does not hammer D1 on every single upload.

-- ---------------------------------------------------------------------------
-- files: content-addressed index of every object stored in the public R2 bucket
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
    id            TEXT PRIMARY KEY,
    sha256        TEXT NOT NULL UNIQUE,
    r2_key        TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    size          INTEGER NOT NULL,
    etag          TEXT,
    created_at    INTEGER NOT NULL
);

-- Content addressing means the SHA-256 is the natural unique key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_sha256
    ON files(sha256);

-- The file list is always paginated newest-first.
CREATE INDEX IF NOT EXISTS idx_files_created_at
    ON files(created_at DESC);

-- ---------------------------------------------------------------------------
-- api_tokens: API tokens for the userscript (X-API-Key header)
-- Only SHA-256(token) is ever stored — never the plaintext token.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash
    ON api_tokens(token_hash);

-- ---------------------------------------------------------------------------
-- kv_meta: tiny key/value scratch space.
-- Holds the last time we wrote `api_tokens.last_used_at` for a given token so
-- that we write at most once per hour instead of on every request.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kv_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
