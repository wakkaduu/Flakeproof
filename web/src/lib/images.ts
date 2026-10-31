import type { ShotImage } from '../api';

/** Wide enough for small chat text to stay readable to the model, small enough to upload on a phone connection. */
const MAX_WIDTH = 900;
const THUMB_WIDTH = 96;

export interface PreparedImage { image: ShotImage; thumb: string }

function draw(bitmap: ImageBitmap, width: number): HTMLCanvasElement {
  const scale = Math.min(1, width / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = '#fff'; // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Shrinks a screenshot on the device and returns it as base64 JPEG plus a tiny data-URL thumbnail
 * (a data URL, because the page's Content-Security-Policy only allows `img-src 'self' data:`).
 * Throws when the browser cannot decode the file (for example a HEIC photo).
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const full = draw(bitmap, MAX_WIDTH);
    const dataUrl = full.toDataURL('image/jpeg', 0.8);
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (!data) throw new Error('empty image');
    return { image: { mimeType: 'image/jpeg', data }, thumb: draw(bitmap, THUMB_WIDTH).toDataURL('image/jpeg', 0.6) };
  } finally {
    bitmap.close();
  }
}
