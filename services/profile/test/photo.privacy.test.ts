import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { uploadKey } from '../src/photos/photo.service.js';
import { photoSetup } from './support/photo-fakes.js';

const ME = '99999999-9999-4999-8999-999999999991';

/**
 * Photos carry metadata members never see: a caption a phone app wrote, a location, a camera
 * name (ADR-0024). None of it may reach a log line or the stored image (CLAUDE.md rules 3 and 8),
 * and logs carry ids only — never a signed link, which works like a password until it expires.
 */
describe('photo privacy', () => {
  const privacy = usePrivacyHarness();

  it('keeps photo metadata and signed links out of logs and stored images', async () => {
    const { service, storage, photos } = photoSetup({
      destination: {
        write: (line: string) => {
          privacy.logs.destination.write(line);
        },
      },
    });
    photos.profiles.add(ME);
    const health = privacy.markers.healthText();
    const email = privacy.markers.email();
    const photo = await sharp({
      create: { width: 900, height: 700, channels: 3, background: '#557799' },
    })
      .withExif({
        IFD0: { ImageDescription: health, Artist: email },
        IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '26/1 12/1 1440/100' },
      })
      .withXmp(
        `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:description="${health}"/></rdf:RDF></x:xmpmeta>`,
      )
      .jpeg()
      .toBuffer();
    expect(photo.includes(health)).toBe(true);

    // A good upload, a refused one, a reorder, a delete and a sweep: every log path.
    const ok = await service.createUpload(ME, 'image/jpeg', photo.length);
    storage.uploads.set(uploadKey(ok.uploadId), photo);
    const added = await service.completeUpload(ME, ok.uploadId);
    const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(health)]);
    const bad = await service.createUpload(ME, 'image/jpeg', junk.length);
    storage.uploads.set(uploadKey(bad.uploadId), junk);
    await service.completeUpload(ME, bad.uploadId).catch(() => undefined);
    await service.reorder(ME, [added.id]);
    await service.remove(ME, added.id);
    await service.clearAbandoned();

    for (const stored of storage.media.values()) {
      expect(stored.includes(health)).toBe(false);
      expect(stored.includes(email)).toBe(false);
    }
    const lines = privacy.logs.texts();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/X-Amz-|https?:\/\/|image\/jpeg|uploads\//);
      expect(line).not.toContain(String(photo.length));
    }
  });
});
