-- init_02.sql was already applied before being folded into the baseline.
CREATE INDEX IF NOT EXISTS idx_files_thumbnail ON files(thumbnail_r2_key);

-- Coordinate backup writes and cleanup across Worker instances.
CREATE TABLE IF NOT EXISTS maintenance_locks (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
