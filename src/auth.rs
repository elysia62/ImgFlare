//! Authentication: admin password, signed session cookies, CSRF and API tokens.
//!
//! There is exactly one administrator. No users table, no registration, no
//! password recovery — the password lives in the `ADMIN_PASSWORD` secret and
//! sessions are stateless signed cookies, so nothing auth-related is persisted.

use crate::config::{Config, secret, var};
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::utils::{
    base64url_decode, base64url_encode, constant_time_eq, hmac_sha256, now_ms, sha256_hex,
};
use worker::{Env, Request};

pub const SESSION_COOKIE: &str = "pih_session";

/// How the caller proved who they are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    /// A browser with a valid signed session cookie. Full access.
    Admin,
    /// A userscript presenting `X-API-Key`. Upload/check only.
    Token { id: String },
}

impl Principal {
    /// May this principal delete files or manage tokens?
    pub fn is_admin(&self) -> bool {
        matches!(self, Principal::Admin)
    }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// Verify the submitted username and password against `ADMIN_USERNAME` and
/// `ADMIN_PASSWORD`.
///
/// Both comparisons always run, and the results are combined at the end, so the
/// response time does not reveal which of the two was wrong.
pub fn verify_credentials(env: &Env, username: &str, password: &str) -> ApiResult<bool> {
    let expected_user = var(env, "ADMIN_USERNAME")?;
    let expected_pass = secret(env, "ADMIN_PASSWORD")?;

    let user_ok = constant_time_eq(username.as_bytes(), expected_user.as_bytes());
    let pass_ok = constant_time_eq(password.as_bytes(), expected_pass.as_bytes());

    Ok(user_ok & pass_ok)
}

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

/// The signed session payload.
///
/// ```text
/// cookie value = base64url(payload_json) "." base64url(HMAC-SHA256(payload_json))
/// ```
#[derive(serde::Serialize, serde::Deserialize)]
struct SessionPayload {
    /// issued at, ms since epoch
    iat: i64,
    /// expires at, ms since epoch
    exp: i64,
    /// random nonce, so two sessions issued in the same millisecond differ
    nonce: String,
}

/// Issue a fresh session cookie value.
pub fn create_session(env: &Env, cfg: &Config) -> ApiResult<String> {
    let secret = secret(env, "SESSION_SECRET")?;
    let now = now_ms();

    let payload = SessionPayload {
        iat: now,
        exp: now + cfg.session_ttl_seconds * 1000,
        nonce: crate::utils::random_token(24),
    };

    let payload_json =
        serde_json::to_vec(&payload).map_err(|e| ApiError::Internal(e.to_string()))?;
    let sig = hmac_sha256(secret.as_bytes(), &payload_json);

    Ok(format!(
        "{}.{}",
        base64url_encode(&payload_json),
        base64url_encode(&sig)
    ))
}

/// Verify a cookie value. Returns `Ok(())` when the signature is valid and the
/// session has not expired.
pub fn verify_session(env: &Env, cookie_value: &str) -> ApiResult<()> {
    let secret = secret(env, "SESSION_SECRET")?;

    let (payload_b64, sig_b64) = cookie_value
        .split_once('.')
        .ok_or(ApiError::Unauthorized)?;

    let payload_json = base64url_decode(payload_b64).ok_or(ApiError::Unauthorized)?;
    let provided_sig = base64url_decode(sig_b64).ok_or(ApiError::Unauthorized)?;
    let expected_sig = hmac_sha256(secret.as_bytes(), &payload_json);

    // Signature first — never parse untrusted payload before authenticity.
    if !constant_time_eq(&provided_sig, &expected_sig) {
        return Err(ApiError::Unauthorized);
    }

    let payload: SessionPayload =
        serde_json::from_slice(&payload_json).map_err(|_| ApiError::Unauthorized)?;

    if payload.exp < now_ms() {
        return Err(ApiError::Unauthorized);
    }

    Ok(())
}

/// The `Set-Cookie` header for a new session.
pub fn session_set_cookie(value: &str, cfg: &Config) -> String {
    format!(
        "{SESSION_COOKIE}={value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={}",
        cfg.session_ttl_seconds
    )
}

/// The `Set-Cookie` header that clears the session.
pub fn session_clear_cookie() -> String {
    format!("{SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0")
}

/// Read the session cookie out of a request's `Cookie` header.
fn session_cookie_from_request(req: &Request) -> Option<String> {
    let raw = req.headers().get("Cookie").ok()??;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix(&format!("{SESSION_COOKIE}=")) {
            return Some(v.to_string());
        }
    }
    None
}

