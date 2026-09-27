/**
 * Main application: the upload panel behind the login.
 *
 * Wires together the drop zone, the paste handler, the upload queue, the file
 * browser, token management and the backup card.
 */

import {
  ApiError,
  BACKUP_DOWNLOAD_URL,
  backupStatus,
  createToken,
  listTokens,
  logout,
  me,
  revokeToken,
  runBackup,
  stats,
} from './api.js';
import { copyText } from './clipboard.js';
import { FileBrowser } from './files.js';
import type { ApiToken } from './types.js';
import { humanizeError } from './types.js';
import { UploadQueue } from './upload.js';
import type { UploadTask } from './types.js';
import {
  byId,
  copyRow,
  copyWithFeedback,
  el,
  formatBytes,
  formatTime,
  formatUtc,
  replace,
  toast,
} from './ui.js';

const DEFAULT_MAX_SIZE = 50 * 1024 * 1024;

export async function initApp(): Promise<void> {
  // Access control lives on the server: `/` only serves this page to a signed-in
  // admin and redirects everyone else. This call is purely for display, so a
  // failure must not block the panel from rendering.
  const who = await me().catch(() => null);

  byId('whoami').textContent = who?.username || 'admin';
  byId('api-base-hint').textContent = window.location.origin;

  initTabs();

  const maxSize = Number(document.body.dataset.maxUploadSize ?? DEFAULT_MAX_SIZE);
  const queue = new UploadQueue(Number.isFinite(maxSize) ? maxSize : DEFAULT_MAX_SIZE);

  const dropZone = byId('drop-zone');
  const fileInput = byId<HTMLInputElement>('file-input');
  const queueList = byId('queue');

  const browser = new FileBrowser({
    list: byId('file-list'),
    loadMore: byId<HTMLButtonElement>('load-more'),
    search: byId<HTMLInputElement>('search'),
  });

  // -- upload surface -------------------------------------------------------

  dropZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      queue.add(Array.from(fileInput.files));
    }
    fileInput.value = '';
  });

  // Drag & drop. Both events must be cancelled or the browser navigates away
  // from the page to open the dropped file.
  for (const eventName of ['dragenter', 'dragover'] as const) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add('drop-zone-active');
    });
  }
  for (const eventName of ['dragleave', 'dragend'] as const) {
    dropZone.addEventListener(eventName, () => {
      dropZone.classList.remove('drop-zone-active');
    });
  }
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('drop-zone-active');

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      queue.add(Array.from(files));
    }
  });

  // Ctrl+V anywhere on the page.
  document.addEventListener('paste', (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      // Only images come through as files on paste; name them sensibly.
      if (file) files.push(renamePastedFile(file));
    }

    if (files.length > 0) {
      event.preventDefault();
      queue.add(files);
    }
  });

  // Re-render the queue whenever it changes.
  const queueWrap = byId('queue-wrap');
  queue.subscribe(() => {
    queueWrap.hidden = queue.list().length === 0;
    renderQueue(queueList, queue);
    renderQueueSummary(queue);
  });

  // -- toolbar --------------------------------------------------------------

  byId('logout').addEventListener('click', () => {
    void (async () => {
      await logout().catch(() => undefined);
      window.location.replace('/login');
    })();
  });

  byId('refresh-files').addEventListener('click', () => {
    void browser.refresh();
  });

  browser.subscribe(() => {
    const badge = byId('files-count');
    badge.textContent = String(browser.totalCount);
    badge.hidden = browser.totalCount === 0;
  });

  byId('clear-finished').addEventListener('click', () => {
    queue.clearFinished();
  });

  // -- tokens ---------------------------------------------------------------

  const tokenList = byId('token-list');
  const tokenForm = byId<HTMLFormElement>('token-form');
  const tokenName = byId<HTMLInputElement>('token-name');

  tokenForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const name = tokenName.value.trim() || 'Tampermonkey';
      try {
        const created = await createToken(name);
        tokenName.value = '';
        // The plaintext token is displayed exactly once.
        showNewToken(created.token);
        await refreshTokens(tokenList);
      } catch (error) {
        toast(errorText(error, '生成 Token 失败'), 'error');
      }
    })();
  });

  // -- settings -------------------------------------------------------------

  byId('backup-download').setAttribute('href', BACKUP_DOWNLOAD_URL);

  byId('backup-run').addEventListener('click', () => {
    void (async () => {
      const button = byId<HTMLButtonElement>('backup-run');
      button.disabled = true;
      button.textContent = '备份中…';
      try {
        const report = await runBackup();
        toast(`备份成功：${formatBytes(report.bytes)}`, 'ok');
        await refreshBackup();
      } catch (error) {
        toast(errorText(error, '备份失败'), 'error');
      } finally {
        button.disabled = false;
        button.textContent = '立即备份';
      }
    })();
  });

  // -- initial load ---------------------------------------------------------

  await Promise.all([
    browser.refresh(),
    refreshTokens(tokenList),
    refreshStats(),
    refreshBackup(),
  ]);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TAB_KEY = 'pih_active_tab';

