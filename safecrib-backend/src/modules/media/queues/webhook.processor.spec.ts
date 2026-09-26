import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MediaWebhookProcessor } from './webhook.processor.js';
import type { MediaRepository } from '../media.repository.js';
import type { StorageProvider } from '../providers/storage-provider.interface.js';
import type { ConfigService } from '@nestjs/config';
import type { Media } from '@prisma/client';

function makeMedia(overrides: Partial<Media> = {}): Media {
  return {
    id: 'media_1',
    ownerId: 'user_1',
    purpose: 'LISTING_PHOTO',
    resourceType: 'IMAGE',
    deliveryType: 'UPLOAD',
    publicId: 'prod/listings/photo/l1/uuid',
    assetId: null,
    version: null,
    format: null,
    bytes: null,
    width: null,
    height: null,
    durationSec: null,
    etag: null,
    status: 'PENDING',
    failureReason: null,
    idempotencyKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    readyAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeRepo(media: Media | null = null): MediaRepository {
  return {
    findByPublicId: vi.fn(async () => media),
    findByIdempotencyKey: vi.fn(async () => null),
    markReady: vi.fn(async () => makeMedia({ status: 'READY' })),
    markFailed: vi.fn(async () => makeMedia({ status: 'FAILED' })),
    markDeleted: vi.fn(async () => makeMedia({ status: 'DELETED' })),
  } as unknown as MediaRepository;
}

function makeStorage(): StorageProvider {
  return {
    deleteAsset: vi.fn(async () => ({ result: 'ok' })),
  } as unknown as StorageProvider;
}

function makeConfig(): ConfigService {
  return {
    get: vi.fn(() => 'redis://localhost:6379'),
  } as unknown as ConfigService;
}

describe('MediaWebhookProcessor.process (private method via reflection)', () => {
  let processor: MediaWebhookProcessor;
  let repo: MediaRepository;

  beforeEach(() => {
    repo = makeRepo(makeMedia());
    processor = new MediaWebhookProcessor(repo, makeConfig(), makeStorage());
  });

  // We test the private `process` method directly via cast
  async function callProcess(payload: object) {
    return (processor as any).process(payload);
  }

  describe('upload notification', () => {
    it('marks media READY on upload notification', async () => {
      await callProcess({
        notification_type: 'upload',
        public_id: 'prod/listings/photo/l1/uuid',
        asset_id: 'asset_abc',
        version: 1726780800,
        format: 'jpg',
        bytes: 204800,
        width: 1920,
        height: 1080,
      });

      expect(repo.markReady).toHaveBeenCalledWith(
        'media_1',
        expect.objectContaining({ assetId: 'asset_abc', format: 'jpg' }),
      );
    });

    it('rejects and removes listing videos larger than the policy limit', async () => {
      const storage = makeStorage();
      const videoRepo = makeRepo(
        makeMedia({
          purpose: 'LISTING_VIDEO',
          resourceType: 'VIDEO',
          publicId: 'prod/listings/video/l1/uuid',
        }),
      );
      const proc = new MediaWebhookProcessor(videoRepo, makeConfig(), storage);

      await (proc as any).process({
        notification_type: 'upload',
        public_id: 'prod/listings/video/l1/uuid',
        bytes: 100 * 1024 * 1024 + 1,
      });

      expect(storage.deleteAsset).toHaveBeenCalledWith(
        'prod/listings/video/l1/uuid',
        expect.objectContaining({ resourceType: 'video' }),
      );
      expect(videoRepo.markFailed).toHaveBeenCalledWith('media_1', expect.stringContaining('exceeds'));
      expect(videoRepo.markReady).not.toHaveBeenCalled();
    });

    it('is idempotent: skips if idempotency key already exists', async () => {
      const alreadyReady = makeMedia({ status: 'READY', idempotencyKey: 'asset_abc:1726780800' });
      const idempRepo = makeRepo(makeMedia());
      vi.mocked(idempRepo.findByIdempotencyKey).mockResolvedValue(alreadyReady);
      const proc = new MediaWebhookProcessor(idempRepo, makeConfig(), makeStorage());

      await (proc as any).process({
        notification_type: 'upload',
        public_id: 'prod/listings/photo/l1/uuid',
        asset_id: 'asset_abc',
        version: 1726780800,
      });

      expect(idempRepo.markReady).not.toHaveBeenCalled();
    });

    it('skips when media record not found (different env or orphan)', async () => {
      const missingRepo = makeRepo(null);
      const proc = new MediaWebhookProcessor(missingRepo, makeConfig(), makeStorage());

      await expect(
        (proc as any).process({
          notification_type: 'upload',
          public_id: 'unknown/path',
          asset_id: 'x',
          version: 1,
        }),
      ).resolves.not.toThrow();

      expect(missingRepo.markReady).not.toHaveBeenCalled();
    });

    it('skips when media is already READY (duplicate delivery)', async () => {
      const readyRepo = makeRepo(makeMedia({ status: 'READY' }));
      const proc = new MediaWebhookProcessor(readyRepo, makeConfig(), makeStorage());

      await (proc as any).process({
        notification_type: 'upload',
        public_id: 'prod/listings/photo/l1/uuid',
        asset_id: 'asset_abc',
        version: 1726780800,
      });

      expect(readyRepo.markReady).not.toHaveBeenCalled();
    });
  });

  describe('error notification', () => {
    it('marks media FAILED on error notification', async () => {
      await callProcess({
        notification_type: 'error',
        public_id: 'prod/listings/photo/l1/uuid',
        error: { message: 'file too large' },
      });

      expect(repo.markFailed).toHaveBeenCalledWith('media_1', expect.any(String));
    });
  });

  describe('delete notification', () => {
    it('marks media DELETED on delete notification', async () => {
      await callProcess({
        notification_type: 'delete',
        public_id: 'prod/listings/photo/l1/uuid',
      });

      expect(repo.markDeleted).toHaveBeenCalledWith('media_1');
    });
  });

  describe('unknown notification types', () => {
    it('does not throw for unknown notification_type', async () => {
      await expect(
        callProcess({ notification_type: 'moderation', public_id: 'some/id' }),
      ).resolves.not.toThrow();
    });
  });
});