/// Does this request carry a valid session cookie?
pub fn has_valid_session(env: &Env, req: &Request) -> bool {
    match session_cookie_from_request(req) {
        Some(v) => verify_session(env, &v).is_ok(),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Principal resolution
// ---------------------------------------------------------------------------

/// Resolve who is calling.
///
/// A valid session cookie wins. Otherwise an `X-API-Key` header is checked
/// against the hashed token table.
pub async fn authenticate(
    env: &Env,
    req: &Request,
    db: &Db,
) -> ApiResult<Principal> {
    if has_valid_session(env, req) {
        return Ok(Principal::Admin);
    }

    if let Some(token) = req
        .headers()
        .get("X-API-Key")
        .ok()
        .flatten()
        .filter(|t| !t.is_empty())
    {
        return verify_api_token(db, &token).await;
    }

    Err(ApiError::Unauthorized)
}

/// Authenticate for admin-only operations.
pub async fn require_admin(env: &Env, req: &Request, db: &Db) -> ApiResult<Principal> {
    let principal = authenticate(env, req, db).await?;
    if !principal.is_admin() {
        return Err(ApiError::Forbidden("admin_only"));
    }
    Ok(principal)
}

/// Look up an API token by hashing what the client sent.
///
/// Only `SHA-256(token)` is stored, so a database leak does not reveal tokens.
pub async fn verify_api_token(db: &Db, presented: &str) -> ApiResult<Principal> {
    // Cheap shape check before touching D1.
    if !presented.starts_with("cph_") || presented.len() < 20 {
        return Err(ApiError::Unauthorized);
    }

    let hash = sha256_hex(presented.as_bytes());
    let record = db
        .find_token_by_hash(&hash)
        .await?
        .ok_or(ApiError::Unauthorized)?;

    if record.revoked_at.is_some() {
        return Err(ApiError::Forbidden("token_revoked"));
    }

    Ok(Principal::Token { id: record.id })
}

/// Record `last_used_at`, but at most once per hour per token.
///
/// Without the throttle, every upload from the userscript would be an extra D1
/// write. The timestamp is kept in the tiny `kv_meta` table.
pub async fn touch_token_throttled(db: &Db, token_id: &str) -> ApiResult<()> {
    const INTERVAL_MS: i64 = 60 * 60 * 1000; // one hour
    let key = format!("token_touch:{token_id}");
    let now = now_ms();

    if let Some(last) = db.meta_get(&key).await?
        && let Ok(last_ms) = last.parse::<i64>()
        && now - last_ms < INTERVAL_MS
    {
        return Ok(());
    }

    db.touch_token(token_id).await?;
    db.meta_set(&key, &now.to_string()).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------

/// Failed attempts allowed per IP inside [`LOGIN_WINDOW_MS`].
const LOGIN_MAX_ATTEMPTS: i64 = 8;
/// Sliding window length.
const LOGIN_WINDOW_MS: i64 = 15 * 60 * 1000;

/// Counter key for an IP. Unattributable requests share one bucket.
fn login_key(ip: Option<&str>) -> String {
    format!("login_fail:{}", ip.unwrap_or("unknown"))
}

/// Reject the attempt if this IP has already failed too many times.
pub async fn check_login_allowed(db: &Db, ip: Option<&str>) -> ApiResult<()> {
    let key = login_key(ip);
    let Some(raw) = db.meta_get(&key).await? else {
        return Ok(());
    };

    // Stored as `<count>:<first_failure_ms>`.
    let Some((count, since)) = raw.split_once(':') else {
        return Ok(());
    };
    let (Ok(count), Ok(since)) = (count.parse::<i64>(), since.parse::<i64>()) else {
        return Ok(());
    };

    // Window elapsed — start over.
    if now_ms() - since > LOGIN_WINDOW_MS {
        db.meta_delete(&key).await?;
        return Ok(());
    }

    if count >= LOGIN_MAX_ATTEMPTS {
        return Err(ApiError::TooManyRequests("too_many_attempts"));
    }

    Ok(())
}

/// Count one failed attempt, keeping the window's original start time.
pub async fn record_login_failure(db: &Db, ip: Option<&str>) -> ApiResult<()> {
    let key = login_key(ip);
    let now = now_ms();

    let (count, since) = match db.meta_get(&key).await? {
        Some(raw) => match raw.split_once(':') {
            Some((c, s)) => match (c.parse::<i64>(), s.parse::<i64>()) {
                (Ok(c), Ok(s)) if now - s <= LOGIN_WINDOW_MS => (c, s),
                _ => (0, now),
            },
            None => (0, now),
        },
        None => (0, now),
    };

    db.meta_set(&key, &format!("{}:{}", count + 1, since)).await?;
    Ok(())
}

/// Reset the counter after a successful login.
pub async fn clear_login_failures(db: &Db, ip: Option<&str>) -> ApiResult<()> {
    db.meta_delete(&login_key(ip)).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/// For cookie-authenticated `POST`/`DELETE`, the `Origin` header must match the
/// panel origin.
///
/// Requests authenticated with an API token are exempt: they do not rely on
/// cookies, so a malicious page cannot ride the user's session.
pub fn check_origin(req: &Request, cfg: &Config) -> ApiResult<()> {
    match req.headers().get("Origin").ok().flatten() {
        Some(origin) => {
            if origin.trim_end_matches('/') == cfg.panel_origin {
                Ok(())
            } else {
                Err(ApiError::Forbidden("bad_origin"))
            }
        }
        // Same-origin `fetch()` from older browsers may omit Origin on GET, but
        // a state-changing request without Origin is rejected rather than
        // assumed safe.
        None => Err(ApiError::Forbidden("missing_origin")),
    }
}

// ---------------------------------------------------------------------------
// API token generation
// ---------------------------------------------------------------------------

/// A freshly minted API token: the plaintext (shown exactly once) and its hash.
pub struct NewToken {
    pub plaintext: String,
    pub hash: String,
}

/// Generate a new `cph_…` token. 32 random bytes, base64url encoded.
pub fn generate_api_token() -> NewToken {
    let raw = crate::utils::random_bytes(32);
    let plaintext = format!("cph_{}", base64url_encode(&raw));
    let hash = sha256_hex(plaintext.as_bytes());
    NewToken { plaintext, hash }
}

/// Is this a syntactically plausible API token? Used to reject junk early.
pub fn is_plausible_token(token: &str) -> bool {
    token.starts_with("cph_") && token.len() >= 20 && token.len() <= 128
}
