/** Optional browser-generated preview; original bytes and links stay intact. */
const MAX_SIDE = 384;
export async function makeThumbnail(source: Blob | HTMLImageElement): Promise<File | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bitmap: ImageBitmap | undefined;
  try {
    // Native resizing reduces decoded bitmap memory for large images.
    bitmap = await createImageBitmap(source, { resizeWidth: MAX_SIDE, resizeQuality: 'medium' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.78));
    if (!blob || blob.size > 256 * 1024) return null;
    const extension = blob.type === 'image/webp' ? 'webp' : 'png';
    return new File([blob], `preview.${extension}`, { type: blob.type });
  } catch {
    // Unsupported image codecs or canvas limits must not prevent uploading.
    return null;
  } finally {
    bitmap?.close();
  }
}
