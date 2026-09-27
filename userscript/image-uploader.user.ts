/**
 * 个人图床上传助手 — Tampermonkey / Violentmonkey 用户脚本
 *
 * 功能：
 *   1. Ctrl+V 粘贴图片上传
 *   2. 拖拽文件上传
 *   3. 点击悬浮按钮选择文件
 *   4. 多文件批量上传（最多同时 3 个）
 *   5. 逐个显示上传状态
 *   6. 失败自动重试（最多 2 次）
 *   7. 使用 API Token 认证
 *   8. 浏览器端计算 SHA-256
 *   9. 上传前检查重复，重复则直接复用
 *  10. 获取公开 URL
 *  11. 生成 Markdown（图片用 ![..]，其他文件用 [..]）
 *  12. 把 Markdown 插入到当前聚焦的输入框 / 可编辑区域
 *
 * 这个文件是 TypeScript 源码，由 `bun run build:userscript` 编译成同目录下的
 * `image-uploader.user.js`，编译产物可以直接安装，用户无需安装 Node。
 */

/* -------------------------------------------------------------------------- */
/* 油猴 API 的最小类型声明                                                    */
/* -------------------------------------------------------------------------- */

interface GmResponse {
  status: number;
  responseText: string;
  responseHeaders: string;
}

interface GmRequestDetails {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string | FormData;
  responseType?: 'text' | 'arraybuffer' | 'blob';
  timeout?: number;
  onload?: (response: GmResponse) => void;
  onerror?: (error: unknown) => void;
  ontimeout?: () => void;
}

declare function GM_xmlhttpRequest(details: GmRequestDetails): void;
declare function GM_getValue<T>(key: string, defaultValue?: T): T | undefined;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_registerMenuCommand(name: string, callback: () => void): void;

/* -------------------------------------------------------------------------- */
/* 常量与配置                                                                 */
/* -------------------------------------------------------------------------- */

const SETTINGS_KEY = 'pih_settings';
const MAX_CONCURRENCY = 3;
const MAX_RETRIES = 2;

interface Settings {
  apiUrl: string;
  token: string;
}

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
/* 设置读写                                                                   */
/* -------------------------------------------------------------------------- */

function loadSettings(): Settings {
  const stored = GM_getValue<Partial<Settings>>(SETTINGS_KEY, {});
  return {
    apiUrl: (stored?.apiUrl ?? '').replace(/\/+$/, ''),
    token: stored?.token ?? '',
  };
}

function saveSettings(settings: Settings): void {
  GM_setValue(SETTINGS_KEY, settings);
}

/* -------------------------------------------------------------------------- */
/* 网络请求                                                                   */
/* -------------------------------------------------------------------------- */

