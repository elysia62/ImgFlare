/**
 * File browser: paginated list, search, per-row actions.
 *
 * The list is never loaded in full — the server paginates with LIMIT/OFFSET and
 * this module appends pages as the user asks for them.
 */

import { ApiError, deleteFile, listFiles } from './api.js';
import type { FileInfo } from './types.js';
import { humanizeError } from './types.js';
import {
  copyRow,
  copyWithFeedback,
  el,
  formatBytes,
  formatTime,
  replace,
  shortHash,
  toast,
} from './ui.js';
import { copyText } from './clipboard.js';

const PAGE_SIZE = 24;

export class FileBrowser {
  private readonly container: HTMLElement;
  private readonly loadMoreButton: HTMLButtonElement;
  private readonly searchInput: HTMLInputElement;

  private items: FileInfo[] = [];
  private offset = 0;
  private total = 0;
  private query = '';
  private loading = false;
  private readonly listeners = new Set<() => void>();

  constructor(options: {
    list: HTMLElement;
    loadMore: HTMLButtonElement;
    search: HTMLInputElement;
  }) {
    this.container = options.list;
    this.loadMoreButton = options.loadMore;
    this.searchInput = options.search;

    this.loadMoreButton.addEventListener('click', () => {
      void this.load(false);
    });

    // Debounce the search box so typing does not fire a request per keystroke.
    let timer: number | undefined;
    this.searchInput.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        this.query = this.searchInput.value.trim();
        void this.load(true);
      }, 250);
    });
  }

  /** Notified after every successful render, so the tab badge can update. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }

  /** How many files match the current search, server-side. */
  get totalCount(): number {
    return this.total;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Load a page. `reset` starts over from the first page. */
  async load(reset: boolean): Promise<void> {
    if (this.loading) return;
    this.loading = true;

    if (reset) {
      this.offset = 0;
      this.items = [];
      this.render();
    }

    this.loadMoreButton.disabled = true;
    this.loadMoreButton.textContent = '加载中…';

    try {
      const page = await listFiles({
        q: this.query || undefined,
        limit: PAGE_SIZE,
        offset: this.offset,
      });

      this.items = reset ? page.files : [...this.items, ...page.files];
      this.offset = this.items.length;
      this.total = page.total;
      this.render();
      this.notify();
    } catch (error) {
      this.renderError(error);
    } finally {
      this.loading = false;
      this.loadMoreButton.disabled = false;
      this.updateLoadMore();
    }
  }

  /** Reload from the first page. */
  refresh(): Promise<void> {
    return this.load(true);
  }

  /** Remove a file after a successful delete, without a full reload. */
  removeLocally(id: string): void {
    this.items = this.items.filter((file) => file.id !== id);
    this.total = Math.max(0, this.total - 1);
    this.offset = this.items.length;
    this.render();
    this.updateLoadMore();
    this.notify();
  }

  private updateLoadMore(): void {
    const hasMore = this.items.length < this.total;
    this.loadMoreButton.hidden = !hasMore;
    this.loadMoreButton.textContent = `加载更多（还有 ${this.total - this.items.length} 个）`;
  }

  private renderError(error: unknown): void {
    const message =
      error instanceof ApiError ? humanizeError(error.code) : '加载图片列表失败';
    replace(this.container, [el('p', { class: 'empty-state', text: message })]);
    this.loadMoreButton.hidden = true;
  }

  private render(): void {
    if (this.items.length === 0) {
      const message = this.query
        ? `没有找到匹配「${this.query}」的图片`
        : '还没有上传任何图片';
      replace(this.container, [el('p', { class: 'empty-state', text: message })]);
      return;
    }

    replace(
      this.container,
      this.items.map((file) => this.renderCard(file)),
    );
  }

  private renderCard(file: FileInfo): HTMLElement {
    const preview = el('img', {
      class: 'file-thumb',
      src: file.url,
      alt: file.name,
      loading: 'lazy',
    });

    const meta = el('div', { class: 'file-meta' }, [
      el('div', { class: 'file-name', title: file.name, text: file.name }),
      el('div', { class: 'file-sub' }, [
        el('span', { class: 'tag', text: file.contentType }),
        el('span', { text: formatBytes(file.size) }),
        el('span', { text: formatTime(file.createdAt) }),
        el('span', { class: 'mono dim', text: shortHash(file.sha256) }),
      ]),
    ]);

    const actions = el('div', { class: 'file-actions' }, [
      button('复制 URL', () =>
        copyWithFeedback(file.url, 'URL', copyText),
      ),
      button('复制 Markdown', () =>
        copyWithFeedback(file.markdown, 'Markdown', copyText),
      ),
      link('打开', file.url),
      button('删除', () => void this.confirmDelete(file), 'btn-danger'),
    ]);

    const copyRowNode = copyRow(file.url, (value) => {
      void copyWithFeedback(value, 'URL', copyText);
    }, { mono: true });

    return el('article', { class: 'file-card' }, [
      el('div', { class: 'file-head' }, [preview, meta]),
      copyRowNode,
      actions,
    ]);
  }

  private async confirmDelete(file: FileInfo): Promise<void> {
    const ok = window.confirm(
      `确定删除「${file.name}」吗？\n\n图片会同时从 R2 和数据库中移除。\n重新上传相同内容会生成相同的 URL。`,
    );
    if (!ok) return;

    try {
      await deleteFile(file.id);
      this.removeLocally(file.id);
      toast('已删除', 'ok');
    } catch (error) {
      const message =
        error instanceof ApiError ? humanizeError(error.code) : '删除失败';
      toast(message, 'error');
    }
  }
}

function button(
  label: string,
  onClick: () => void,
  extraClass = '',
): HTMLButtonElement {
  const node = el('button', {
    class: `btn btn-ghost btn-sm ${extraClass}`.trim(),
    type: 'button',
    text: label,
  });
  node.addEventListener('click', onClick);
  return node;
}

function link(label: string, href: string): HTMLAnchorElement {
  return el('a', {
    class: 'btn btn-ghost btn-sm',
    href,
    target: '_blank',
    rel: 'noopener noreferrer',
    text: label,
  });
}
