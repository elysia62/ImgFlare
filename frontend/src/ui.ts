/**
 * DOM construction helpers.
 *
 * Everything here builds nodes with `document.createElement` and assigns text
 * through `textContent`. No user-controlled string is ever passed to
 * `innerHTML`, which is the front-end half of the XSS defence (the other half is
 * that uploads with active content are served from a different origin).
 */

type Attrs = Record<string, string | number | boolean | undefined>;

/** Create an element with attributes and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

/** Replace all children of `parent`. */
export function replace(parent: HTMLElement, children: (Node | string)[]): void {
  parent.replaceChildren(...children);
}

/** `#id`, asserting the element exists. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

/** Format a byte count for display. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

/** Format a millisecond timestamp as a local date/time string. */
export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Format a millisecond timestamp as UTC, for the backup card. */
export function formatUtc(ms: number | null | undefined): string {
  if (!ms) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/** A short, copy-friendly form of a hash or id. */
export function shortHash(sha256: string, length = 12): string {
  return sha256.slice(0, length);
}

/**
 * Transient toast notification.
 */
export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  const host = byId('toasts');
  const node = el('div', { class: `toast toast-${kind}`, role: 'status' }, [message]);
  host.append(node);

  // Fade out, then remove.
  window.setTimeout(() => {
    node.classList.add('toast-out');
    window.setTimeout(() => node.remove(), 250);
  }, 2400);
}

/** Copy helper that reports the outcome as a toast. */
export async function copyWithFeedback(
  text: string,
  label: string,
  copy: (value: string) => Promise<boolean>,
): Promise<void> {
  const ok = await copy(text);
  toast(ok ? `${label}已复制` : '复制失败，请手动选择', ok ? 'ok' : 'error');
}

/**
 * A read-only text field with a copy button, used for URLs and Markdown.
 */
export function copyRow(
  value: string,
  onCopy: (value: string) => void,
  options: { mono?: boolean } = {},
): HTMLElement {
  const input = el('input', {
    class: options.mono ? 'copy-input mono' : 'copy-input',
    readonly: true,
    value,
    spellcheck: false,
  }) as HTMLInputElement;

  // Clicking the field selects everything, for manual copying.
  input.addEventListener('focus', () => input.select());

  const button = el('button', {
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '复制',
  });
  button.addEventListener('click', () => {
    onCopy(input.value);
    input.select();
  });

  return el('div', { class: 'copy-row' }, [input, button]);
}
