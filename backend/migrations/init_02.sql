ALTER TABLE files ADD COLUMN thumbnail_r2_key TEXT;
CREATE INDEX idx_files_cursor ON files(created_at DESC, id DESC);

-- Persist intent before touching R2. Failed or interrupted operations are retried.
CREATE TABLE cleanup_jobs (
    r2_key TEXT PRIMARY KEY,
    not_before INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_cleanup_due ON cleanup_jobs(not_before, created_at);

CREATE TABLE backup_snapshots (
    r2_key TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL
);
CREATE INDEX idx_backup_created ON backup_snapshots(created_at DESC, r2_key DESC);
