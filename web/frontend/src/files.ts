/** Paginated image browser with search, preview and deletion. */

import { ApiError, deleteFile, listFiles, saveThumbnail } from './api.js';
import type { FileInfo } from '../../shared/types.js';
import { humanizeError } from '../../shared/types.js';
import {
  copyWithFeedback,
  el,
  formatBytes,
  formatTime,
  replace,
  toast,
} from './ui.js';
import { copyText } from './clipboard.js';

import { makeThumbnail } from '../../shared/thumbnail.js';

const PAGE_SIZE = 24;

export class FileBrowser {
  private readonly container: HTMLElement;
  private readonly loadMoreButton: HTMLButtonElement;
  private readonly searchInput: HTMLInputElement;

  private items: FileInfo[] = [];
  private cursor: string | null = null;
  private generation = 0;
  private controller: AbortController | undefined;
  private readonly cards = new Map<string, HTMLElement>();
  private readonly removed = new Set<string>();
  private thumbnailsRunning = 0;
  private readonly thumbnailJobs: { file: FileInfo; image: HTMLImageElement }[] = [];
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
    if (this.loading && !reset) return;
    if (!reset && !this.cursor) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    this.loading = true;
    if (reset) {
      this.cursor = null;
      this.items = [];
      this.total = 0;
      this.render();
    }
    this.loadMoreButton.disabled = true;
    this.loadMoreButton.textContent = '加载中…';
    try {
      const page = await listFiles({
        q: this.query || undefined, limit: PAGE_SIZE,
        cursor: this.cursor ?? undefined, signal: controller.signal,
      });
      if (generation !== this.generation) return;
      const known = new Set(this.items.map((file) => file.id));
      const files = page.files.filter((file) => !this.removed.has(file.id) && !known.has(file.id));
      this.items = reset ? files : [...this.items, ...files];
      this.cursor = page.nextCursor;
      this.total = page.total;
      this.render();
      this.notify();
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) this.renderError(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.loadMoreButton.disabled = false;
        this.updateLoadMore();
      }
    }
  }

  /** Reload from the first page. */
  refresh(): Promise<void> {
    return this.load(true);
  }

  /** Remove a file after a successful delete, without a full reload. */
  removeLocally(id: string): void {
    this.removed.add(id);
    this.items = this.items.filter((file) => file.id !== id);
    this.total = Math.max(0, this.total - 1);
    this.render();
    this.updateLoadMore();
    this.notify();
  }

  private updateLoadMore(): void {
    const hasMore = this.cursor !== null;
    this.loadMoreButton.hidden = !hasMore;
    this.loadMoreButton.textContent = `加载更多（还有 ${this.total - this.items.length} 个）`;
  }

  private renderError(error: unknown): void {
    const message =
      error instanceof ApiError ? humanizeError(error.code) : '加载图片列表失败';
    if (this.items.length > 0) { toast(message, 'error'); return; }
    this.cards.clear();
    replace(this.container, [el('p', { class: 'empty-state', text: message })]);
    this.loadMoreButton.hidden = true;
  }

  private render(): void {
    if (this.items.length === 0) {
      this.cards.clear();
      const message = this.query
        ? `没有找到匹配「${this.query}」的图片`
        : '还没有上传任何图片';
      replace(this.container, [el('p', { class: 'empty-state', text: message })]);
      return;
    }

    const ids = new Set(this.items.map((file) => file.id));
    for (const [id,node] of this.cards) {
      if (!ids.has(id)) { node.remove(); this.cards.delete(id); }
    }
    if (this.cards.size === 0) replace(this.container, []);
    for (const file of this.items) {
      if (!this.cards.has(file.id)) {
        const card = this.renderCard(file);
        this.cards.set(file.id,card);
        this.container.append(card);
      }
    }
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
      src: file.thumbnailUrl ?? file.url,
      alt: file.name,
      loading: 'lazy',
      decoding: 'async',
    });
    preview.addEventListener('error', () => {
      if (file.thumbnailUrl && preview.src !== file.url) { preview.src = file.url; return; }
      media.classList.add('is-broken');
      media.dataset.label = file.contentType.replace(/^image\//, '');
      preview.remove();
    });
    if (!file.thumbnailUrl) {
      preview.addEventListener('load', () => {
        this.thumbnailJobs.push({file,image:preview});
        this.pumpThumbnails();
      }, { once: true });
    }
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

  private pumpThumbnails(): void {
    while (this.thumbnailsRunning < 2 && this.thumbnailJobs.length) {
      const job = this.thumbnailJobs.shift();
      if (!job || !job.image.isConnected || this.removed.has(job.file.id)) continue;
      this.thumbnailsRunning += 1;
      void this.backfillThumbnail(job.file,job.image).finally(() => {
        this.thumbnailsRunning -= 1;
        this.pumpThumbnails();
      });
    }
  }

  private async backfillThumbnail(file: FileInfo, image: HTMLImageElement): Promise<void> {
    try {
      const thumbnail = await makeThumbnail(image);
      if (!thumbnail || !image.isConnected || this.removed.has(file.id)) return;
      const updated = await saveThumbnail(file.id, thumbnail);
      file.thumbnailUrl = updated.thumbnailUrl;
      if (updated.thumbnailUrl && image.isConnected) image.src = updated.thumbnailUrl;
    } catch { /* Optional preview can be retried when the file is shown again. */ }
  }

  private async confirmDelete(file: FileInfo): Promise<void> {
    const ok = window.confirm(
      `确定删除「${file.name}」吗？\n\n图片会立即从列表移除，存储清理由服务器自动完成。`,
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
