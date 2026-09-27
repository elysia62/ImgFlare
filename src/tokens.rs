//! API token management: `GET/POST /api/tokens`, `DELETE /api/tokens/:id`.
//!
//! Admin-session only. The plaintext token is returned exactly once, at creation
//! time, and never again — only its SHA-256 is stored.

use crate::auth::{generate_api_token, is_plausible_token};
use crate::db::{Db, TokenRecord};
use crate::error::{ApiError, ApiResult};
use crate::utils::{now_ms, random_token};
use serde::{Deserialize, Serialize};

/// A token as shown in the admin list. Never carries the plaintext.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub id: String,
    pub name: String,
    /// A short, non-reversible fingerprint so tokens are distinguishable in a
    /// list without revealing anything useful.
    pub prefix: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub revoked: bool,
}

#[derive(Deserialize)]
pub struct CreateTokenRequest {
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedToken {
    pub id: String,
    pub name: String,
    /// Shown once and never retrievable again.
    pub token: String,
    pub created_at: i64,
}

pub async fn handle_list(db: &Db) -> ApiResult<Vec<TokenInfo>> {
    let rows = db.list_tokens().await?;
    Ok(rows.iter().map(token_info).collect())
}

/// Mint a new token.
pub async fn handle_create(db: &Db, body: CreateTokenRequest) -> ApiResult<CreatedToken> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name_required"));
    }
    if name.chars().count() > 64 {
        return Err(ApiError::BadRequest("name_too_long"));
    }

    let new = generate_api_token();
    debug_assert!(is_plausible_token(&new.plaintext));

    let record = TokenRecord {
        id: random_token(22),
        name: name.to_string(),
        token_hash: new.hash,
        created_at: now_ms(),
        last_used_at: None,
        revoked_at: None,
    };

    db.insert_token(&record).await?;

    Ok(CreatedToken {
        id: record.id,
        name: record.name,
        token: new.plaintext,
        created_at: record.created_at,
    })
}

/// Revoke a token. Revocation is one-way.
pub async fn handle_revoke(db: &Db, id: &str) -> ApiResult<()> {
    let removed = db.revoke_token(id).await?;
    if removed == 0 {
        // Either it never existed, or it was already revoked.
        return Err(ApiError::NotFound("token_not_found"));
    }
    Ok(())
}

/// Permanently delete a token row (only valid once it is already revoked).
pub async fn handle_delete(db: &Db, id: &str) -> ApiResult<()> {
    let removed = db.delete_token(id).await?;
    if removed == 0 {
        return Err(ApiError::NotFound("token_not_found"));
    }
    Ok(())
}

fn token_info(record: &TokenRecord) -> TokenInfo {
    TokenInfo {
        id: record.id.clone(),
        name: record.name.clone(),
        prefix: record.token_hash.chars().take(8).collect(),
        created_at: record.created_at,
        last_used_at: record.last_used_at,
        revoked_at: record.revoked_at,
        revoked: record.revoked_at.is_some(),
    }
}