/** Switch between the four panels, remembering the choice across reloads. */
function initTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));

  function activate(name: string, focus = false): void {
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      if (active && focus) tab.focus();
    }
    for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
      panel.classList.toggle('is-active', panel.id === `panel-${name}`);
    }
    try {
      window.localStorage.setItem(TAB_KEY, name);
    } catch {
      // Private mode — the tab still switches, it just will not be remembered.
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => activate(tab.dataset.tab ?? 'upload'));
  }

  // Deep links like `/ #tokens` still work.
  const fromHash = window.location.hash.replace('#', '');
  const known = tabs.map((t) => t.dataset.tab);
  const initial =
    (known.includes(fromHash) ? fromHash : null) ??
    (() => {
      try {
        return window.localStorage.getItem(TAB_KEY);
      } catch {
        return null;
      }
    })() ??
    'upload';

  activate(known.includes(initial) ? initial : 'upload');
}

// ---------------------------------------------------------------------------
// Queue rendering
// ---------------------------------------------------------------------------

/** "3 个上传中 · 2 个失败" — a one-line summary of the queue. */
function renderQueueSummary(queue: UploadQueue): void {
  const tasks = queue.list();
  const failed = tasks.filter((t) => t.state === 'failed').length;
  const done = tasks.filter(
    (t) => t.state === 'success' || t.state === 'duplicate',
  ).length;

  const parts: string[] = [];
  if (queue.activeCount > 0) parts.push(`${queue.activeCount} 个进行中`);
  if (done > 0) parts.push(`${done} 个已完成`);
  if (failed > 0) parts.push(`${failed} 个失败`);

  byId('queue-summary').textContent = parts.join(' · ');
}

function renderQueue(container: HTMLElement, queue: UploadQueue): void {
  const tasks = queue.list();
  if (tasks.length === 0) {
    replace(container, []);
    return;
  }
  replace(
    container,
    tasks.map((task) => renderTask(task, queue)),
  );
}

function renderTask(task: UploadTask, queue: UploadQueue): HTMLElement {
  const { label, tone } = describeState(task);

  const status = el('div', { class: `queue-status tone-${tone}` }, [
    el('span', { class: 'queue-state', text: label }),
    task.state === 'uploading'
      ? el('span', {
          class: 'queue-progress',
          text: `${Math.round(task.progress * 100)}%`,
        })
      : null,
  ].filter((node): node is HTMLElement => node !== null));

  const head = el('div', { class: 'queue-head' }, [
    el('div', { class: 'queue-name', title: task.file.name, text: task.file.name }),
    el('div', { class: 'queue-size', text: formatBytes(task.file.size) }),
    status,
  ]);

  const children: (Node | string)[] = [head];

  // Progress bar while uploading.
  if (task.state === 'uploading') {
    const bar = el('div', { class: 'progress' }, [
      el('div', {
        class: 'progress-fill',
        style: `width: ${Math.round(task.progress * 100)}%`,
      }),
    ]);
    children.push(bar);
  }

  // Error message plus a retry affordance.
  if (task.state === 'failed') {
    children.push(
      el('div', { class: 'queue-error' }, [
        `上传失败：${task.error ? humanizeMaybe(task.error) : '未知错误'}`,
      ]),
    );
    const retry = el('button', {
      class: 'btn btn-sm',
      type: 'button',
      text: '重试',
    });
    retry.addEventListener('click', () => queue.retry(task.key));
    children.push(el('div', { class: 'queue-actions' }, [retry]));
  }

  // On success (fresh or deduplicated), offer the three actions the spec
  // requires: copy URL, copy Markdown, open in a new tab.
  if (task.state === 'success' || task.state === 'duplicate') {
    const file = task.result?.file;
    if (file) {
      children.push(
        copyRow(file.url, (value) => {
          void copyWithFeedback(value, 'URL', copyText);
        }, { mono: true }),
      );
      children.push(
        copyRow(file.markdown, (value) => {
          void copyWithFeedback(value, 'Markdown', copyText);
        }, { mono: true }),
      );

      const open = el('a', {
        class: 'btn btn-sm',
        href: file.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: '打开',
      });
      children.push(el('div', { class: 'queue-actions' }, [open]));
    }
  }

  const dismiss = el('button', {
    class: 'btn btn-ghost btn-sm queue-dismiss',
    type: 'button',
    title: '移除',
    text: '×',
  });
  dismiss.addEventListener('click', () => queue.remove(task.key));
  head.append(dismiss);

  return el('article', { class: `queue-item state-${task.state}` }, children);
}

