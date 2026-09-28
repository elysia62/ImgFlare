/**
 * 个人图床上传助手 — Tampermonkey / Violentmonkey 用户脚本
 *
 * ---------------------------------------------------------------------------
 * 手动配置：只改下面两行，保存即可。
 * ---------------------------------------------------------------------------
 *   API_URL   你的图床地址，例如 https://img.example.com
 *   API_TOKEN 后台「API Token」页生成的、cph_ 开头的 Token
 *
 * 用法：在任意网页 Ctrl+V 粘贴图片，或把图片直接拖进页面。
 * 上传完成后 Markdown 会插入当前光标处，同时留在剪贴板里。
 *
 * 设计取舍：
 *   - 没有悬浮按钮、没有面板、没有提示框；出错只写 `console`。
 *   - 在你自己的图床域名下完全不运行：后台面板本身就支持粘贴上传，
 *     两边都拦截的话同一张图会被上传两次。
 *   - 只在最外层文档运行，不在 iframe 里重复接管粘贴事件。
 *
 * 这个文件是 TypeScript 源码，由 `bun run build:userscript` 编译成同目录下的
 * `image-uploader.user.js`，编译产物可以直接安装，用户无需安装 Node。
 *
 * 注意：更新脚本会覆盖你手改的配置，升级前先记下这两行的值。
 */

/* -------------------------------------------------------------------------- */
/* 油猴 API 的最小类型声明                                                    */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* 配置                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 图床地址，务必带上 `https://`。
 *
 * 手填时最容易漏掉协议头，而 `new URL('img.example.com')` 会直接抛错：
 * 脚本会把「解析不了」当成「这是自己的面板」而整个停用，表现就是粘贴没反应，
 * 所以下面 `isOwnPanel()` 对这种情况单独处理。
 */
const API_URL = 'https://img.example.com';

/** 后台「API Token」页生成，只显示一次，形如 cph_xxxxxxxx。 */
const API_TOKEN = 'cph_在这里填入你的Token';

/** 同时上传几个文件。 */
const MAX_CONCURRENCY = 3;

/** 失败重试次数（不含首次）。 */
const MAX_RETRIES = 2;

/** 扩展名白名单，和服务端接受的一致。 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|ico|svg|jxl|heic|heif|tiff?)$/i;

/* -------------------------------------------------------------------------- */
/* 接口类型                                                                   */
/* -------------------------------------------------------------------------- */

interface FileInfo {
  id: string;
  sha256: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  markdown: string;
  createdAt: number;
}

interface UploadResult {
  success: boolean;
  deduplicated: boolean;
  file: FileInfo;
}

interface CheckResult {
  success: boolean;
  exists: boolean;
  file?: FileInfo;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* 网络请求                                                                   */
/* -------------------------------------------------------------------------- */

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
        let payload: ApiEnvelope<T> | null = null;
        try {
          payload = JSON.parse(response.responseText) as ApiEnvelope<T>;
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

/**
 * 当前页面是否就是自己的图床（面板本身支持粘贴上传，两边都拦会重复上传）。
 *
 * 地址写得不合法时**不能**返回 `true`：那会让脚本静默失效，用户只会看到
 * 「粘贴没反应」。这种情况返回 `false`，让粘贴照常走上传流程，出错时至少
 * 控制台里有明确日志。
 */
function isOwnPanel(): boolean {
  const raw = apiBase();
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    return new URL(raw).host === window.location.host;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* 上传                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 计算 SHA-256。服务端用它查重并校验上传内容，所以这步不能跳过。
 *
 * `crypto.subtle` 只在安全上下文（HTTPS 或 localhost）可用；普通 HTTP 页面上
 * 它是 `undefined`，直接调用只会抛出 `undefined.digest` 这种看不懂的错误。
 */
async function sha256Hex(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      '当前页面不是 HTTPS，浏览器不提供 SHA-256（crypto.subtle），无法上传',
    );
  }

  const buffer = await blob.arrayBuffer();
  const digest = await subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 上传一个文件，返回可直接粘贴的 Markdown。
 *
 * 先按 SHA-256 查重；已存在就直接复用，不重复占用空间。
 */
async function uploadOne(file: File): Promise<string> {
  const sha256 = await sha256Hex(file);

  const check = await request<CheckResult>('/api/upload/check', {
    method: 'POST',
    body: { sha256, size: file.size },
  });
  if (check.exists && check.file) return check.file.markdown;

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
      return result.file.markdown;
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

/* -------------------------------------------------------------------------- */
/* 队列：同一时间最多上传 MAX_CONCURRENCY 个                                  */
/* -------------------------------------------------------------------------- */

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
      .then((markdown) => {
        insertMarkdown(markdown, item.target);
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

/* -------------------------------------------------------------------------- */
/* 把 Markdown 插入当前编辑位置                                               */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* 输入方式：粘贴与拖拽                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 粘贴进来的图片常常叫 `image.png` 或 `blob`，补上时间戳和真实扩展名。
 *
 * 保留原扩展名会让同一秒内的多张截图互相覆盖记忆，而 `blob` 这种没有扩展名
 * 的名字又不能直接用来拼公开地址。
 */
function renamePasted(file: File): File {
  const named = /^image\.(png|jpe?g|gif|webp|bmp|avif|ico|svg|jxl|heic|heif|tiff?)$/i.test(file.name);
  if (file.name !== 'blob' && !named) return file;

  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  return new File([file], `pasted-${stamp}.${ext}`, { type: file.type });
}

/**
 * 从粘贴事件里取出图片。
 *
 * 两个来源都要看，顺序也和主流脚本一致：
 *   1. `clipboardData.files` —— 从系统复制文件（如截图后直接粘贴）时只有这个。
 *   2. `clipboardData.items` —— 网页里复制图片时用这个。
 *
 * 只读 `items` 会漏掉第一种情况，表现就是「粘贴没反应」。
 * 另外用 MIME 而不是文件名判断类型：粘贴进来的文件常叫 `blob` 或没有扩展名。
 */
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

/**
 * 这是不是一张可以上传的图片？
 *
 * 以 MIME 为主 —— 服务端最终按文件头判断，扩展名只用于拼公开地址，所以这里
 * 放宽一点，让没有扩展名的粘贴内容也能进到上传流程，由服务端给出明确结论。
 */
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
      const files = imagesFromClipboard(event).map(renamePasted);
      if (files.length === 0) return;

      // 只在这时候才拦截，避免影响正常的文字粘贴。
      event.preventDefault();
      event.stopPropagation();

      // 记下此刻的编辑目标；上传完成后焦点可能已经变了。
      enqueue(files, findEditor());
    },
    true,
  );

  // 拖拽时必须 preventDefault，否则浏览器会直接打开文件。
  for (const type of ['dragenter', 'dragover'] as const) {
    document.addEventListener(type, (event) => event.preventDefault());
  }
  document.addEventListener('drop', (event) => {
    const files = Array.from(event.dataTransfer?.files ?? []).filter(looksLikeImage);
    if (files.length === 0) return;
    event.preventDefault();
    enqueue(files);
  });
}

/* -------------------------------------------------------------------------- */
/* 启动                                                                       */
/* -------------------------------------------------------------------------- */

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
