export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|ico|svg|jxl|heic|heif|tiff?)$/i;
const PASTED_IMAGE_NAME = new RegExp('^image' + IMAGE_EXT.source, 'i');

export async function sha256Hex(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前页面不是 HTTPS，无法计算文件校验值');
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function renamePastedImage(file: File): File {
  if (file.name !== 'blob' && !PASTED_IMAGE_NAME.test(file.name)) return file;
  const type = file.type.split('/')[1] || 'png';
  const ext = ({ jpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico' } as Record<string, string>)[type] ?? type;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return new File([file], `pasted-${stamp}.${ext}`, { type: file.type });
}