/** 统一的 JSON 请求；失败时抛出带 `code` 的错误。 */
function request<T>(
  settings: Settings,
  path: string,
  options: { method?: string; body?: unknown; formData?: FormData; headers?: Record<string, string> } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const headers: Record<string, string> = {
      'X-API-Key': settings.token,
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
      url: `${settings.apiUrl}${path}`,
      headers,
      data,
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

/* -------------------------------------------------------------------------- */
/* SHA-256                                                                    */
/* -------------------------------------------------------------------------- */

async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 上传队列                                                                   */
/* -------------------------------------------------------------------------- */

type State = 'pending' | 'hashing' | 'checking' | 'duplicate' | 'uploading' | 'success' | 'failed';

interface Task {
  key: string;
  file: File;
  state: State;
  error?: string;
  result?: UploadResult;
}

const tasks: Task[] = [];
let running = 0;
let counter = 0;

function enqueue(files: File[]): void {
  for (const file of files) {
    if (file.size === 0) continue;
    counter += 1;
    const supported = /\.(png|jpe?g|webp|gif|avif|bmp|ico)$/i.test(file.name);
    tasks.push({
      key: `t${counter}`,
      file,
      state: supported ? 'pending' : 'failed',
      error: supported ? undefined : '只支持图片（png、jpg、webp、gif、avif、bmp、ico）',
    });
  }
  renderQueue();
  pump();
}

function pump(): void {
  while (running < MAX_CONCURRENCY) {
    const task = tasks.find((t) => t.state === 'pending');
    if (!task) break;
    running += 1;
    void process(task).finally(() => {
      running -= 1;
      pump();
    });
  }
}

async function process(task: Task): Promise<void> {
  const settings = loadSettings();
  if (!settings.apiUrl || !settings.token) {
    task.state = 'failed';
    task.error = '请先在设置中填写 API 地址和 Token';
    renderQueue();
    return;
  }

  try {
    task.state = 'hashing';
    renderQueue();
    const sha256 = await sha256Hex(task.file);

    task.state = 'checking';
    renderQueue();
    const check = await request<CheckResult>(settings, '/api/upload/check', {
      method: 'POST',
      body: { sha256, size: task.file.size },
    });

    if (check.exists && check.file) {
      task.state = 'duplicate';
      task.result = { success: true, deduplicated: true, file: check.file };
      renderQueue();
      insertMarkdown(check.file.markdown, settings);
      return;
    }

    // 上传，带有限次重试。
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      task.state = 'uploading';
      renderQueue();

      try {
        const form = new FormData();
        form.append('file', task.file, task.file.name);

        const result = await request<UploadResult>(settings, '/api/upload', {
          method: 'POST',
          formData: form,
          headers: { 'X-File-SHA256': sha256 },
        });

        task.state = 'success';
        task.result = result;
        renderQueue();
        insertMarkdown(result.file.markdown, settings);
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : 'upload_failed';
        // 4xx（除限流外）重试没有意义。
        if (/^(unauthorized|token_revoked|invalid_sha256|checksum_mismatch|file_too_large|unsupported_file_type|missing_file|expected_multipart)/.test(message)) {
          break;
        }
        if (attempt < MAX_RETRIES) {
          await delay(400 * (attempt + 1));
        }
      }
    }

    task.state = 'failed';
    task.error = lastError instanceof Error ? lastError.message : 'upload_failed';
    renderQueue();
  } catch (error) {
    task.state = 'failed';
    task.error = error instanceof Error ? error.message : 'unknown_error';
    renderQueue();
  }
}

/* -------------------------------------------------------------------------- */
/* 把 Markdown 插入当前编辑位置                                               */
/* -------------------------------------------------------------------------- */

/**
 * 找到用户正在编辑的元素。
 *
 * 优先使用 `document.activeElement`，其次查找页面上最后一个可见的编辑区域。
 * 找不到时不强行插入，只提示用户复制。
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

  // 回退：页面上最后一个文本输入区域。
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('textarea, input[type="text"], [contenteditable="true"]'),
  ).filter((node) => node.offsetParent !== null);

  return candidates.length > 0 ? (candidates[candidates.length - 1] as HTMLElement) : null;
}

function isTextInput(input: HTMLInputElement): boolean {
  const type = input.type.toLowerCase();
  return ['text', 'search', 'url', 'email', 'tel', ''].includes(type);
}

function insertMarkdown(markdown: string, settings: Settings): void {
  const editor = findEditor();

  if (!editor) {
    void copyToClipboard(markdown);
    notify(`已复制到剪贴板：${markdown}`, 'ok');
    return;
  }

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;
    const before = editor.value.slice(0, start);
    const after = editor.value.slice(end);
    // 前后补空格，避免粘进已有文字的中间。
    const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const suffix = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
    const inserted = `${prefix}${markdown}${suffix}`;

    editor.value = before + inserted + after;
    const caret = start + inserted.length;
    editor.setSelectionRange(caret, caret);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (editor.isContentEditable) {
    editor.focus();
    document.execCommand('insertText', false, markdown);
  }

  notify('已插入 Markdown', 'ok');
  // 同时留在剪贴板里，方便手动粘贴到别处。
  void copyToClipboard(markdown);
  void settings;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 剪贴板权限被拒绝时静默忽略；UI 上仍然展示了 Markdown。
  }
}

/* -------------------------------------------------------------------------- */
/* 界面                                                                       */
/* -------------------------------------------------------------------------- */

const PANEL_ID = 'pih-panel';

function notify(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  const node = document.createElement('div');
  node.className = `pih-toast pih-toast-${kind}`;
  node.textContent = message;
  panel().appendChild(node);
  window.setTimeout(() => node.remove(), 3200);
}

/** 浮动面板，承载按钮、状态列表和设置。 */
function panel(): HTMLElement {
  const existing = document.getElementById(PANEL_ID);
  if (existing) return existing;

  const root = document.createElement('div');
  root.id = PANEL_ID;

  const toggle = document.createElement('button');
  toggle.className = 'pih-toggle';
  toggle.type = 'button';
  toggle.title = '个人图床上传助手';
  toggle.textContent = '↑';
  toggle.addEventListener('click', () => {
    root.classList.toggle('pih-open');
    renderQueue();
  });

  const body = document.createElement('div');
  body.className = 'pih-body';

  const head = document.createElement('div');
  head.className = 'pih-head';
  head.textContent = '个人图床上传助手';

  const actions = document.createElement('div');
  actions.className = 'pih-actions';

  const pick = document.createElement('button');
  pick.className = 'pih-btn';
  pick.type = 'button';
  pick.textContent = '选择文件';
  pick.addEventListener('click', () => pickFiles());

  const settingsButton = document.createElement('button');
  settingsButton.className = 'pih-btn pih-btn-ghost';
  settingsButton.type = 'button';
  settingsButton.textContent = '设置';
  settingsButton.addEventListener('click', () => openSettings());

  const clear = document.createElement('button');
  clear.className = 'pih-btn pih-btn-ghost';
  clear.type = 'button';
  clear.textContent = '清空';
  clear.addEventListener('click', () => {
    for (let i = tasks.length - 1; i >= 0; i -= 1) {
      const task = tasks[i] as Task;
      if (task.state !== 'pending' && task.state !== 'uploading') tasks.splice(i, 1);
    }
    renderQueue();
  });

  actions.append(pick, settingsButton, clear);

  const hint = document.createElement('p');
  hint.className = 'pih-hint';
  hint.textContent = 'Ctrl+V 粘贴图片 · 拖拽图片到页面 · 支持批量';

  const queue = document.createElement('div');
  queue.className = 'pih-queue';
  queue.id = 'pih-queue';

  body.append(head, actions, hint, queue);
  root.append(toggle, body);
  document.body.appendChild(root);

  // 拖拽整页上传。
  installDropHandlers(root);

  return root;
}

function renderQueue(): void {
  const queue = document.getElementById('pih-queue');
  if (!queue) return;

  queue.replaceChildren(
    ...tasks.map((task) => {
      const row = document.createElement('div');
      row.className = `pih-row pih-state-${task.state}`;

      const name = document.createElement('span');
      name.className = 'pih-name';
      name.title = task.file.name;
      name.textContent = task.file.name;

      const status = document.createElement('span');
      status.className = 'pih-status';
      status.textContent = describe(task);

      row.append(name, status);

      if (task.state === 'success' || task.state === 'duplicate') {
        const link = document.createElement('a');
        link.href = task.result?.file.url ?? '#';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'pih-link';
        link.textContent = '打开';
        link.addEventListener('click', (event) => event.stopPropagation());
        row.append(link);
      }

      if (task.state === 'failed') {
        const retry = document.createElement('button');
        retry.className = 'pih-btn pih-btn-ghost pih-retry';
        retry.type = 'button';
        retry.textContent = '重试';
        retry.addEventListener('click', () => {
          task.state = 'pending';
          task.error = undefined;
          renderQueue();
          pump();
        });
        row.append(retry);
      }

      return row;
    }),
  );
}

function describe(task: Task): string {
  switch (task.state) {
    case 'pending':
      return '等待中';
    case 'hashing':
      return '计算 Hash…';
    case 'checking':
      return '检查重复…';
    case 'duplicate':
      return '已存在，跳过上传';
    case 'uploading':
      return '上传中…';
    case 'success':
      return '上传成功';
    case 'failed':
      return `失败：${task.error ?? '未知错误'}`;
    default:
      return '';
  }
}

/* -------------------------------------------------------------------------- */
/* 输入方式                                                                   */
/* -------------------------------------------------------------------------- */

let dropInstalled = false;

function installDropHandlers(root: HTMLElement): void {
  if (dropInstalled) return;
  dropInstalled = true;

  // Ctrl+V：只在整页监听，且仅处理剪贴板里的文件。
  document.addEventListener('paste', (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(renamePasted(file));
    }

    if (files.length > 0) {
      event.preventDefault();
      root.classList.add('pih-open');
      enqueue(files);
    }
  });

  // 拖拽：必须 preventDefault，否则浏览器会直接打开文件。
  for (const type of ['dragenter', 'dragover'] as const) {
    document.addEventListener(type, (event) => {
      event.preventDefault();
      root.classList.add('pih-dragging');
      root.classList.add('pih-open');
    });
  }
  for (const type of ['dragleave', 'dragend'] as const) {
    document.addEventListener(type, () => root.classList.remove('pih-dragging'));
  }
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    root.classList.remove('pih-dragging');

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      root.classList.add('pih-open');
      enqueue(Array.from(files));
    }
  });
}

