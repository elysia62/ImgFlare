//! Request routing.
//!
//! Hand-written dispatch rather than a router macro: the surface is small enough
//! that an explicit match is easier to read, and it keeps the generated Wasm
//! lean. Static assets are served by Cloudflare's Static Assets layer; the Worker
//! only ever sees `/api/*` and `/login`.

use crate::auth::{self, Principal};
use crate::backup;
use crate::config::Config;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::files;
use crate::response;
use crate::tokens;
use crate::turnstile;
use crate::upload;
use serde::Deserialize;
use worker::{Env, Request, Response};

/// Entry point for every HTTP request the Worker handles.
pub async fn route(req: Request, env: Env, _ctx: worker::Context) -> Result<Response, ApiError> {
    let cfg = Config::from_env(&env)?;
    let method = req.method();

    // path without the leading slash, e.g. "api/files/abc"
    let path = req.path();
    let path = path.trim_start_matches('/');
    let segments: Vec<&str> = if path.is_empty() {
        Vec::new()
    } else {
        path.split('/').collect()
    };

    match (method, segments.as_slice()) {
        // -- pages ---------------------------------------------------------
        (worker::Method::Get, ["login"]) => render_page(&env, &cfg, "/login.html", true).await,
        (worker::Method::Get, []) | (worker::Method::Get, ["index.html"]) => {
            render_page(&env, &cfg, "/index.html", false).await
        }

        // -- auth ----------------------------------------------------------
        (worker::Method::Post, ["api", "login"]) => {
            handle_login(req, &env, &cfg).await
        }
        (worker::Method::Post, ["api", "logout"]) => handle_logout(req, &cfg),

        // -- upload --------------------------------------------------------
        (worker::Method::Post, ["api", "upload", "check"]) => {
            handle_upload_check(req, &env, &cfg).await
        }
        (worker::Method::Post, ["api", "upload"]) => {
            handle_upload(req, &env, &cfg).await
        }

        // -- files ---------------------------------------------------------
        (worker::Method::Get, ["api", "files"]) => handle_list_files(req, &env, &cfg).await,
        (worker::Method::Get, ["api", "files", id]) => {
            handle_get_file(req, &env, &cfg, id).await
        }
        (worker::Method::Delete, ["api", "files", id]) => {
            handle_delete_file(req, &env, &cfg, id).await
        }

        // -- tokens --------------------------------------------------------
        (worker::Method::Get, ["api", "tokens"]) => handle_list_tokens(req, &env).await,
        (worker::Method::Post, ["api", "tokens"]) => handle_create_token(req, &env).await,
        (worker::Method::Delete, ["api", "tokens", id]) => {
            handle_delete_token(req, &env, id).await
        }

        // -- backup --------------------------------------------------------
        (worker::Method::Get, ["api", "backup", "latest"]) => {
            handle_download_backup(req, &env).await
        }
        (worker::Method::Get, ["api", "backup", "status"]) => {
            handle_backup_status(req, &env).await
        }
        // Manual trigger, handy for testing without waiting for cron.
        (worker::Method::Post, ["api", "backup", "run"]) => {
            handle_run_backup(req, &env, &cfg).await
        }

        // -- misc ----------------------------------------------------------
        (worker::Method::Get, ["api", "me"]) => handle_me(req, &env).await,
        (worker::Method::Get, ["api", "stats"]) => handle_stats(req, &env).await,

        // Revoking is the safe, reversible action offered by the UI. A hard
        // delete is available at `?purge=1` for cleaning up test tokens.
        (worker::Method::Delete, ["api", "tokens", id, "purge"]) => {
            handle_purge_token(req, &env, id).await
        }

        // Path traversal / anything unrecognised: never fall through to assets
        // for an /api/ path, so a typo is a clear 404 rather than an HTML page.
        (_, ["api", ..]) => Err(ApiError::NotFound("unknown_endpoint")),
        _ => Err(ApiError::NotFound("not_found")),
    }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/// Serve an HTML page from the static assets binding, with the admin security
/// headers applied.
///
/// `login.html` carries a placeholder for the Turnstile site key; the Worker
/// substitutes the configured value so the key lives only in `wrangler.toml`
/// instead of being duplicated into the checked-in HTML.
async fn render_page(env: &Env, cfg: &Config, asset: &str, is_login: bool) -> ApiResult<Response> {
    let mut response = serve_asset(env, asset).await?;

    let mut html = response
        .text()
        .await
        .map_err(|e| ApiError::Internal(format!("reading {asset} failed: {e}")))?;

    if is_login {
        html = html.replace("YOUR_TURNSTILE_SITE_KEY", &cfg.turnstile_site_key);
    }

    let headers = worker::Headers::new();
    for (name, value) in [
        ("Content-Type", "text/html; charset=utf-8"),
        ("Content-Security-Policy", response::admin_csp()),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "same-origin"),
        // The panel is per-user and must never be cached by an intermediary.
        ("Cache-Control", "no-store"),
    ] {
        headers
            .set(name, value)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
    }

    Ok(response::with_headers(200, headers, html.into_bytes()))
}

