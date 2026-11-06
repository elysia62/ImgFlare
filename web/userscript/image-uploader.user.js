// ==UserScript==
// @name         个人图床上传助手
// @namespace    imgflare
// @version      2.0.2
// @description  在网页 Ctrl+V 粘贴图片，自动上传并插入前后换行的 Markdown，每张图片独占一行。支持 SHA-256 去重、批量按序插入、失败重试。
// @author       you
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // web/shared/thumbnail.ts
  var MAX_SIDE = 384;
  async function makeThumbnail(source) {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
    let bitmap;
    try {
      bitmap = await createImageBitmap(source, { resizeWidth: MAX_SIDE, resizeQuality: "medium" });
      const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.78));
      if (!blob || blob.size > 256 * 1024) return null;
      const extension = blob.type === "image/webp" ? "webp" : "png";
      return new File([blob], `preview.${extension}`, { type: blob.type });
    } catch {
      return null;
    } finally {
      bitmap?.close();
    }
  }

  // web/shared/image.ts
  var IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|ico|svg|jxl|heic|heif|tiff?)$/i;
  var PASTED_IMAGE_NAME = new RegExp("^image" + IMAGE_EXT.source, "i");
  async function sha256Hex(blob) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("\u5F53\u524D\u9875\u9762\u4E0D\u662F HTTPS\uFF0C\u65E0\u6CD5\u8BA1\u7B97\u6587\u4EF6\u6821\u9A8C\u503C");
    const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function renamePastedImage(file) {
    if (file.name !== "blob" && !PASTED_IMAGE_NAME.test(file.name)) return file;
    const type = file.type.split("/")[1] || "png";
    const ext = { jpeg: "jpg", "svg+xml": "svg", "x-icon": "ico", "vnd.microsoft.icon": "ico" }[type] ?? type;
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    return new File([file], `pasted-${stamp}.${ext}`, { type: file.type });
  }

  // web/shared/api.ts
  var ApiError = class extends Error {
    constructor(code, status) {
      super(code);
      __publicField(this, "code");
      __publicField(this, "status");
      this.name = "ApiError";
      this.code = code;
      this.status = status;
    }
  };
  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isFile(value) {
    return isObject(value) && ["id", "sha256", "name", "contentType", "url", "markdown"].every((key) => typeof value[key] === "string") && typeof value.size === "number" && typeof value.createdAt === "number" && (value.thumbnailUrl === null || typeof value.thumbnailUrl === "string");
  }
  function parseUploadResult(value, status) {
    if (!isObject(value)) throw new ApiError("invalid_response", status);
    if (status < 200 || status >= 300 || value.success === false) {
      throw new ApiError(typeof value.error === "string" ? value.error : "upload_failed", status);
    }
    if (value.success !== true || typeof value.deduplicated !== "boolean" || !isFile(value.file)) {
      throw new ApiError("invalid_response", status);
    }
    return { success: true, deduplicated: value.deduplicated, file: value.file };
  }
  function parseResponse(payload, status) {
    if (!isObject(payload)) throw new ApiError("invalid_response", status);
    if (status < 200 || status >= 300 || payload.success === false) {
      throw new ApiError(typeof payload.error === "string" ? payload.error : "http_error", status);
    }
    if (payload.success !== true) throw new ApiError("invalid_response", status);
    return "data" in payload ? payload.data : payload;
  }
  function parseDuplicateResult(value) {
    if (!isObject(value) || value.success !== true || typeof value.exists !== "boolean" || (value.file == null ? value.exists : !isFile(value.file))) {
      throw new ApiError("invalid_response", 200);
    }
    return value;
  }

  // web/userscript/image-uploader.user.ts
  var API_URL = "https://img.example.com";
  var API_TOKEN = "cph_\u5728\u8FD9\u91CC\u586B\u5165\u4F60\u7684Token";
  var MAX_CONCURRENCY = 3;
  var MAX_RETRIES = 2;
  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const headers = {
        "X-API-Key": API_TOKEN,
        Accept: "application/json",
        ...options.headers
      };
      let data;
      if (options.formData) {
        data = options.formData;
      } else if (options.body !== void 0) {
        headers["Content-Type"] = "application/json";
        data = JSON.stringify(options.body);
      }
      GM_xmlhttpRequest({
        method: options.method ?? "GET",
        url: `${apiBase()}${path}`,
        headers,
        data,
        anonymous: true,
        timeout: 12e4,
        onload: (response) => {
          try {
            const payload = JSON.parse(response.responseText);
            resolve(parseResponse(payload, response.status));
          } catch (error) {
            reject(error instanceof ApiError ? error : new ApiError("invalid_response", response.status));
          }
        },
        onerror: () => reject(new Error("network_error")),
        ontimeout: () => reject(new Error("timeout"))
      });
    });
  }
  function apiBase() {
    return API_URL.trim().replace(/\/+$/, "");
  }
  function configLooksUnset() {
    const url = apiBase();
    return !url || url.includes("img.example.com") || !API_TOKEN || API_TOKEN.includes("\u5728\u8FD9\u91CC\u586B\u5165");
  }
  function isOwnPanel() {
    const raw = apiBase();
    if (!/^https?:\/\//i.test(raw)) return false;
    try {
      return new URL(raw).host === window.location.host;
    } catch {
      return false;
    }
  }
  async function uploadOne(file) {
    const sha256 = await sha256Hex(file);
    const check = parseDuplicateResult(await request("/api/upload/check", {
      method: "POST",
      body: { sha256 }
    }));
    if (check.exists && check.file) return check.file.url;
    const thumbnail = await makeThumbnail(file);
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (attempt > 0) await delay(400 * attempt);
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        if (thumbnail) form.append("thumbnail", thumbnail, thumbnail.name);
        const result = parseUploadResult(await request("/api/upload", {
          method: "POST",
          formData: form,
          headers: { "X-File-SHA256": sha256 }
        }), 200);
        return result.file.url;
      } catch (error) {
        lastError = error;
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("upload_failed");
  }
  var pending = [];
  var insertionOrder = [];
  var running = 0;
  function enqueue(files, target = null) {
    for (const file of files) {
      if (file.size === 0) continue;
      const item = { file, target, done: false };
      pending.push(item);
      insertionOrder.push(item);
    }
    pump();
  }
  function pump() {
    while (running < MAX_CONCURRENCY) {
      const item = pending.shift();
      if (!item) break;
      running += 1;
      void uploadOne(item.file).then((url) => {
        item.url = url;
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[imgflare] ${item.file.name} \u4E0A\u4F20\u5931\u8D25\uFF1A${message}`);
      }).finally(() => {
        running -= 1;
        item.done = true;
        flushInsertions();
        pump();
      });
    }
  }
  function flushInsertions() {
    while (insertionOrder[0]?.done) {
      const item = insertionOrder.shift();
      if (!item.url) continue;
      try {
        insertMarkdown(`![\u7C98\u8D34\u56FE\u7247](${item.url})`, item.target);
      } catch (error) {
        console.error("[imgflare] \u63D2\u5165\u5931\u8D25\uFF1A", error);
      }
    }
  }
  function findEditor() {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement && isTextInput(active)) {
      return active;
    }
    if (active instanceof HTMLElement && active.isContentEditable) {
      return active;
    }
    const candidates = Array.from(
      document.querySelectorAll(
        'textarea, input[type="text"], [contenteditable="true"]'
      )
    ).filter((node) => node.offsetParent !== null);
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }
  function isTextInput(input) {
    const type = input.type.toLowerCase();
    return ["text", "search", "url", "email", "tel", ""].includes(type);
  }
  function insertMarkdown(markdown, target) {
    const editor = target ?? findEditor();
    const block = `
${markdown}
`;
    if (editor instanceof HTMLTextAreaElement) {
      const start = editor.selectionStart ?? editor.value.length;
      const end = editor.selectionEnd ?? start;
      const before = editor.value.slice(0, start);
      const after = editor.value.slice(end);
      const prefix = before.endsWith("\n") ? "" : "\n";
      const followingBreak = after.match(/^\r?\n/)?.[0] ?? "";
      const suffix = followingBreak ? "" : "\n";
      const inserted = `${prefix}${markdown}${suffix}`;
      editor.value = before + inserted + after;
      const caret = start + inserted.length + followingBreak.length;
      editor.setSelectionRange(caret, caret);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (editor && editor.isContentEditable) {
      editor.focus();
      document.execCommand("insertText", false, block);
    }
    void copyToClipboard(block);
  }
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
    }
  }
  function imagesFromClipboard(event) {
    const data = event.clipboardData;
    if (!data) return [];
    const out = [];
    for (const file of Array.from(data.files ?? [])) {
      if (looksLikeImage(file)) out.push(file);
    }
    if (out.length === 0) {
      for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file && looksLikeImage(file)) out.push(file);
      }
    }
    return out;
  }
  function looksLikeImage(file) {
    if (file.size === 0) return false;
    if (file.type.startsWith("image/")) return true;
    return !file.type && IMAGE_EXT.test(file.name);
  }
  function installHandlers() {
    document.addEventListener(
      "paste",
      (event) => {
        const files = imagesFromClipboard(event).map(renamePastedImage);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        enqueue(files, findEditor());
      },
      true
    );
  }
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function boot() {
    if (window.top !== window.self) return;
    if (configLooksUnset()) {
      console.error(
        "[imgflare] \u8FD8\u6CA1\u914D\u7F6E\uFF1A\u8BF7\u6253\u5F00\u811A\u672C\uFF0C\u628A\u9876\u90E8\u7684 API_URL \u548C API_TOKEN \u6539\u6210\u4F60\u81EA\u5DF1\u7684\u503C\u3002"
      );
      return;
    }
    if (!/^https?:\/\//i.test(apiBase())) {
      console.error(
        `[imgflare] API_URL \u5FC5\u987B\u4EE5 https:// \u5F00\u5934\uFF0C\u73B0\u5728\u662F\u300C${apiBase()}\u300D\uFF0C\u7C98\u8D34\u4E0D\u4F1A\u4E0A\u4F20\u3002`
      );
      return;
    }
    if (isOwnPanel()) return;
    installHandlers();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
