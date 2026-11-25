import { describe, expect, it } from 'vitest';
import { checkPhotoFile, MAX_PHOTO_BYTES, moveId, type Photo, variantUrl } from '../src/lib/photos';

describe('checkPhotoFile', () => {
  it('accepts JPEG, PNG and WebP up to 10 MB', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(checkPhotoFile({ type, size: MAX_PHOTO_BYTES })).toBeUndefined();
    }
  });
  it('turns away other types, empty files and files over 10 MB', () => {
    expect(checkPhotoFile({ type: 'image/gif', size: 10 })).toMatch(/JPEG, PNG or WebP/);
    expect(checkPhotoFile({ type: 'image/heic', size: 10 })).toMatch(/JPEG, PNG or WebP/);
    expect(checkPhotoFile({ type: 'image/png', size: 0 })).toMatch(/empty/);
    expect(checkPhotoFile({ type: 'image/png', size: MAX_PHOTO_BYTES + 1 })).toMatch(/10 MB/);
  });
});

describe('moveId', () => {
  it('moves a photo one place earlier or later', () => {
    expect(moveId(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
  });
  it('leaves the order alone at either end', () => {
    expect(moveId(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveId(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

describe('variantUrl', () => {
  const photo: Photo = {
    id: 'p',
    position: 0,
    status: 'PENDING',
    width: 1280,
    height: 1280,
    variants: [
      { size: 1280, url: 'big' },
      { size: 320, url: 'small' },
      { size: 640, url: 'mid' },
    ],
  };
  it('picks the smallest size that is big enough', () => {
    expect(variantUrl(photo, 320)).toBe('small');
    expect(variantUrl(photo, 400)).toBe('mid');
  });
  it('falls back to the largest', () => {
    expect(variantUrl(photo, 4000)).toBe('big');
  });
});