function describeState(task: UploadTask): { label: string; tone: string } {
  switch (task.state) {
    case 'pending':
      return { label: '等待中', tone: 'muted' };
    case 'hashing':
      return { label: '计算 Hash…', tone: 'muted' };
    case 'checking':
      return { label: '检查重复…', tone: 'muted' };
    case 'duplicate':
      return { label: '检测到相同图片，已跳过上传', tone: 'ok' };
    case 'uploading':
      return { label: '上传中…', tone: 'busy' };
    case 'success':
      return { label: '上传成功', tone: 'ok' };
    case 'failed':
      return { label: '上传失败', tone: 'error' };
    default:
      return { label: '', tone: 'muted' };
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

async function refreshTokens(container: HTMLElement): Promise<void> {
  try {
    const tokens = await listTokens();
    if (tokens.length === 0) {
      replace(container, [
        el('p', { class: 'empty-state', text: '还没有 API Token' }),
      ]);
      return;
    }
    replace(
      container,
      tokens.map((token) => renderToken(token, container)),
    );
  } catch (error) {
    replace(container, [
      el('p', { class: 'empty-state', text: errorText(error, '加载 Token 失败') }),
    ]);
  }
}

function renderToken(token: ApiToken, container: HTMLElement): HTMLElement {
  const status = token.revoked
    ? el('span', { class: 'tag tag-danger', text: '已撤销' })
    : el('span', { class: 'tag tag-ok', text: '有效' });

  const meta = el('div', { class: 'token-meta' }, [
    el('span', { class: 'token-name', text: token.name }),
    status,
    el('span', { class: 'dim', text: `创建于 ${formatTime(token.createdAt)}` }),
    el('span', {
      class: 'dim',
      text: `最近使用 ${formatTime(token.lastUsedAt)}`,
    }),
    el('span', { class: 'mono dim', text: `#${token.prefix}` }),
  ]);

  const children: (Node | string)[] = [meta];

  if (!token.revoked) {
    const revoke = el('button', {
      class: 'btn btn-danger btn-sm',
      type: 'button',
      text: '撤销',
    });
    revoke.addEventListener('click', () => {
      void (async () => {
        if (!window.confirm(`确定撤销 Token「${token.name}」吗？撤销后无法恢复。`)) {
          return;
        }
        try {
          await revokeToken(token.id);
          toast('Token 已撤销', 'ok');
          await refreshTokens(container);
        } catch (error) {
          toast(errorText(error, '撤销失败'), 'error');
        }
      })();
    });
    children.push(el('div', { class: 'token-actions' }, [revoke]));
  }

  return el('article', { class: 'token-card' }, children);
}

/** Show a newly created token, with the "only shown once" warning. */
function showNewToken(token: string): void {
  const host = byId('new-token');
  host.hidden = false;
  replace(host, [
    el('div', { class: 'notice notice-warn' }, [
      '请立即复制并保存，这个 Token 只会显示这一次。',
    ]),
    copyRow(token, (value) => {
      void copyWithFeedback(value, 'Token', copyText);
    }, { mono: true }),
  ]);
}

// ---------------------------------------------------------------------------
// Stats and backup
// ---------------------------------------------------------------------------

async function refreshStats(): Promise<void> {
  const host = byId('stats');
  try {
    const data = await stats();
    replace(host, [
      el('span', { text: `${data.files} 张图片` }),
      el('span', { class: 'dim', text: '·' }),
      el('span', { text: formatBytes(data.bytes) }),
    ]);
  } catch {
    replace(host, []);
  }
}

async function refreshBackup(): Promise<void> {
  const host = byId('backup-status');
  try {
    const data = await backupStatus();

    if (!data.exists) {
      replace(host, [
        el('p', { class: 'empty-state', text: '还没有备份。等待每日 04:00 UTC 的定时任务，或点「立即备份」。' }),
      ]);
      return;
    }

    const rows: [string, string][] = [
      ['状态', '正常'],
      ['最近备份', formatUtc(data.uploadedAt)],
      ['备份大小', formatBytes(data.size)],
      ['SHA-256', data.sha256 ?? '—'],
      ['定时任务', data.cron],
    ];

    replace(
      host,
      rows.map(([label, value]) =>
        el('div', { class: 'kv' }, [
          el('span', { class: 'kv-key', text: label }),
          el('span', { class: 'kv-value mono', text: value }),
        ]),
      ),
    );
  } catch (error) {
    replace(host, [
      el('p', { class: 'empty-state', text: errorText(error, '读取备份状态失败') }),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pasted images arrive as `image.png` or similar with no useful name. Give them
 * a timestamped name so the file list is readable.
 */
function renamePastedFile(file: File): File {
  if (/^image\.(png|jpe?g|gif|webp|bmp|avif|ico|svg|jxl|heic|heif|tiff?)$/i.test(file.name) || file.name === 'blob') {
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

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return humanizeError(error.code);
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

/** Task errors are already humanised in places; pass through if they look like prose. */
function humanizeMaybe(code: string): string {
  return /[\u4e00-\u9fa5]/.test(code) ? code : humanizeError(code);
}