/// Fetch a file straight out of the Static Assets binding.
async fn serve_asset(env: &Env, path: &str) -> ApiResult<Response> {
    let assets = env
        .get_binding::<worker::Fetcher>("ASSETS")
        .map_err(|e| ApiError::Internal(format!("ASSETS binding unavailable: {e}")))?;

    let url = format!("https://assets.internal{path}");
    let req = Request::new(&url, worker::Method::Get)
        .map_err(|e| ApiError::Internal(format!("asset request failed: {e}")))?;

    assets
        .fetch_request(req)
        .await
        .map_err(|e| ApiError::Internal(format!("asset fetch failed: {e}")))
}

// ---------------------------------------------------------------------------
// Auth handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
    #[serde(rename = "cf-turnstile-response", alias = "turnstile_token")]
    turnstile_token: String,
}

async fn handle_login(mut req: Request, env: &Env, cfg: &Config) -> ApiResult<Response> {
    // Login is same-origin from the panel, so enforce Origin here too.
    auth::check_origin(&req, cfg)?;

    let ip = client_ip(&req);
    let db = Db::from_env(env)?;

    // Turnstile is the first gate, but it is not a rate limiter: a bot can solve
    // it repeatedly. Throttle by client IP before spending a siteverify call.
    auth::check_login_allowed(&db, ip.as_deref()).await?;

    let body: LoginRequest = req
        .json()
        .await
        .map_err(|_| ApiError::BadRequest("invalid_json"))?;

    turnstile::verify(env, &body.turnstile_token, ip.as_deref()).await?;

    if !auth::verify_credentials(env, &body.username, &body.password)? {
        auth::record_login_failure(&db, ip.as_deref()).await?;
        // Same shape as a Turnstile failure, so the response does not reveal
        // which factor was wrong.
        return Err(ApiError::Unauthorized);
    }

    auth::clear_login_failures(&db, ip.as_deref()).await?;

    let cookie = auth::create_session(env, cfg)?;

    let mut resp = response::ok(serde_json::json!({ "authenticated": true }));
    resp.headers_mut()
        .set("Set-Cookie", &auth::session_set_cookie(&cookie, cfg))
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(resp)
}

fn handle_logout(req: Request, cfg: &Config) -> ApiResult<Response> {
    auth::check_origin(&req, cfg)?;

    let mut resp = response::ok(serde_json::json!({ "authenticated": false }));
    resp.headers_mut()
        .set("Set-Cookie", &auth::session_clear_cookie())
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(resp)
}

/// Who am I? Used by the front-end to decide between the panel and the login
/// page, and to learn whether the caller may delete files.
async fn handle_me(req: Request, env: &Env) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    match auth::authenticate(env, &req, &db).await {
        Ok(principal) => Ok(response::ok(serde_json::json!({
            "authenticated": true,
            "admin": principal.is_admin(),
            "username": if principal.is_admin() {
                crate::config::var(env, "ADMIN_USERNAME").unwrap_or_default()
            } else {
                String::new()
            },
            "principal": match principal {
                Principal::Admin => "admin",
                Principal::Token { .. } => "token",
            },
        }))),
        Err(_) => Ok(response::ok(serde_json::json!({
            "authenticated": false,
            "admin": false,
        }))),
    }
}

// ---------------------------------------------------------------------------
// Upload handlers
// ---------------------------------------------------------------------------

async fn handle_upload_check(mut req: Request, env: &Env, cfg: &Config) -> ApiResult<Response> {
    let db = Db::from_env(env)?;

    // Both a session and a token may call check — the userscript uses a token.
    let principal = auth::authenticate(env, &req, &db).await?;

    // CSRF applies only to cookie-authenticated callers.
    if principal.is_admin() {
        auth::check_origin(&req, cfg)?;
    }

    let body: upload::CheckRequest = req
        .json()
        .await
        .map_err(|_| ApiError::BadRequest("invalid_json"))?;

    let result = upload::handle_check(&db, cfg, body).await?;

    if let Principal::Token { id } = principal {
        let _ = auth::touch_token_throttled(&db, &id).await;
    }

    Ok(response::ok_raw(serde_json::json!({
        "success": result.success,
        "exists": result.exists,
        "file": result.file,
    })))
}

async fn handle_upload(mut req: Request, env: &Env, cfg: &Config) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    let principal = auth::authenticate(env, &req, &db).await?;

    if principal.is_admin() {
        auth::check_origin(&req, cfg)?;
    }

    if !upload::is_multipart(&req) {
        return Err(ApiError::UnsupportedMediaType("expected_multipart"));
    }

    let declared = req
        .headers()
        .get("X-File-SHA256")
        .ok()
        .flatten();

    let outcome = upload::handle_upload(&mut req, env, &db, cfg, declared).await?;

    if let Principal::Token { id } = principal {
        let _ = auth::touch_token_throttled(&db, &id).await;
    }

    Ok(response::ok_raw(serde_json::json!({
        "success": true,
        "deduplicated": outcome.deduplicated,
        "file": outcome.file,
    })))
}

