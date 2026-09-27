//! Configuration read from the Worker environment.
//!
//! Defaults that are the same for every install are in code.
//! Account values — Turnstile, admin login, and the R2 access key — are typed
//! on Cloudflare's create-project page and are not in git.

use crate::error::{ApiError, ApiResult};
use worker::Env;

/// Single upload cap. 50 MiB. Not a Cloudflare variable.
pub const MAX_UPLOAD_SIZE: usize = 52_428_800;

/// Session cookie lifetime. 7 days. Not a Cloudflare variable.
pub const SESSION_TTL_SECONDS: i64 = 604_800;

/// Session cookie HMAC key. Not a Cloudflare variable.
pub const SESSION_SECRET: &str =
    "imgflare-session-7f3c9a1e6b2d48c0a5e7f91b3d6c8a0e4f2b7d9c1a6e8b0d";
#[derive(Clone)]
pub struct R2Settings {
    pub account_id: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub bucket: String,
}

/// Everything the handlers need, resolved once per request.
#[derive(Clone)]
pub struct Config {
    pub turnstile_site_key: String,
    pub r2: R2Settings,
}

impl Config {
    pub fn from_env(env: &Env) -> ApiResult<Self> {
        let turnstile_site_key = required(env, "TURNSTILE_SITE_KEY")?;
        if turnstile_site_key.starts_with("YOUR_") {
            return Err(ApiError::Internal(
                "TURNSTILE_SITE_KEY is still a placeholder; set the Site Key from your Turnstile widget"
                    .into(),
            ));
        }

        let r2 = R2Settings {
            account_id: required(env, "R2_ACCOUNT_ID")?,
            access_key_id: required(env, "R2_ACCESS_KEY_ID")?,
            secret_access_key: required(env, "R2_SECRET_ACCESS_KEY")?,
            bucket: bucket_name(env, "R2_BUCKET")?,
        };

        Ok(Self {
            turnstile_site_key,
            r2,
        })
    }
}

/// Public URL for a stored image. `origin` is the address the request came in on.
pub fn public_url(origin: &str, r2_key: &str) -> String {
    format!("{}/{}", origin.trim_end_matches('/'), r2_key)
}

/// Read a required string. Dashboard variables and secrets are both strings.
pub fn var(env: &Env, key: &'static str) -> ApiResult<String> {
    env.var(key)
        .map(|v| v.to_string())
        .map_err(|_| ApiError::Internal(format!("missing required variable {key}")))
}

/// Read a required secret. Same storage as a variable; the name marks it as one.
pub fn secret(env: &Env, key: &'static str) -> ApiResult<String> {
    env.secret(key)
        .map(|v| v.to_string())
        .map_err(|_| ApiError::Internal(format!("missing required secret {key}")))
}

fn required(env: &Env, key: &'static str) -> ApiResult<String> {
    let value = var(env, key)?;
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with("YOUR_") {
        return Err(ApiError::Internal(format!("{key} is not set")));
    }
    Ok(trimmed.to_string())
}

fn bucket_name(env: &Env, key: &'static str) -> ApiResult<String> {
    let name = required(env, key)?;
    let ok = name.len() >= 3
        && name.len() <= 63
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && !name.ends_with('-');
    if !ok {
        return Err(ApiError::Internal(format!(
            "{key} must be an R2 bucket name"
        )));
    }
    Ok(name)
}
