import { DomainError } from '@chronos/service-kit';
import sharp from 'sharp';

/**
 * Photo processing (TASKS M1.6, ADR-0024 decisions b and c). Every photo is decoded and
 * re-encoded from its pixels alone. sharp writes no metadata unless asked to, so EXIF (including
 * GPS), XMP, IPTC, comments, embedded thumbnails and colour profiles never reach storage. The
 * orientation is applied to the pixels first, so photos still appear the right way up.
 */
export const PHOTO_SIZES = [320, 640, 1280] as const;
export type PhotoSize = (typeof PHOTO_SIZES)[number];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 40_000_000;
export const MIN_SHORT_SIDE = 200;
const WEBP_QUALITY = 80;

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AcceptedType = (typeof ACCEPTED_TYPES)[number];

const UNUSABLE = 'That photo could not be used. Try a JPEG, PNG or WebP photo.';

/** The real format, from the first bytes; never the type the client claimed. */
export function sniffType(data: Buffer): AcceptedType | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

export interface ProcessedPhoto {
  /** Of the largest variant. */
  width: number;
  height: number;
  variants: { size: PhotoSize; data: Buffer }[];
}

/** Turns an upload into stripped WebP variants, or refuses it with a fixed message. */
export async function processPhoto(input: Buffer): Promise<ProcessedPhoto> {
  if (input.length === 0 || input.length > MAX_UPLOAD_BYTES || !sniffType(input)) {
    throw new DomainError('invalid_argument', UNUSABLE);
  }
  try {
    // One frame only, and a pixel cap checked before decoding (decompression bombs).
    const source = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', pages: 1 });
    const meta = await source.metadata();
    const width = meta.autoOrient.width;
    const height = meta.autoOrient.height;
    if (
      !['jpeg', 'png', 'webp'].includes(meta.format) ||
      (meta.pages ?? 1) > 1 ||
      Math.min(width, height) < MIN_SHORT_SIDE
    ) {
      throw new DomainError('invalid_argument', UNUSABLE);
    }
    const upright = source.rotate().toColourspace('srgb');
    const variants = await Promise.all(
      PHOTO_SIZES.map(async (size) => ({
        size,
        data: await upright
          .clone()
          .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: WEBP_QUALITY })
          .toBuffer(),
      })),
    );
    const largest = await sharp(variants[variants.length - 1]?.data).metadata();
    return { width: largest.width, height: largest.height, variants };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    // libvips messages can describe the file; never pass them on.
    throw new DomainError('invalid_argument', UNUSABLE);
  }
}
