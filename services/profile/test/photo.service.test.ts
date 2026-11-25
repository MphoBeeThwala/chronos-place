import { DomainError } from '@chronos/service-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ABANDONED_GRACE_MS,
  mediaKey,
  UPLOAD_TTL_SECONDS,
  uploadKey,
} from '../src/photos/photo.service.js';
import { PHOTO_SIZES } from '../src/photos/process.js';
import { photoSetup, syntheticJpeg } from './support/photo-fakes.js';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'ok';
};

describe('PhotoService', () => {
  let clock: Date;
  let ctx: ReturnType<typeof photoSetup>;

  /** Issues a link, "uploads" through it, completes it. */
  const addPhoto = async (accountId = ME) => {
    const data = await syntheticJpeg();
    const { uploadId } = await ctx.service.createUpload(accountId, 'image/jpeg', data.length);
    ctx.storage.uploads.set(uploadKey(uploadId), data);
    return ctx.service.completeUpload(accountId, uploadId);
  };

  beforeEach(() => {
    clock = new Date('2026-11-25T10:00:00Z');
    ctx = photoSetup({ now: () => clock });
    ctx.photos.profiles.add(ME);
    ctx.photos.profiles.add(OTHER);
  });

  describe('createUpload', () => {
    it('signs a link for the exact type and length, valid 5 minutes', async () => {
      const result = await ctx.service.createUpload(ME, 'image/png', 1234);
      expect(ctx.storage.issued).toEqual([
        { key: uploadKey(result.uploadId), contentType: 'image/png', byteLength: 1234 },
      ]);
      expect(result.expiresAt.getTime() - clock.getTime()).toBe(UPLOAD_TTL_SECONDS * 1000);
      expect(result.uploadUrl).toContain('expires=300');
    });

    it('refuses other types and sizes outside 1 byte to 10 MB', async () => {
      for (const [type, length] of [
        ['image/gif', 100],
        ['image/heic', 100],
        ['image/jpeg', 0],
        ['image/jpeg', 10 * 1024 * 1024 + 1],
        ['image/jpeg', 1.5],
      ] as const) {
        expect(await code(ctx.service.createUpload(ME, type, length))).toBe('invalid_argument');
      }
      expect(ctx.storage.issued).toHaveLength(0);
    });

    it('needs a profile', async () => {
      ctx.photos.profiles.delete(ME);
      expect(await code(ctx.service.createUpload(ME, 'image/jpeg', 100))).toBe('not_found');
    });

    it('counts open uploads against the limit of 6, but not expired ones', async () => {
      for (let i = 0; i < 6; i += 1) await ctx.service.createUpload(ME, 'image/jpeg', 100);
      expect(await code(ctx.service.createUpload(ME, 'image/jpeg', 100))).toBe(
        'failed_precondition',
      );
      clock = new Date(clock.getTime() + UPLOAD_TTL_SECONDS * 1000 + 1);
      expect(await code(ctx.service.createUpload(ME, 'image/jpeg', 100))).toBe('ok');
    });
  });

  describe('completeUpload', () => {
    it('stores three re-encoded sizes under random keys and empties quarantine', async () => {
      const photo = await addPhoto();
      expect(photo.position).toBe(0);
      expect([photo.width, photo.height]).toEqual([800, 600]);
      for (const size of PHOTO_SIZES) {
        const stored = ctx.storage.media.get(mediaKey(photo.id, size));
        expect(stored?.subarray(8, 12).toString('latin1')).toBe('WEBP');
      }
      expect(ctx.storage.uploads.size).toBe(0);
      expect(ctx.photos.uploads.size).toBe(0);
      expect(photo.variants.map((v) => v.size)).toEqual([320, 640, 800]);
      expect(photo.variants[0]?.url).toContain('expires=3600');
    });

    it('applies the moderator decision', async () => {
      ctx.moderator.status = 'pending';
      const photo = await addPhoto();
      expect(photo.moderation).toBe('pending');
      expect(ctx.moderator.reviewed).toEqual([{ id: photo.id, accountId: ME }]);
    });

    it("cannot complete another member's upload", async () => {
      const data = await syntheticJpeg();
      const { uploadId } = await ctx.service.createUpload(OTHER, 'image/jpeg', data.length);
      ctx.storage.uploads.set(uploadKey(uploadId), data);
      expect(await code(ctx.service.completeUpload(ME, uploadId))).toBe('not_found');
      expect(ctx.storage.uploads.size).toBe(1);
    });

    it('lets the member retry while nothing has arrived yet', async () => {
      const { uploadId } = await ctx.service.createUpload(ME, 'image/jpeg', 100);
      expect(await code(ctx.service.completeUpload(ME, uploadId))).toBe('failed_precondition');
      expect(ctx.photos.uploads.has(uploadId)).toBe(true);
    });

    it('discards a file that is not a photo, keeping nothing', async () => {
      const junk = Buffer.from('this is not an image, just synthetic bytes');
      const { uploadId } = await ctx.service.createUpload(ME, 'image/jpeg', junk.length);
      ctx.storage.uploads.set(uploadKey(uploadId), junk);
      expect(await code(ctx.service.completeUpload(ME, uploadId))).toBe('invalid_argument');
      expect(ctx.storage.uploads.size).toBe(0);
      expect(ctx.photos.uploads.size).toBe(0);
      expect(ctx.storage.media.size).toBe(0);
    });

    it('discards a photo that fails processing (too small)', async () => {
      const tiny = await syntheticJpeg(150, 150);
      const { uploadId } = await ctx.service.createUpload(ME, 'image/jpeg', tiny.length);
      ctx.storage.uploads.set(uploadKey(uploadId), tiny);
      expect(await code(ctx.service.completeUpload(ME, uploadId))).toBe('invalid_argument');
      expect(ctx.storage.uploads.size + ctx.storage.media.size + ctx.photos.uploads.size).toBe(0);
    });

    it('refuses an expired upload and discards it', async () => {
      const data = await syntheticJpeg();
      const { uploadId } = await ctx.service.createUpload(ME, 'image/jpeg', data.length);
      ctx.storage.uploads.set(uploadKey(uploadId), data);
      clock = new Date(clock.getTime() + UPLOAD_TTL_SECONDS * 1000 + ABANDONED_GRACE_MS + 1);
      expect(await code(ctx.service.completeUpload(ME, uploadId))).toBe('failed_precondition');
      expect(ctx.storage.uploads.size + ctx.photos.uploads.size).toBe(0);
    });

    it('removes the stored sizes when the profile is already full', async () => {
      const data = await syntheticJpeg();
      const { uploadId } = await ctx.service.createUpload(ME, 'image/jpeg', data.length);
      ctx.storage.uploads.set(uploadKey(uploadId), data);
      // Six photos arrive another way (e.g. a second device) before this upload completes.
      for (let i = 0; i < 6; i += 1) {
        await ctx.photos.add({
          id: `00000000-0000-4000-8000-00000000000${String(i)}`,
          accountId: ME,
          width: 800,
          height: 600,
          moderation: 'approved',
        });
      }
      expect(await code(ctx.service.completeUpload(ME, uploadId))).toBe('failed_precondition');
      expect(ctx.storage.media.size).toBe(0);
      expect(ctx.storage.uploads.size).toBe(0);
    });
  });

  describe('order, deletion and visibility', () => {
    it('reorders to exactly the member’s photos', async () => {
      const a = await addPhoto();
      const b = await addPhoto();
      const c = await addPhoto();
      const reordered = await ctx.service.reorder(ME, [c.id, a.id, b.id]);
      expect(reordered.map((p) => [p.id, p.position])).toEqual([
        [c.id, 0],
        [a.id, 1],
        [b.id, 2],
      ]);
      expect(await code(ctx.service.reorder(ME, [a.id, b.id]))).toBe('invalid_argument');
      expect(await code(ctx.service.reorder(ME, [a.id, a.id, b.id]))).toBe('invalid_argument');
      const theirs = await addPhoto(OTHER);
      expect(await code(ctx.service.reorder(ME, [a.id, b.id, theirs.id]))).toBe('invalid_argument');
    });

    it('deletes every size and closes the gap', async () => {
      const a = await addPhoto();
      const b = await addPhoto();
      const left = await ctx.service.remove(ME, a.id);
      expect(left.map((p) => [p.id, p.position])).toEqual([[b.id, 0]]);
      for (const size of PHOTO_SIZES)
        expect(ctx.storage.media.has(mediaKey(a.id, size))).toBe(false);
      expect(await code(ctx.service.remove(OTHER, b.id))).toBe('not_found');
    });

    it('shows other members approved photos only', async () => {
      const shown = await addPhoto();
      ctx.moderator.status = 'pending';
      await addPhoto();
      ctx.moderator.status = 'rejected';
      await addPhoto();
      const visible = await ctx.service.approvedFor([ME, OTHER]);
      expect(visible.get(ME)?.map((p) => p.id)).toEqual([shown.id]);
      expect(visible.has(OTHER)).toBe(false);
      expect(await ctx.service.listOwn(ME)).toHaveLength(3);
    });
  });

  it('clears quarantine of uploads abandoned past the grace period', async () => {
    const kept = await ctx.service.createUpload(ME, 'image/jpeg', 10);
    clock = new Date(clock.getTime() + 60_000);
    const fresh = await ctx.service.createUpload(ME, 'image/jpeg', 10);
    for (const id of [kept.uploadId, fresh.uploadId]) {
      ctx.storage.uploads.set(uploadKey(id), Buffer.from('partial'));
    }
    clock = new Date(kept.expiresAt.getTime() + ABANDONED_GRACE_MS + 30_000);
    expect(await ctx.service.clearAbandoned()).toBe(1);
    expect([...ctx.photos.uploads.keys()]).toEqual([fresh.uploadId]);
    expect([...ctx.storage.uploads.keys()]).toEqual([uploadKey(fresh.uploadId)]);
  });
});
