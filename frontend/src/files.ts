/** Paginated image browser with search, preview and deletion. */

import { ApiError, deleteFile, listFiles } from './api.js';
import type { FileInfo } from './types.js';
import { humanizeError } from './types.js';
import {
  copyWithFeedback,
  el,
  formatBytes,
  formatTime,
  replace,
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
    // Clicking the thumbnail opens the full-size preview in a <dialog> instead
    // of a new tab, and an explicit action button opens the raw URL for anyone
    // who wants to link to it directly.
    const media = el('button', {
      class: 'shot-media',
      type: 'button',
      'aria-label': `预览 ${file.name}`,
    });
    const preview = el('img', {
      class: 'shot-img',
      src: file.url,
      alt: file.name,
      loading: 'lazy',
    });
    preview.addEventListener('error', () => {
      media.classList.add('is-broken');
      media.dataset.label = file.contentType.replace(/^image\//, '');
      preview.remove();
    });
    media.append(preview);
    media.addEventListener('click', () => openPreview(file));

    const actions = el('div', { class: 'shot-actions' }, [
      button('链接', () => copyWithFeedback(file.url, 'URL', copyText)),
      button('Markdown', () => copyWithFeedback(file.markdown, 'Markdown', copyText)),
      link('打开', file.url),
      button('删除', () => void this.confirmDelete(file), 'btn-danger'),
    ]);

    return el('article', { class: 'shot' }, [
      media,
      el('div', { class: 'shot-caption' }, [
        el('div', { class: 'shot-name', title: file.name, text: file.name }),
        el('div', {
          class: 'shot-sub',
          text: `${formatBytes(file.size)} · ${formatTime(file.createdAt)}`,
        }),
      ]),
      actions,
    ]);
  }

  private async confirmDelete(file: FileInfo): Promise<void> {
    const ok = window.confirm(
      `确定删除「${file.name}」吗？\n\n图片会同时从 R2 和数据库中移除。`,
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

/** An action that navigates, styled like the buttons next to it. */
function link(label: string, href: string): HTMLAnchorElement {
  return el('a', {
    class: 'btn btn-ghost btn-sm',
    href,
    target: '_blank',
    rel: 'noopener noreferrer',
    text: label,
  });
}

/**
 * Full-size preview in a `<dialog>`.
 *
 * Clicking the backdrop closes it, and so do Esc (native `<dialog>`
 * behaviour) and a second click on the image. A click on the image would
 * otherwise bubble up to the dialog and close it immediately, so that case is
 * filtered out.
 */
function openPreview(file: FileInfo): void {
  const dialog = document.getElementById('preview-dialog');
  const image = document.getElementById('preview-dialog-img');
  if (!(dialog instanceof HTMLDialogElement) || !(image instanceof HTMLImageElement)) {
    // Markup changed — fall back to opening the raw image.
    window.open(file.url, '_blank', 'noopener');
    return;
  }

  // Bound once and kept: a one-shot listener would be consumed by the click on
  // the image itself, leaving later backdrop clicks unable to close the dialog.
  if (!dialog.dataset.bound) {
    dialog.dataset.bound = '1';
    dialog.addEventListener('click', (event) => {
      if (event.target !== image) dialog.close();
    });
  }

  image.src = file.url;
  image.alt = file.name;
  if (!dialog.open) dialog.showModal();
}
