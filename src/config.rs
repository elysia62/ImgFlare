//! Configuration read from the Worker environment.
//!
//! Plain variables live in `wrangler.toml`. Secrets (`ADMIN_PASSWORD`,
//! `SESSION_SECRET`, `TURNSTILE_SECRET`) are set with `wrangler secret` and are
//! never written to source control.

use crate::error::{ApiError, ApiResult};
use worker::Env;

/// Everything the handlers need, resolved once per request.
#[derive(Clone)]
pub struct Config {
    /// Origin this Worker is served from, e.g. `https://imgflare.example.com`.
    /// Public file URLs and CSRF checks are both derived from it.
    pub origin: String,
    pub max_upload_size: usize,
    pub turnstile_site_key: String,
    pub session_ttl_seconds: i64,
}

impl Config {
    pub fn from_env(env: &Env) -> ApiResult<Self> {
        let origin = var(env, "ORIGIN")?.trim_end_matches('/').to_string();

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

        let max_upload_size = var(env, "MAX_UPLOAD_SIZE")?
            .parse::<usize>()
            .map_err(|_| ApiError::Internal("MAX_UPLOAD_SIZE is not a number".into()))?;

        let session_ttl_seconds = env
            .var("SESSION_TTL_SECONDS")
            .ok()
            .and_then(|v| v.to_string().parse::<i64>().ok())
            .unwrap_or(604_800);

        Ok(Self {
            origin,
            max_upload_size,
            turnstile_site_key,
            session_ttl_seconds,
        })
    }

    /// Public URL for a stored object.
    pub fn public_url(&self, sha256: &str) -> String {
        format!("{}/i/{}", self.origin, sha256)
    }
}

/// Read a required plain variable.
pub fn var(env: &Env, key: &'static str) -> ApiResult<String> {
    env.var(key)
        .map(|v| v.to_string())
        .map_err(|_| ApiError::Internal(format!("missing required variable {key}")))
}

/// Read a required secret.
pub fn secret(env: &Env, key: &'static str) -> ApiResult<String> {
    env.secret(key)
        .map(|v| v.to_string())
        .map_err(|_| ApiError::Internal(format!("missing required secret {key}")))
}