function pickFiles(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.png,.jpg,.jpeg,.webp,.gif,.avif,.bmp,.ico,image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,image/x-icon';
  input.multiple = true;
  // 留在 DOM 之外也可以触发；部分浏览器要求节点已挂载。
  input.style.display = 'none';
  document.body.appendChild(input);

  input.addEventListener('change', () => {
    if (input.files && input.files.length > 0) {
      enqueue(Array.from(input.files));
    }
    input.remove();
  });

  input.click();
}

/** 粘贴进来的图片通常叫 image.png，补上时间戳便于区分。 */
function renamePasted(file: File): File {
  if (/^image\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i.test(file.name) || file.name === 'blob') {
    const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-');
    return new File([file], `pasted-${stamp}.${ext}`, { type: file.type });
  }
  return file;
}

/* -------------------------------------------------------------------------- */
/* 设置弹窗                                                                   */
/* -------------------------------------------------------------------------- */

function openSettings(): void {
  const current = loadSettings();

  const url = window.prompt(
    'API 地址（例如 https://panel.example.com）\n\n' +
      '在后台「API Token」页面生成 Token 后填入下一步。',
    current.apiUrl,
  );
  if (url === null) return;

  const token = window.prompt('API Token（cph_ 开头）', current.token);
  if (token === null) return;

  saveSettings({
    apiUrl: url.trim().replace(/\/+$/, ''),
    token: token.trim(),
  });

  notify('设置已保存', 'ok');
}

/* -------------------------------------------------------------------------- */
/* 样式                                                                       */
/* -------------------------------------------------------------------------- */

const STYLE = `
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

function injectStyle(): void {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

/* -------------------------------------------------------------------------- */
/* 启动                                                                       */
/* -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boot(): void {
  if (window.top !== window.self) return; // 不在 iframe 里运行
  injectStyle();
  panel();

  GM_registerMenuCommand('上传设置', () => openSettings());
  GM_registerMenuCommand('打开上传面板', () => {
    panel().classList.add('pih-open');
    renderQueue();
  });

  const settings = loadSettings();
  if (!settings.apiUrl || !settings.token) {
    // 首次使用时主动引导配置。
    notify('请先点击「设置」填写 API 地址和 Token', 'info');
    panel().classList.add('pih-open');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
