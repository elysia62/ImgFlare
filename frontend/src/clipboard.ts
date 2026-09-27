/**
 * Clipboard helpers.
 *
 * Nothing is ever copied automatically — the spec is explicit that the clipboard
 * is only written when the user presses a "copy" button.
 */

/** Copy text, returning whether it succeeded. */
export async function copyText(text: string): Promise<boolean> {
  // The async Clipboard API needs a secure context and (in some browsers) a
  // user gesture. Both hold here, but fall back just in case.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  return copyViaTextarea(text);
}

/** Legacy `document.execCommand("copy")` path. */
function copyViaTextarea(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  let ok = false;
  try {
    textarea.select();
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return ok;
}
