import { IMAGE_EXT, renamePastedImage, sha256Hex } from '../shared/image.js';
import type { ApiResponse, DuplicateCheckResult, UploadResult } from '../frontend/src/types.js';

/** Paste images to upload with API_TOKEN and insert Markdown. */

/* 油猴 API 的最小类型声明                                                    */

interface GmResponse {
  status: number;
  responseText: string;
}

interface GmRequestDetails {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string | FormData;
  timeout?: number;
  /**
   * 不发送目标站点的 cookie。
   *
   * 这里只用 `X-API-Key` 认证，不依赖面板登录。即使扩展意外附带 cookie，
   * 服务端也优先验证显式 Key，并按上传权限处理。
   */
  anonymous?: boolean;
  onload?: (response: GmResponse) => void;
  onerror?: (error: unknown) => void;
  ontimeout?: () => void;
}

declare function GM_xmlhttpRequest(details: GmRequestDetails): void;

/* 配置                                                                       */

/** 图床地址（含 https://）和后台生成的 API Token。 */
const API_URL = 'https://img.example.com';

/** 后台「API Token」页生成，只显示一次，形如 cph_xxxxxxxx。 */
const API_TOKEN = 'cph_在这里填入你的Token';

/** 同时上传几个文件。 */
const MAX_CONCURRENCY = 3;

/** 失败重试次数（不含首次）。 */
const MAX_RETRIES = 2;

/** 统一的 JSON 请求；失败时抛出带错误码的 `Error`。 */
function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    formData?: FormData;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const headers: Record<string, string> = {
      'X-API-Key': API_TOKEN,
      Accept: 'application/json',
      ...options.headers,
    };

    let data: string | FormData | undefined;
    if (options.formData) {
      data = options.formData;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      data = JSON.stringify(options.body);
    }

    GM_xmlhttpRequest({
      method: options.method ?? 'GET',
      url: `${apiBase()}${path}`,
      headers,
      data,
      anonymous: true,
      timeout: 120_000,
      onload: (response) => {
        let payload: ApiResponse<T> | null = null;
        try {
          payload = JSON.parse(response.responseText) as ApiResponse<T>;
        } catch {
          payload = null;
        }

        if (response.status >= 200 && response.status < 300 && payload?.success !== false) {
          resolve((payload?.data ?? payload) as T);
          return;
        }
        reject(new Error(payload?.error ?? `http_${response.status}`));
      },
      onerror: () => reject(new Error('network_error')),
      ontimeout: () => reject(new Error('timeout')),
    });
  });
}

/** 去掉结尾多余的斜杠。 */
function apiBase(): string {
  return API_URL.trim().replace(/\/+$/, '');
}

/** 配置是否还是占位值。 */
function configLooksUnset(): boolean {
  const url = apiBase();
  return (
    !url ||
    url.includes('img.example.com') ||
    !API_TOKEN ||
    API_TOKEN.includes('在这里填入')
  );
}

/** Avoid duplicate uploads on the image-host panel. */
function isOwnPanel(): boolean {
  const raw = apiBase();
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    return new URL(raw).host === window.location.host;
  } catch {
    return false;
  }
}

/* 上传                                                                       */

/**
 * 上传一个文件，返回图片地址。
 *
 * 先按 SHA-256 查重；已存在就直接复用，不重复占用空间。
 */
async function uploadOne(file: File): Promise<string> {
  const sha256 = await sha256Hex(file);

  const check = await request<DuplicateCheckResult>('/api/upload/check', {
    method: 'POST',
    body: { sha256 },
  });
  if (check.exists && check.file) return check.file.url;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) await delay(400 * attempt);
    try {
      const form = new FormData();
      form.append('file', file, file.name);

      const result = await request<UploadResult>('/api/upload', {
        method: 'POST',
        formData: form,
        headers: { 'X-File-SHA256': sha256 },
      });
      return result.file.url;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : 'upload_failed';
      // 这些错误重试也没有意义，直接放弃。
      if (
        /^(unauthorized|invalid_sha256|checksum_mismatch|file_too_large|unsupported_file_type|missing_file|expected_multipart)/.test(
          message,
        )
      ) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('upload_failed');
}

/* 队列：同一时间最多上传 MAX_CONCURRENCY 个                                  */

const pending: { file: File; target: HTMLElement | null }[] = [];
let running = 0;

