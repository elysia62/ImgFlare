//! Keep multipart files in the runtime, outside Wasm linear memory.
use crate::error::{ApiError, ApiResult};
use worker::{
    js_sys,
    wasm_bindgen::{JsCast, JsValue},
    wasm_bindgen_futures::JsFuture,
    web_sys,
};

pub async fn form(req: &worker::Request) -> ApiResult<web_sys::FormData> {
    let value = JsFuture::from(req.inner().form_data()?)
        .await
        .map_err(|_| ApiError::BadRequest("invalid_multipart"))?;
    value
        .dyn_into()
        .map_err(|_| ApiError::BadRequest("invalid_multipart"))
}

pub fn file(form: &web_sys::FormData, field: &str) -> ApiResult<web_sys::File> {
    let value = form.get(field);
    if value.is_null() {
        return Err(ApiError::BadRequest("missing_file"));
    }
    value
        .dyn_into()
        .map_err(|_| ApiError::BadRequest("file_must_be_a_file"))
}

pub async fn prefix(file: &web_sys::File) -> ApiResult<Vec<u8>> {
    let blob = file.slice_with_f64_and_f64(0.0, 65536.0)?;
    let value = JsFuture::from(blob.array_buffer()).await?;
    Ok(js_sys::Uint8Array::new(&value).to_vec())
}

pub async fn digest(file: &web_sys::File) -> ApiResult<[u8; 32]> {
    // Cloudflare DigestStream hashes incrementally without retaining the file.
    let crypto = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("crypto"))?;
    let constructor: js_sys::Function =
        js_sys::Reflect::get(&crypto, &JsValue::from_str("DigestStream"))?.dyn_into()?;
    let stream = js_sys::Reflect::construct(
        &constructor,
        &js_sys::Array::of1(&JsValue::from_str("SHA-256")),
    )?;
    let writable: web_sys::WritableStream = stream.clone().unchecked_into();
    JsFuture::from(file.stream().pipe_to(&writable)).await?;
    let promise: js_sys::Promise =
        js_sys::Reflect::get(&stream, &JsValue::from_str("digest"))?.dyn_into()?;
    let hash = JsFuture::from(promise).await?;
    let bytes = js_sys::Uint8Array::new(&hash).to_vec();
    bytes
        .try_into()
        .map_err(|_| ApiError::Internal("invalid SHA-256 digest".into()))
}