// ---------------------------------------------------------------------------
// File handlers
// ---------------------------------------------------------------------------

async fn handle_list_files(req: Request, env: &Env, cfg: &Config) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    auth::require_admin(env, &req, &db).await?;

    let query: files::ListQuery = req.query().unwrap_or(files::ListQuery {
        q: None,
        limit: None,
        offset: None,
        page: None,
    });
    let result = files::handle_list(&db, cfg, query).await?;
    Ok(response::ok(result))
}

async fn handle_get_file(
    req: Request,
    env: &Env,
    cfg: &Config,
    id: &str,
) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    auth::require_admin(env, &req, &db).await?;

    let file = files::handle_get(&db, cfg, id).await?;
    Ok(response::ok(file))
}

async fn handle_delete_file(
    req: Request,
    env: &Env,
    cfg: &Config,
    id: &str,
) -> ApiResult<Response> {
    let db = Db::from_env(env)?;

    // Deletion is admin-only: an API token cannot destroy data.
    auth::require_admin(env, &req, &db).await?;
    auth::check_origin(&req, cfg)?;

    files::handle_delete(env, &db, id).await?;
    Ok(response::no_content())
}

async fn handle_stats(req: Request, env: &Env) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    auth::require_admin(env, &req, &db).await?;

    let stats = files::handle_stats(&db).await?;
    Ok(response::ok(stats))
}

// ---------------------------------------------------------------------------
// Token handlers
// ---------------------------------------------------------------------------

async fn handle_list_tokens(req: Request, env: &Env) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    auth::require_admin(env, &req, &db).await?;

    let list = tokens::handle_list(&db).await?;
    Ok(response::ok(list))
}

async fn handle_create_token(mut req: Request, env: &Env) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    auth::require_admin(env, &req, &db).await?;

    let cfg = Config::from_env(env)?;
    auth::check_origin(&req, &cfg)?;

    let body: tokens::CreateTokenRequest = req
        .json()
        .await
        .map_err(|_| ApiError::BadRequest("invalid_json"))?;

    let created = tokens::handle_create(&db, body).await?;
    Ok(response::ok(created))
}

async fn handle_delete_token(req: Request, env: &Env, id: &str) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    auth::require_admin(env, &req, &db).await?;

    let cfg = Config::from_env(env)?;
    auth::check_origin(&req, &cfg)?;

    tokens::handle_revoke(&db, id).await?;
    Ok(response::no_content())
}

/// Permanently remove a token row. `DELETE /api/tokens/:id/purge`
async fn handle_purge_token(req: Request, env: &Env, id: &str) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    auth::require_admin(env, &req, &db).await?;

    let cfg = Config::from_env(env)?;
    auth::check_origin(&req, &cfg)?;

    tokens::handle_delete(&db, id).await?;
    Ok(response::no_content())
}

// ---------------------------------------------------------------------------
// Backup handlers
// ---------------------------------------------------------------------------

async fn handle_download_backup(req: Request, env: &Env) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    auth::require_admin(env, &req, &db).await?;

    let bytes = backup::download_latest(env).await?;

    // `Headers` is a reference type; `set` mutates through the shared handle.
    let headers = worker::Headers::new();
    headers
        .set("Content-Type", "application/sql")
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    headers
        .set(
            "Content-Disposition",
            "attachment; filename=\"latest.sql\"",
        )
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    headers
        .set("Cache-Control", "no-store")
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(response::with_headers(200, headers, bytes))
}

async fn handle_backup_status(req: Request, env: &Env) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    auth::require_admin(env, &req, &db).await?;

    let status = backup::read_status(env).await?;
    // Field names must match `BackupStatus` in frontend/src/types.ts exactly.
    // The whole API is camelCase; a stray snake_case key here silently renders
    // as `undefined` on the client instead of failing loudly.
    Ok(response::ok(serde_json::json!({
        "exists": status.exists,
        "size": status.size,
        "sha256": status.sha256,
        "uploadedAt": status.uploaded_at,
        "cron": "0 4 * * *",
    })))
}

async fn handle_run_backup(req: Request, env: &Env, cfg: &Config) -> ApiResult<Response> {
    let db = Db::from_env(env)?;
    auth::require_admin(env, &req, &db).await?;
    auth::check_origin(&req, cfg)?;

    let report = backup::run_backup_with_retries(env, cfg).await?;
    Ok(response::ok(serde_json::json!({
        "bytes": report.bytes,
        "sha256": report.sha256,
        "finished_at": report.finished_at,
    })))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Best-effort client IP from Cloudflare's connecting-IP header.
fn client_ip(req: &Request) -> Option<String> {
    req.headers()
        .get("CF-Connecting-IP")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}
