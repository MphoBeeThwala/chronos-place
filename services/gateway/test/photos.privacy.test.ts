import { PhotoModeration } from '@chronos/contracts/profile';
import { createLogger } from '@chronos/logger';
import { usePrivacyHarness } from '@chronos/privacy-harness/vitest';
import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountStatus, FakeIdentity, GrpcFailure } from './support/fake-identity.js';
import { FakeProfile } from './support/fake-profile.js';
import { gql, startGateway, type TestGateway } from './support/gateway.js';

/**
 * Signed upload and view links pass through the gateway in responses. They work like passwords
 * until they expire, so they must never reach a log line, on success or failure (ADR-0024).
 */
describe('photo privacy at the gateway', () => {
  const privacy = usePrivacyHarness();
  const identity = new FakeIdentity();
  const profile = new FakeProfile();
  const member = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const photoId = 'ffffffff-ffff-4fff-8fff-000000000001';
  let gateway: TestGateway;

  beforeAll(async () => {
    await Promise.all([identity.start(), profile.start()]);
    identity.statuses.set(member, AccountStatus.ACCOUNT_STATUS_ACTIVE);
    gateway = await startGateway(identity, {
      profile,
      logger: createLogger({
        service: 'gateway',
        level: 'trace',
        destination: {
          write: (line: string) => {
            privacy.logs.destination.write(line);
          },
        },
      }),
    });
  });

  afterAll(async () => {
    await gateway.service.shutdown('test');
    await Promise.all([identity.stop(), profile.stop()]);
  });

  it('never logs signed links', async () => {
    const signature = 'X-Amz-Signature=synthetic0123456789abcdef';
    const uploadUrl = `https://storage.test/uploads/u?${signature}`;
    const viewUrl = `https://storage.test/photos/p/640.webp?${signature}`;
    const photo = {
      id: photoId,
      position: 0,
      moderation: PhotoModeration.PHOTO_MODERATION_APPROVED,
      width: 900,
      height: 700,
      variants: [{ size: 640, url: viewUrl }],
    };
    profile.handlers.set('createPhotoUpload', () => ({
      uploadId: photoId,
      uploadUrl,
      expiresAt: new Date(),
    }));
    profile.handlers.set('completePhotoUpload', () => ({ photo }));
    profile.handlers.set('reorderPhotos', () => {
      throw new GrpcFailure(status.INTERNAL, `storage failed at ${viewUrl}`);
    });
    const auth = { cookie: `chronos_access=${await identity.token(member)}` };

    const started = await gql(
      gateway.url,
      'mutation { createPhotoUpload(contentType: "image/jpeg", byteLength: 1000) { uploadUrl } }',
      auth,
    );
    expect(JSON.stringify(started.body)).toContain(signature);
    const done = await gql(
      gateway.url,
      `mutation { completePhotoUpload(uploadId: "${photoId}") { url } }`,
      auth,
    );
    expect(JSON.stringify(done.body)).toContain(signature);
    // A failure whose internal text holds a link: the client and the logs see neither.
    const failed = await gql(
      gateway.url,
      `mutation { reorderPhotos(photoIds: ["${photoId}"]) { id } }`,
      auth,
    );
    expect(JSON.stringify(failed.body)).not.toContain('storage.test');

    // The gateway logs little on these paths; whatever it does log, including any failure, is
    // scanned here.
    for (const line of privacy.logs.texts()) {
      expect(line).not.toContain('X-Amz-');
      expect(line).not.toContain('storage.test');
    }
  });
});
