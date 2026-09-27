// ==UserScript==
// @name         个人图床上传助手
// @namespace    https://panel.example.com/
// @version      1.0.0
// @description  在任意网页通过 Ctrl+V、拖拽或文件选择，把图片和文件上传到自建图床。支持 SHA-256 去重、批量上传、自动重试，并自动插入 Markdown。
// @author       you
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      panel.example.com
// @run-at       document-idle
// ==/UserScript==

"use strict";
(() => {
  // userscript/image-uploader.user.ts
  var SETTINGS_KEY = "pih_settings";
  var MAX_CONCURRENCY = 3;
  var MAX_RETRIES = 2;
  function loadSettings() {
    const stored = GM_getValue(SETTINGS_KEY, {});
    return {
      apiUrl: (stored?.apiUrl ?? "").replace(/\/+$/, ""),
      token: stored?.token ?? ""
    };
  }
  function saveSettings(settings) {
    GM_setValue(SETTINGS_KEY, settings);
  }
  function request(settings, path, options = {}) {
    return new Promise((resolve, reject) => {
      const headers = {
        "X-API-Key": settings.token,
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
        url: `${settings.apiUrl}${path}`,
        headers,
        data,
        timeout: 12e4,
        onload: (response) => {
          let payload = null;
          try {
            payload = JSON.parse(response.responseText);
          } catch {
            payload = null;
          }
          if (response.status >= 200 && response.status < 300 && payload?.success !== false) {
            resolve(payload?.data ?? payload);
            return;
          }
          reject(new Error(payload?.error ?? `http_${response.status}`));
        },
        onerror: () => reject(new Error("network_error")),
        ontimeout: () => reject(new Error("timeout"))
      });
    });
  }
  async function sha256Hex(blob) {
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const bytes = new Uint8Array(digest);
    let out = "";
    for (const byte of bytes) {
      out += byte.toString(16).padStart(2, "0");
    }
    return out;
  }
  var tasks = [];
  var running = 0;
  var counter = 0;
  function enqueue(files) {
    for (const file of files) {
      if (file.size === 0) continue;
      counter += 1;
      tasks.push({
        key: `t${counter}`,
        file,
        state: "pending"
      });
    }
    renderQueue();
    pump();
  }
  function pump() {
    while (running < MAX_CONCURRENCY) {
      const task = tasks.find((t) => t.state === "pending");
      if (!task) break;
      running += 1;
      void process(task).finally(() => {
        running -= 1;
        pump();
      });
    }
  }
  async function process(task) {
    const settings = loadSettings();
    if (!settings.apiUrl || !settings.token) {
      task.state = "failed";
      task.error = "\u8BF7\u5148\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199 API \u5730\u5740\u548C Token";
      renderQueue();
      return;
    }
    try {
      task.state = "hashing";
      renderQueue();
      const sha256 = await sha256Hex(task.file);
      task.state = "checking";
      renderQueue();
      const check = await request(settings, "/api/upload/check", {
        method: "POST",
        body: { sha256, size: task.file.size }
      });
      if (check.exists && check.file) {
        task.state = "duplicate";
        task.result = { success: true, deduplicated: true, file: check.file };
        renderQueue();
        insertMarkdown(check.file.markdown, settings);
        return;
      }
      let lastError = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        task.state = "uploading";
        renderQueue();
        try {
          const form = new FormData();
          form.append("file", task.file, task.file.name);
          const result = await request(settings, "/api/upload", {
            method: "POST",
            formData: form,
            headers: { "X-File-SHA256": sha256 }
          });
          task.state = "success";
          task.result = result;
          renderQueue();
          insertMarkdown(result.file.markdown, settings);
          return;
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : "upload_failed";
          if (/^(unauthorized|token_revoked|invalid_sha256|file_too_large|unsupported_file_type|missing_file|expected_multipart)/.test(message)) {
            break;
          }
          if (attempt < MAX_RETRIES) {
            await delay(400 * (attempt + 1));
          }
        }
      }
      task.state = "failed";
      task.error = lastError instanceof Error ? lastError.message : "upload_failed";
      renderQueue();
    } catch (error) {
      task.state = "failed";
      task.error = error instanceof Error ? error.message : "unknown_error";
      renderQueue();
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
      document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')
    ).filter((node) => node.offsetParent !== null);
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }
  function isTextInput(input) {
    const type = input.type.toLowerCase();
    return ["text", "search", "url", "email", "tel", ""].includes(type);
  }
  function insertMarkdown(markdown, settings) {
    const editor = findEditor();
    if (!editor) {
      void copyToClipboard(markdown);
      notify(`\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F\uFF1A${markdown}`, "ok");
      return;
    }
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const start = editor.selectionStart ?? editor.value.length;
      const end = editor.selectionEnd ?? start;
      const before = editor.value.slice(0, start);
      const after = editor.value.slice(end);
      const prefix = before.length > 0 && !/\s$/.test(before) ? " " : "";
      const suffix = after.length > 0 && !/^\s/.test(after) ? " " : "";
      const inserted = `${prefix}${markdown}${suffix}`;
      editor.value = before + inserted + after;
      const caret = start + inserted.length;
      editor.setSelectionRange(caret, caret);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (editor.isContentEditable) {
      editor.focus();
      document.execCommand("insertText", false, markdown);
    }
    notify("\u5DF2\u63D2\u5165 Markdown", "ok");
    void copyToClipboard(markdown);
    void settings;
  }
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
    }
  }
  var PANEL_ID = "pih-panel";
  function notify(message, kind = "info") {
    const node = document.createElement("div");
    node.className = `pih-toast pih-toast-${kind}`;
    node.textContent = message;
    panel().appendChild(node);
    window.setTimeout(() => node.remove(), 3200);
  }
  function panel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) return existing;
    const root = document.createElement("div");
    root.id = PANEL_ID;
    const toggle = document.createElement("button");
    toggle.className = "pih-toggle";
    toggle.type = "button";
    toggle.title = "\u4E2A\u4EBA\u56FE\u5E8A\u4E0A\u4F20\u52A9\u624B";
    toggle.textContent = "\u2191";
    toggle.addEventListener("click", () => {
      root.classList.toggle("pih-open");
      renderQueue();
    });
    const body = document.createElement("div");
    body.className = "pih-body";
    const head = document.createElement("div");
    head.className = "pih-head";
    head.textContent = "\u4E2A\u4EBA\u56FE\u5E8A\u4E0A\u4F20\u52A9\u624B";
    const actions = document.createElement("div");
    actions.className = "pih-actions";
    const pick = document.createElement("button");
    pick.className = "pih-btn";
    pick.type = "button";
    pick.textContent = "\u9009\u62E9\u6587\u4EF6";
    pick.addEventListener("click", () => pickFiles());
    const settingsButton = document.createElement("button");
    settingsButton.className = "pih-btn pih-btn-ghost";
    settingsButton.type = "button";
    settingsButton.textContent = "\u8BBE\u7F6E";
    settingsButton.addEventListener("click", () => openSettings());
    const clear = document.createElement("button");
    clear.className = "pih-btn pih-btn-ghost";
    clear.type = "button";
    clear.textContent = "\u6E05\u7A7A";
    clear.addEventListener("click", () => {
      for (let i = tasks.length - 1; i >= 0; i -= 1) {
        const task = tasks[i];
        if (task.state !== "pending" && task.state !== "uploading") tasks.splice(i, 1);
      }
      renderQueue();
    });
    actions.append(pick, settingsButton, clear);
    const hint = document.createElement("p");
    hint.className = "pih-hint";
    hint.textContent = "Ctrl+V \u7C98\u8D34\u56FE\u7247 \xB7 \u62D6\u62FD\u6587\u4EF6\u5230\u9875\u9762 \xB7 \u652F\u6301\u6279\u91CF";
    const queue = document.createElement("div");
    queue.className = "pih-queue";
    queue.id = "pih-queue";
    body.append(head, actions, hint, queue);
    root.append(toggle, body);
    document.body.appendChild(root);
    installDropHandlers(root);
    return root;
  }
  function renderQueue() {
    const queue = document.getElementById("pih-queue");
    if (!queue) return;
    queue.replaceChildren(
      ...tasks.map((task) => {
        const row = document.createElement("div");
        row.className = `pih-row pih-state-${task.state}`;
        const name = document.createElement("span");
        name.className = "pih-name";
        name.title = task.file.name;
        name.textContent = task.file.name;
        const status = document.createElement("span");
        status.className = "pih-status";
        status.textContent = describe(task);
        row.append(name, status);
        if (task.state === "success" || task.state === "duplicate") {
          const link = document.createElement("a");
          link.href = task.result?.file.url ?? "#";
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.className = "pih-link";
          link.textContent = "\u6253\u5F00";
          link.addEventListener("click", (event) => event.stopPropagation());
          row.append(link);
        }
        if (task.state === "failed") {
          const retry = document.createElement("button");
          retry.className = "pih-btn pih-btn-ghost pih-retry";
          retry.type = "button";
          retry.textContent = "\u91CD\u8BD5";
          retry.addEventListener("click", () => {
            task.state = "pending";
            task.error = void 0;
            renderQueue();
            pump();
          });
          row.append(retry);
        }
        return row;
      })
    );
  }
  function describe(task) {
    switch (task.state) {
      case "pending":
        return "\u7B49\u5F85\u4E2D";
      case "hashing":
        return "\u8BA1\u7B97 Hash\u2026";
      case "checking":
        return "\u68C0\u67E5\u91CD\u590D\u2026";
      case "duplicate":
        return "\u5DF2\u5B58\u5728\uFF0C\u8DF3\u8FC7\u4E0A\u4F20";
      case "uploading":
        return "\u4E0A\u4F20\u4E2D\u2026";
      case "success":
        return "\u4E0A\u4F20\u6210\u529F";
      case "failed":
        return `\u5931\u8D25\uFF1A${task.error ?? "\u672A\u77E5\u9519\u8BEF"}`;
      default:
        return "";
    }
  }
  var dropInstalled = false;
  function installDropHandlers(root) {
    if (dropInstalled) return;
    dropInstalled = true;
    document.addEventListener("paste", (event) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(renamePasted(file));
      }
      if (files.length > 0) {
        event.preventDefault();
        root.classList.add("pih-open");
        enqueue(files);
      }
    });
    for (const type of ["dragenter", "dragover"]) {
      document.addEventListener(type, (event) => {
        event.preventDefault();
        root.classList.add("pih-dragging");
        root.classList.add("pih-open");
      });
    }
    for (const type of ["dragleave", "dragend"]) {
      document.addEventListener(type, () => root.classList.remove("pih-dragging"));
    }
    document.addEventListener("drop", (event) => {
      event.preventDefault();
      root.classList.remove("pih-dragging");
      const files = event.dataTransfer?.files;
      if (files && files.length > 0) {
        root.classList.add("pih-open");
        enqueue(Array.from(files));
      }
    });
  }
  function pickFiles() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      if (input.files && input.files.length > 0) {
        enqueue(Array.from(input.files));
      }
      input.remove();
    });
    input.click();
  }
  function renamePasted(file) {
    if (/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name) || file.name === "blob") {
      const ext = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
      const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
      return new File([file], `pasted-${stamp}.${ext}`, { type: file.type });
    }
    return file;
  }
  function openSettings() {
    const current = loadSettings();
    const url = window.prompt(
      "API \u5730\u5740\uFF08\u4F8B\u5982 https://panel.example.com\uFF09\n\n\u5728\u540E\u53F0\u300CAPI Token\u300D\u9875\u9762\u751F\u6210 Token \u540E\u586B\u5165\u4E0B\u4E00\u6B65\u3002",
      current.apiUrl
    );
    if (url === null) return;
    const token = window.prompt("API Token\uFF08cph_ \u5F00\u5934\uFF09", current.token);
    if (token === null) return;
    saveSettings({
      apiUrl: url.trim().replace(/\/+$/, ""),
      token: token.trim()
    });
    notify("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58", "ok");
  }
  var STYLE = `
#${PANEL_ID} {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif;
  color: #1b1f27;
}
#${PANEL_ID} .pih-toggle {
  width: 44px; height: 44px; border-radius: 50%;
  border: 1px solid #c6ccd8; background: #fff; color: #1b1f27;
  font-size: 18px; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.18);
  display: block; margin-left: auto;
}
#${PANEL_ID} .pih-body {
  display: none; margin-top: 10px; width: 320px; max-width: calc(100vw - 36px);
  background: #fff; border: 1px solid #dfe3ea; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.2); padding: 12px; max-height: 60vh; overflow: auto;
}
#${PANEL_ID}.pih-open .pih-body { display: block; }
#${PANEL_ID}.pih-dragging .pih-body { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.25); }
#${PANEL_ID} .pih-head { font-weight: 650; margin-bottom: 8px; }
#${PANEL_ID} .pih-actions { display: flex; gap: 6px; flex-wrap: wrap; }
#${PANEL_ID} .pih-btn {
  padding: 5px 10px; font-size: 12.5px; border-radius: 6px; cursor: pointer;
  border: 1px solid #c6ccd8; background: #fff; color: #1b1f27;
}
#${PANEL_ID} .pih-btn:hover { background: #f2f4f8; }
#${PANEL_ID} .pih-btn-ghost { border-color: transparent; color: #6b7280; }
#${PANEL_ID} .pih-hint { margin: 8px 0; font-size: 11.5px; color: #9aa1ae; }
#${PANEL_ID} .pih-queue { display: flex; flex-direction: column; gap: 5px; }
#${PANEL_ID} .pih-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
#${PANEL_ID} .pih-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#${PANEL_ID} .pih-status { font-size: 11.5px; color: #6b7280; white-space: nowrap; }
#${PANEL_ID} .pih-state-success .pih-status,
#${PANEL_ID} .pih-state-duplicate .pih-status { color: #15803d; }
#${PANEL_ID} .pih-state-failed .pih-status { color: #b91c1c; }
#${PANEL_ID} .pih-link { font-size: 11.5px; color: #2563eb; }
#${PANEL_ID} .pih-toast {
  margin-top: 6px; padding: 6px 9px; border-radius: 6px; font-size: 12px;
  background: #1b1f27; color: #fff; word-break: break-all;
}
#${PANEL_ID} .pih-toast-ok { background: #15803d; }
#${PANEL_ID} .pih-toast-error { background: #b91c1c; }

@media (prefers-color-scheme: dark) {
  #${PANEL_ID} { color: #e8eaee; }
  #${PANEL_ID} .pih-toggle,
  #${PANEL_ID} .pih-body,
  #${PANEL_ID} .pih-btn { background: #1c1f26; color: #e8eaee; border-color: #3a4150; }
  #${PANEL_ID} .pih-btn:hover { background: #262a33; }
}
`;
  function injectStyle() {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function boot() {
    if (window.top !== window.self) return;
    injectStyle();
    panel();
    GM_registerMenuCommand("\u4E0A\u4F20\u8BBE\u7F6E", () => openSettings());
    GM_registerMenuCommand("\u6253\u5F00\u4E0A\u4F20\u9762\u677F", () => {
      panel().classList.add("pih-open");
      renderQueue();
    });
    const settings = loadSettings();
    if (!settings.apiUrl || !settings.token) {
      notify("\u8BF7\u5148\u70B9\u51FB\u300C\u8BBE\u7F6E\u300D\u586B\u5199 API \u5730\u5740\u548C Token", "info");
      panel().classList.add("pih-open");
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