/**
 * 排队上传。
 *
 * `target` 是粘贴发生时用户正在编辑的元素：上传要花时间，等结果回来再去找
 * `document.activeElement` 可能已经指向别处了，所以在这里先记下来。
 */
function enqueue(files: File[], target: HTMLElement | null = null): void {
  for (const file of files) {
    if (file.size === 0) continue;
    pending.push({ file, target });
  }
  pump();
}

function pump(): void {
  while (running < MAX_CONCURRENCY) {
    const item = pending.shift();
    if (!item) break;
    running += 1;

    void uploadOne(item.file)
      .then((url) => {
        insertMarkdown(`![粘贴图片](${url})`, item.target);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[imgflare] ${item.file.name} 上传失败：${message}`);
      })
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

/* 把 Markdown 插入当前编辑位置                                               */

/**
 * 找到用户正在编辑的元素。
 *
 * 优先用 `document.activeElement`，否则退回到页面上最后一个可见的编辑区域。
 * 都找不到时只放进剪贴板，不强行插入。
 */
function findEditor(): HTMLTextAreaElement | HTMLInputElement | HTMLElement | null {
  const active = document.activeElement;

  if (
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && isTextInput(active))
  ) {
    return active;
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    return active;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'textarea, input[type="text"], [contenteditable="true"]',
    ),
  ).filter((node) => node.offsetParent !== null);

  return candidates.length > 0 ? (candidates[candidates.length - 1] as HTMLElement) : null;
}

function isTextInput(input: HTMLInputElement): boolean {
  const type = input.type.toLowerCase();
  return ['text', 'search', 'url', 'email', 'tel', ''].includes(type);
}

function insertMarkdown(markdown: string, target: HTMLElement | null): void {
  const editor = target ?? findEditor();

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;
    const before = editor.value.slice(0, start);
    const after = editor.value.slice(end);
    // 前后补空格，避免粘进已有文字中间。
    const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const suffix = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
    const inserted = `${prefix}${markdown}${suffix}`;

    editor.value = before + inserted + after;
    const caret = start + inserted.length;
    editor.setSelectionRange(caret, caret);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (editor && editor.isContentEditable) {
    editor.focus();
    document.execCommand('insertText', false, markdown);
  }

  // 无论插没插进去，都留在剪贴板里，方便手动粘贴到别处。
  void copyToClipboard(markdown);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板权限被拒绝时静默忽略。
  }
}

/* 粘贴                                                                       */

/** System file copies and browser image copies expose different clipboard fields. */
function imagesFromClipboard(event: ClipboardEvent): File[] {
  const data = event.clipboardData;
  if (!data) return [];

  const out: File[] = [];

  for (const file of Array.from(data.files ?? [])) {
    if (looksLikeImage(file)) out.push(file);
  }

  if (out.length === 0) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file && looksLikeImage(file)) out.push(file);
    }
  }

  return out;
}

/** Accept clipboard MIME types, falling back to filename extensions. */
function looksLikeImage(file: File): boolean {
  if (file.size === 0) return false;
  if (file.type.startsWith('image/')) return true;
  // 少数环境给出空 MIME，退回扩展名判断。
  return !file.type && IMAGE_EXT.test(file.name);
}

function installHandlers(): void {
  document.addEventListener(
    'paste',
    (event) => {
      const files = imagesFromClipboard(event).map(renamePastedImage);
      if (files.length === 0) return;

      // 只在这时候才拦截，避免影响正常的文字粘贴。
      event.preventDefault();
      event.stopPropagation();

      // 记下此刻的编辑目标；上传完成后焦点可能已经变了。
      enqueue(files, findEditor());
    },
    true,
  );

}

/* 启动                                                                       */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boot(): void {
  // 不在 iframe 里运行，避免同一张图被多个文档同时接管粘贴。
  if (window.top !== window.self) return;

  if (configLooksUnset()) {
    console.error(
      '[imgflare] 还没配置：请打开脚本，把顶部的 API_URL 和 API_TOKEN 改成你自己的值。',
    );
    return;
  }

  if (!/^https?:\/\//i.test(apiBase())) {
    console.error(
      `[imgflare] API_URL 必须以 https:// 开头，现在是「${apiBase()}」，粘贴不会上传。`,
    );
    return;
  }

  // 自己的图床有完整的后台上传界面，这里让位，否则粘贴会被上传两次。
  if (isOwnPanel()) return;

  installHandlers();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
