import { DomainError } from '@chronos/service-kit';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PHOTO_SIZES, processPhoto, sniffType } from '../src/photos/process.js';
import { exifBlock, hasGps } from './support/exif.js';

/** Synthetic GPS: a made-up point, not anyone's location (CLAUDE.md rule 6). */
const GPS = {
  GPSLatitudeRef: 'S',
  GPSLatitude: '26/1 12/1 1440/100',
  GPSLongitudeRef: 'E',
  GPSLongitude: '28/1 2/1 4800/100',
};
const XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="26,12.24S"/></rdf:RDF></x:xmpmeta>';

/**
 * A photo as a phone would send it: GPS block, camera make and model, XMP with a location, and an
 * orientation of 6 (rotate 90 degrees). Drawn with a stripe so orientation can be checked.
 */
async function phonePhoto(format: 'jpeg' | 'png' | 'webp', width = 1600, height = 1200) {
  const stripe = Buffer.from(
    `<svg width="${String(width)}" height="${String(height)}"><rect width="${String(width)}" height="${String(height / 10)}" fill="#c0392b"/></svg>`,
  );
  return sharp({ create: { width, height, channels: 3, background: '#88aacc' } })
    .composite([{ input: stripe, top: 0, left: 0 }])
    .withExif({ IFD0: { Make: 'SynthCam', Model: 'Probe 1' }, IFD3: GPS })
    .withMetadata({ orientation: 6 })
    .withXmp(XMP)
    .toFormat(format)
    .toBuffer();
}

const FORBIDDEN = ['Exif\0\0', 'SynthCam', 'Probe 1', 'xmpmeta', 'GPSLatitude', '26,12.24S'];

describe('stripping metadata (M1.6 AC: GPS absent in stored images)', () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    it(`leaves no GPS, EXIF, XMP or colour profile in any size made from a ${format}`, async () => {
      const input = await phonePhoto(format);
      // Positive control: the reader does find GPS and XMP in the upload.
      expect(hasGps(input)).toBe(true);
      // PNG keeps XMP compressed, so check through the decoder rather than the raw bytes.
      expect((await sharp(input).metadata()).xmp).toBeDefined();

      const { variants } = await processPhoto(input);
      expect(variants.map((v) => v.size)).toEqual([...PHOTO_SIZES]);
      for (const { data } of variants) {
        expect(sniffType(data)).toBe('image/webp');
        expect(hasGps(data)).toBe(false);
        expect(exifBlock(data)).toBeUndefined();
        const meta = await sharp(data).metadata();
        expect(meta.exif).toBeUndefined();
        expect(meta.xmp).toBeUndefined();
        expect(meta.iptc).toBeUndefined();
        expect(meta.icc).toBeUndefined();
        for (const text of FORBIDDEN)
          expect(data.includes(Buffer.from(text, 'latin1'))).toBe(false);
      }
    });
  }
});

describe('sizes and orientation (decision c)', () => {
  it('applies the orientation and fits each size on the long side without upscaling', async () => {
    // 1600x1200 with orientation 6 is a 1200x1600 portrait once upright.
    const { width, height, variants } = await processPhoto(await phonePhoto('jpeg'));
    expect({ width, height }).toEqual({ width: 960, height: 1280 });
    const dims = await Promise.all(variants.map(async (v) => sharp(v.data).metadata()));
    expect(dims.map((d) => [d.width, d.height])).toEqual([
      [240, 320],
      [480, 640],
      [960, 1280],
    ]);
    // The red stripe drawn along the top of the sensor is now on the right-hand side.
    const { data, info } = await sharp(variants[0]?.data)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => data[(y * info.width + x) * info.channels] ?? 0;
    expect(pixel(info.width - 2, info.height / 2)).toBeGreaterThan(150);
    expect(pixel(2, info.height / 2)).toBeLessThan(150);
  });

  it('never makes a small photo larger', async () => {
    const small = await sharp({
      create: { width: 300, height: 250, channels: 3, background: '#fff' },
    })
      .jpeg()
      .toBuffer();
    const { variants } = await processPhoto(small);
    for (const v of variants.slice(1)) {
      const meta = await sharp(v.data).metadata();
      expect([meta.width, meta.height]).toEqual([300, 250]);
    }
  });
});

describe('what is refused (decision b)', () => {
  const refused = async (input: Buffer) => {
    const error = await processPhoto(input).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).message).toBe(
      'That photo could not be used. Try a JPEG, PNG or WebP photo.',
    );
  };

  it('refuses files that are not JPEG, PNG or WebP, whatever they claim to be', async () => {
    await refused(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    await refused(
      await sharp({ create: { width: 400, height: 400, channels: 3, background: '#fff' } })
        .gif()
        .toBuffer(),
    );
    await refused(Buffer.alloc(0));
  });

  it('refuses a truncated or corrupt file', async () => {
    const photo = await phonePhoto('jpeg');
    await refused(photo.subarray(0, Math.floor(photo.length / 3)));
  });

  it('refuses photos under 200 px on the short side', async () => {
    await refused(
      await sharp({ create: { width: 800, height: 150, channels: 3, background: '#fff' } })
        .png()
        .toBuffer(),
    );
  });

  it('refuses more than 40 megapixels before decoding them', async () => {
    const huge = await sharp({
      create: { width: 8000, height: 5200, channels: 3, background: '#fff' },
    })
      .jpeg({ quality: 10 })
      .toBuffer();
    await refused(huge);
  });

  it('refuses an animated image', async () => {
    const frame = (colour: string) =>
      sharp({ create: { width: 300, height: 300, channels: 3, background: colour } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame('#f00'), await frame('#00f')], {
      join: { animated: true },
    })
      .webp()
      .toBuffer();
    expect((await sharp(animated, { pages: -1 }).metadata()).pages).toBe(2);
    await refused(animated);
  });
});
