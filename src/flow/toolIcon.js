// Turns whatever image the user picks into a small square PNG data URL.
//
// The downscale happens here, in the browser, on purpose: the icon travels
// inline in the tool payload and is stored as text, so sending the original
// file (often several MB) would be wasteful and would trip the API ceiling
// (settings.max_tool_icon_bytes). Keep this in sync with that limit.

export const TOOL_ICON_SIZE = 64;

// Ceiling for the file the user picks, before downscaling. Anything larger is
// almost certainly a mistake (a photo, a screenshot) rather than an icon.
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('that file is not a readable image'));
    img.src = src;
  });
}

// Fits the image inside a transparent square, keeping its aspect ratio, so a
// wide logo is letterboxed instead of stretched.
export async function readToolIcon(file) {
  if (!file) return null;
  if (!/^image\//.test(file.type || '')) {
    throw new Error('pick an image file (PNG, JPEG, WebP, SVG…)');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('image above ' + Math.round(MAX_SOURCE_BYTES / 1024 / 1024) + ' MB');
  }

  const source = await readAsDataUrl(file);
  const img = await loadImage(source);
  const size = TOOL_ICON_SIZE;
  const scale = Math.min(size / (img.width || size), size / (img.height || size), 1);
  const w = Math.max(1, Math.round((img.width || size) * scale));
  const h = Math.max(1, Math.round((img.height || size) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);

  // Always PNG: the API rejects SVG (it is markup rendered into the page) and
  // this way a transparent background survives.
  return canvas.toDataURL('image/png');
}
