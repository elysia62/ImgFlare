//! Error handling.
//!
//! Every error that can escape a handler is an [`ApiError`], which knows how to
//! render itself as a JSON body plus a correct HTTP status code. Nothing in this
//! crate returns HTTP 200 for a failure.

use worker::Response;

/// The single error type used across the API surface.
#[derive(Debug)]
pub enum ApiError {
    /// 400 — the request was malformed or a field was missing/invalid.
    BadRequest(&'static str),
    /// 401 — no valid session and no valid API token.
    Unauthorized,
    /// 403 — authenticated but not allowed (bad Origin, missing session, ...).
    Forbidden(&'static str),
    /// 404 — the resource does not exist.
    NotFound(&'static str),
    /// 413 — payload too large.
    PayloadTooLarge,
    /// 415 — unsupported media type / file extension.
    UnsupportedMediaType(&'static str),
    /// 429 — rate limited.
    TooManyRequests(&'static str),
    /// 500 — anything unexpected. The message is logged, never returned verbatim
    /// if it might contain sensitive data.
    Internal(String),
}

impl ApiError {
    /// The HTTP status code for this error.
    pub fn status(&self) -> u16 {
        match self {
            ApiError::BadRequest(_) => 400,
            ApiError::Unauthorized => 401,
            ApiError::Forbidden(_) => 403,
            ApiError::NotFound(_) => 404,
            ApiError::PayloadTooLarge => 413,
            ApiError::UnsupportedMediaType(_) => 415,
            ApiError::TooManyRequests(_) => 429,
            ApiError::Internal(_) => 500,
        }
    }

    /// The stable, machine-readable error code returned to clients.
    pub fn code(&self) -> &str {
        match self {
            ApiError::BadRequest(m) => m,
            ApiError::Unauthorized => "unauthorized",
            ApiError::Forbidden(m) => m,
            ApiError::NotFound(m) => m,
            ApiError::PayloadTooLarge => "file_too_large",
            ApiError::UnsupportedMediaType(m) => m,
            ApiError::TooManyRequests(m) => m,
            ApiError::Internal(_) => "internal_error",
        }
    }

    /// Turn this error into an HTTP response.
    ///
    /// The response body always follows the documented shape:
    ///
    /// ```json
    /// { "success": false, "error": "unauthorized" }
    /// ```
    pub fn to_response(&self) -> Response {
        // Internal errors are logged with detail but reported generically.
        if let ApiError::Internal(detail) = self {
            worker::console_error!("internal error: {detail}");
        }

        let body = serde_json::json!({
            "success": false,
            "error": self.code(),
        });

        Response::from_json(&body)
            .unwrap_or_else(|_| Response::error("internal_error", 500).unwrap())
            .with_status(self.status())
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `Internal` carries a diagnostic string that never reaches the client;
        // including it here is what makes server-side logs actionable.
        match self {
            ApiError::Internal(detail) => write!(f, "internal_error (500): {detail}"),
            other => write!(f, "{} ({})", other.code(), other.status()),
        }
    }
}

impl std::error::Error for ApiError {}

/// Worker errors (bindings missing, JSON failures, R2/D1 trouble) become a 500.
impl From<worker::Error> for ApiError {
    fn from(err: worker::Error) -> Self {
        ApiError::Internal(err.to_string())
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

impl From<worker::wasm_bindgen::JsValue> for ApiError {
    fn from(err: worker::wasm_bindgen::JsValue) -> Self {
        Self::Internal(format!("runtime operation failed: {err:?}"))
    }
}
