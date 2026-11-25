/**
 * Photo rules the browser checks before uploading (ADR-0024). The profile service checks them
 * again and re-makes every photo without its hidden data.
 */
export const MAX_PHOTOS = 6;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface Photo {
  id: string;
  position: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  width: number;
  height: number;
  variants: { size: number; url: string }[];
}

/** A plain-language reason a file cannot be used, or undefined when it can. */
export function checkPhotoFile(file: { type: string; size: number }): string | undefined {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) {
    return 'Choose a JPEG, PNG or WebP photo.';
  }
  if (file.size === 0) return 'That file is empty. Choose another photo.';
  if (file.size > MAX_PHOTO_BYTES) return 'That photo is over 10 MB. Choose a smaller one.';
  return undefined;
}

/** The photo ids with one moved earlier (-1) or later (+1); unchanged at either end. */
export function moveId(ids: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  const next = [...ids];
  if (target < 0 || target >= next.length) return next;
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

/** The smallest size that is at least `want` pixels, for thumbnails. */
export function variantUrl(photo: Photo, want: number): string | undefined {
  const sorted = [...photo.variants].sort((a, b) => a.size - b.size);
  return (sorted.find((v) => v.size >= want) ?? sorted.at(-1))?.url;
}
