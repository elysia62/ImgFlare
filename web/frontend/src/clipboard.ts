/** Clipboard writes initiated by the panel copy buttons. */

/** Copy text, returning whether it succeeded. */
export async function copyText(text: string): Promise<boolean> {
  if (!window.isSecureContext || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
