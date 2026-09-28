-- One SELECT gives all three application tables a single consistent snapshot.
-- Encode text as UTF-8 blobs cast back to TEXT: quotes, newlines and NUL survive.
-- The window totals keep oversized exports inside D1, before Worker allocation.
WITH rows(statement) AS (
  SELECT 'INSERT INTO files(id,sha256,r2_key,original_name,content_type,size,etag,created_at) VALUES (' ||
    'CAST(X''' || hex(id) || ''' AS TEXT),' ||
    'CAST(X''' || hex(sha256) || ''' AS TEXT),' ||
    'CAST(X''' || hex(r2_key) || ''' AS TEXT),' ||
    'CAST(X''' || hex(original_name) || ''' AS TEXT),' ||
    'CAST(X''' || hex(content_type) || ''' AS TEXT),' ||
    quote(size) || ',' ||
    CASE WHEN etag IS NULL THEN 'NULL' ELSE 'CAST(X''' || hex(etag) || ''' AS TEXT)' END || ',' ||
    quote(created_at) || ');'
  FROM files
  UNION ALL
  SELECT 'INSERT INTO api_tokens(id,name,token_hash,created_at,last_used_at) VALUES (' ||
    'CAST(X''' || hex(id) || ''' AS TEXT),' ||
    'CAST(X''' || hex(name) || ''' AS TEXT),' ||
    'CAST(X''' || hex(token_hash) || ''' AS TEXT),' ||
    quote(created_at) || ',' || quote(last_used_at) || ');'
  FROM api_tokens
  UNION ALL
  SELECT 'INSERT INTO kv_meta(key,value) VALUES (' ||
    'CAST(X''' || hex(key) || ''' AS TEXT),' ||
    'CAST(X''' || hex(value) || ''' AS TEXT));'
  FROM kv_meta
), sized AS (
  SELECT statement, SUM(length(statement) + 1) OVER () AS bytes, COUNT(*) OVER () AS n
  FROM rows
)
SELECT statement FROM sized WHERE bytes <= ?1 AND n <= ?2
UNION ALL
SELECT NULL AS statement FROM sized WHERE bytes > ?1 OR n > ?2 GROUP BY bytes, n
