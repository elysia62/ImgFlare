-- Current restore schema; keep in sync with initialization and future migrations.
CREATE TABLE IF NOT EXISTS files (
    id            TEXT PRIMARY KEY,
    sha256        TEXT NOT NULL UNIQUE,
    r2_key        TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    size          INTEGER NOT NULL,
    etag          TEXT,
    created_at    INTEGER NOT NULL,
    thumbnail_r2_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_created_at
    ON files(created_at DESC);

CREATE TABLE IF NOT EXISTS api_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS kv_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_cursor ON files(created_at DESC, id DESC);

-- Persist intent before touching R2. Failed or interrupted operations are retried.
CREATE TABLE IF NOT EXISTS cleanup_jobs (
    r2_key TEXT PRIMARY KEY,
    not_before INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cleanup_due ON cleanup_jobs(not_before, created_at);

CREATE TABLE IF NOT EXISTS backup_snapshots (
    r2_key TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backup_created ON backup_snapshots(created_at DESC, r2_key DESC);

-- Restored databases already have the complete initialization baseline.
CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations(name) VALUES ('init_01.sql');
