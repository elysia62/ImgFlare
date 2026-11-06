-- The cursor index also covers ordering by created_at alone.
DROP INDEX IF EXISTS idx_files_created_at;

-- last_used_at in api_tokens now supplies the throttling timestamp.
DELETE FROM kv_meta WHERE key GLOB 'token_touch:*';
