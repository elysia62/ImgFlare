//! Configuration read from the Worker environment.
//!
//! Plain variables (`PUBLIC_BASE_URL`, `MAX_UPLOAD_SIZE`, …) live in
//! `wrangler.toml`. Secrets (`ADMIN_PASSWORD`, `SESSION_SECRET`,
//! `TURNSTILE_SECRET`, `CLOUDFLARE_API_TOKEN`) are set with `wrangler secret`
//! and are never written to source control.

use crate::error::{ApiError, ApiResult};
use worker::Env;

/// Everything the handlers need, resolved once per request.
#[derive(Clone)]
pub struct Config {
    pub public_base_url: String,
    pub panel_origin: String,
    pub account_id: String,
    pub database_id: String,
    pub max_upload_size: usize,
    pub turnstile_site_key: String,
    pub session_ttl_seconds: i64,
}

impl Config {
    pub fn from_env(env: &Env) -> ApiResult<Self> {
        let public_base_url = var(env, "PUBLIC_BASE_URL")?
            .trim_end_matches('/')
            .to_string();

        // An unsubstituted placeholder would ship a login page whose Turnstile
        // widget never renders, and the failure would only show up in the
        // browser. Refuse to serve instead.
        let turnstile_site_key = var(env, "TURNSTILE_SITE_KEY")?;
        if turnstile_site_key.starts_with("YOUR_") {
            return Err(ApiError::Internal(
                "TURNSTILE_SITE_KEY is still the placeholder from wrangler.toml; \
                 set it to the Site Key from your Turnstile widget"
                    .into(),
            ));
        }

        let panel_origin = var(env, "PANEL_ORIGIN")?
            .trim_end_matches('/')
            .to_string();

        let max_upload_size = var(env, "MAX_UPLOAD_SIZE")?
            .parse::<usize>()
            .map_err(|_| ApiError::Internal("MAX_UPLOAD_SIZE is not a number".into()))?;

        let session_ttl_seconds = env
            .var("SESSION_TTL_SECONDS")
            .ok()
            .and_then(|v| v.to_string().parse::<i64>().ok())
            .unwrap_or(604_800);

        // Security invariant: the panel and the public asset host MUST be
        // different origins.
        //
        // Everything that makes this design safe rests on that split. The
        // panel origin holds a session cookie and serves the admin UI; the
        // public origin serves user-uploaded files verbatim, with no auth and
        // no sanitising. If they were ever the same origin, an uploaded HTML
        // or SVG file could read the admin session and the whole CSRF story
        // collapses.
        //
        // Deploying misconfigured is an easy mistake, so refuse to serve
        // rather than run in an unsafe shape. This is checked once per request
        // (it is a couple of string compares).
        if origin_of(&public_base_url) == origin_of(&panel_origin) {
            return Err(ApiError::Internal(
                "PUBLIC_BASE_URL and PANEL_ORIGIN must be different origins; \
                 uploaded files are served unauthenticated from the former and \
                 must not share an origin with the admin panel"
                    .into(),
            ));
        }

        Ok(Self {
            public_base_url,
            panel_origin,
            account_id: env
                .var("ACCOUNT_ID")
                .map(|v| v.to_string())
                .unwrap_or_default(),
            database_id: env
                .var("DATABASE_ID")
                .map(|v| v.to_string())
                .unwrap_or_default(),
            max_upload_size,
            turnstile_site_key,
            session_ttl_seconds,
        })
    }

    /// Public URL for a stored object.
    pub fn public_url(&self, sha256: &str) -> String {
        format!("{}/f/{}", self.public_base_url, sha256)
    }
}

/// Read a required plain variable.
pub fn var(env: &Env, key: &'static str) -> ApiResult<String> {
    env.var(key)
        .map(|v| v.to_string())
        .map_err(|_| ApiError::Internal(format!("missing required variable {key}")))
}

/// Reduce a URL to its scheme + host + port, ignoring any path.
///
/// `https://panel.example.com/admin` and `https://panel.example.com` are the
/// same origin; `https://panel.example.com` and `https://img.example.com` are
/// not. Falls back to the raw string when the input is not a parseable URL, so
/// a malformed value still compares unequal instead of silently matching.
fn origin_of(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
            format!("{}://{}", scheme.to_ascii_lowercase(), authority.to_ascii_lowercase())
        }
        None => url.trim_end_matches('/').to_ascii_lowercase(),
    }
}

/// Read a required secret.
pub fn secret(env: &Env, key: &'static str) -> ApiResult<String> {
    env.secret(key)
        .map(|v| v.to_string())
        .map_err(|_| ApiError::Internal(format!("missing required secret {key}")))
}
