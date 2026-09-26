import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { MediaPolicyService } from './media-policy.service.js';
import type { MediaRepository } from '../media.repository.js';
import type { MediaPurpose } from '@prisma/client';

function makeRepo(pendingCount = 0): MediaRepository {
  return {
    countPendingForUser: vi.fn(async () => pendingCount),
  } as unknown as MediaRepository;
}

describe('MediaPolicyService', () => {
  let service: MediaPolicyService;

  beforeEach(() => {
    service = new MediaPolicyService(makeRepo(0));
  });

  describe('validateUploadRequest', () => {
    it('passes for valid AVATAR upload', async () => {
      const policy = await service.validateUploadRequest(
        'user_1',
        'AVATAR',
        'image/jpeg',
        2 * 1024 * 1024,
      );
      expect(policy.purpose).toBe('AVATAR');
    });

    it('passes for valid COVER_PHOTO upload', async () => {
      const policy = await service.validateUploadRequest(
        'user_1',
        'COVER_PHOTO',
        'image/webp',
        5 * 1024 * 1024,
      );
      expect(policy.purpose).toBe('COVER_PHOTO');
    });

    it('throws BadRequestException for disallowed MIME type', async () => {
      await expect(
        service.validateUploadRequest('user_1', 'AVATAR', 'video/mp4', 1024),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when file exceeds max size', async () => {
      await expect(
        service.validateUploadRequest('user_1', 'AVATAR', 'image/jpeg', 10 * 1024 * 1024),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows listing videos up to 100 MB and rejects larger files', async () => {
      const maxVideoBytes = 100 * 1024 * 1024;
      await expect(
        service.validateUploadRequest('user_1', 'LISTING_VIDEO', 'video/mp4', maxVideoBytes),
      ).resolves.toMatchObject({ purpose: 'LISTING_VIDEO', maxBytes: maxVideoBytes });
      await expect(
        service.validateUploadRequest('user_1', 'LISTING_VIDEO', 'video/mp4', maxVideoBytes + 1),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws HttpException with TOO_MANY_REQUESTS when pending quota exceeded', async () => {
      const svc = new MediaPolicyService(makeRepo(99));
      await expect(
        svc.validateUploadRequest('user_1', 'AVATAR', 'image/jpeg', 1024),
      ).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    });

    it('allows PDF for STUDENT_ID purpose', async () => {
      const policy = await service.validateUploadRequest(
        'user_1',
        'STUDENT_ID',
        'application/pdf',
        5 * 1024 * 1024,
      );
      expect(policy.deliveryType).toBe('AUTHENTICATED');
    });

    it('throws BadRequestException for unknown purpose', async () => {
      await expect(
        service.validateUploadRequest(
          'user_1',
          'UNKNOWN_PURPOSE' as MediaPurpose,
          'image/jpeg',
          1024,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('requiresSignedUrl', () => {
    it.each<[MediaPurpose, boolean]>([
      ['AVATAR', false],
      ['COVER_PHOTO', false],
      ['LISTING_PHOTO', false],
      ['LISTING_VIDEO', false],
      ['STUDENT_ID', true],
      ['PROOF_OF_STUDENTSHIP', true],
      ['PROOF_OF_LICENSE', true],
      ['CONTRACT_DOCUMENT', true],
    ])('%s → requiresSignedUrl = %s', (purpose, expected) => {
      expect(service.requiresSignedUrl(purpose)).toBe(expected);
    });
  });

  describe('assertCanRead', () => {
    it('allows ADMIN to read any asset', () => {
      expect(() =>
        service.assertCanRead('admin_1', 'ADMIN', 'other_user', 'CONTRACT_DOCUMENT'),
      ).not.toThrow();
    });

    it('allows owner to read their own asset', () => {
      expect(() =>
        service.assertCanRead('user_1', 'STUDENT', 'user_1', 'STUDENT_ID'),
      ).not.toThrow();
    });

    it('throws ForbiddenException for non-owner reading private asset', () => {
      expect(() =>
        service.assertCanRead('user_2', 'STUDENT', 'user_1', 'CONTRACT_DOCUMENT'),
      ).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for non-owner reading authenticated asset', () => {
      expect(() =>
        service.assertCanRead('user_2', 'LANDLORD', 'user_1', 'STUDENT_ID'),
      ).toThrow(ForbiddenException);
    });

    it('does not throw for non-owner reading public asset', () => {
      expect(() =>
        service.assertCanRead('user_2', 'STUDENT', 'user_1', 'LISTING_PHOTO'),
      ).not.toThrow();
    });
  });

  describe('validateTransformation', () => {
    it('returns undefined for no transformation', () => {
      expect(service.validateTransformation(undefined)).toBeUndefined();
    });

    it('returns the name for known transformations', () => {
      expect(service.validateTransformation('listing_card')).toBe('listing_card');
    });

    it('throws BadRequestException for unknown transformation', () => {
      expect(() => service.validateTransformation('raw_transform_string')).toThrow(
        BadRequestException,
      );
    });
  });
});
