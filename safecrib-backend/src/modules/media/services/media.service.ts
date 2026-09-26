import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Media, MediaPurpose } from '@prisma/client';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../providers/storage-provider.interface.js';
import { MediaPathBuilder } from './media-path-builder.service.js';
import { MediaPolicyService } from './media-policy.service.js';
import { MediaRepository } from '../media.repository.js';
import { PURPOSE_POLICIES } from '../policies/purpose-policies.js';
import {
  MEDIA_WEBHOOK_QUEUE,
  MEDIA_DELETION_QUEUE,
} from '../../../infra/queue/queue.constants.js';
import type {
  RequestUploadSignatureDto,
  ConfirmUploadDto,
  MediaResponse,
  SignedAccessResponse,
} from '../dto/media.dto.js';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider,
    private readonly mediaRepo: MediaRepository,
    private readonly pathBuilder: MediaPathBuilder,
    private readonly policyService: MediaPolicyService,
    @InjectQueue(MEDIA_WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
    @InjectQueue(MEDIA_DELETION_QUEUE) private readonly deletionQueue: Queue,
  ) {}

  /**
   * Step 1 of the upload flow: validate the request, create a PENDING record,
   * and return a signed upload payload for the client to post directly to Cloudinary.
   */
  async requestUploadSignature(
    ownerId: string,
    dto: RequestUploadSignatureDto,
  ): Promise<{ media: MediaResponse; uploadPayload: object }> {
    const policy = await this.policyService.validateUploadRequest(
      ownerId,
      dto.purpose,
      dto.contentType,
      dto.sizeBytes,
    );

    const entityId = dto.entityId ?? ownerId;
    const publicId = this.pathBuilder.buildPublicId(dto.purpose, entityId);
    const folder = this.pathBuilder.buildFolder(dto.purpose, entityId);
    const preset = this.pathBuilder.uploadPresetName(dto.purpose);
    const timestamp = Math.floor(Date.now() / 1000);

    // Context tags for Admin API filtering (non-security, not signed strictly)
    const extraParams: Record<string, string | number> = {
      context: `purpose=${dto.purpose}|owner=${ownerId}`,
    };

    const signed = this.storage.createUploadSignature({
      publicId,
      folder,
      uploadPreset: preset,
      timestamp,
      extraParams,
    });

    // Create the PENDING record before returning the payload
    const media = await this.mediaRepo.create({
      ownerId,
      purpose: dto.purpose,
      resourceType: policy.resourceType,
      deliveryType: policy.deliveryType,
      publicId,
      status: 'PENDING',
    });

    this.logger.log(
      `Upload signature issued: mediaId=${media.id} purpose=${dto.purpose} owner=${ownerId}`,
    );

    return {
      media: this.toResponse(media),
      uploadPayload: {
        signature: signed.signature,
        timestamp: signed.timestamp,
        api_key: signed.apiKey,
        cloud_name: signed.cloudName,
        public_id: signed.publicId,
        folder: signed.folder,
        upload_preset: signed.uploadPreset,
        expires_at: signed.expiresAt,
        ...signed.extra,
      },
    };
  }

  /**
   * Simple direct-upload flow: the client sends the file to the backend, which
   * uploads it to Cloudinary server-side (authenticated with the API secret —
   * no upload preset / signed client payload required) and returns the URL.
   */
  async uploadAsset(
    ownerId: string,
    purpose: MediaPurpose,
    file: Express.Multer.File,
    entityId?: string,
  ): Promise<{ media: MediaResponse; url: string }> {
    if (!file || !file.buffer) {
      throw new BadRequestException('No file provided');
    }

    const policy = this.policyService.getPolicy(purpose);

    if (!policy.allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `Content type "${file.mimetype}" is not allowed for purpose "${purpose}". ` +
          `Allowed: ${policy.allowedMimeTypes.join(', ')}`,
      );
    }

    if (file.size > policy.maxBytes) {
      const maxMB = (policy.maxBytes / (1024 * 1024)).toFixed(0);
      throw new BadRequestException(
        `File size ${file.size} bytes exceeds the ${maxMB} MB limit for ${policy.label}`,
      );
    }

    const targetEntityId = entityId ?? ownerId;
    const publicId = this.pathBuilder.buildPublicId(purpose, targetEntityId);
    const folder = this.pathBuilder.buildFolder(purpose, targetEntityId);

    const uploaded = await this.storage.uploadAsset(file.buffer, file.mimetype, {
      publicId,
      folder,
      resourceType: this.resourceTypeToSdk(policy.resourceType),
      tags: [`purpose=${purpose}`, `owner=${ownerId}`],
      context: { purpose, owner: ownerId },
    });

    const media = await this.mediaRepo.create({
      ownerId,
      purpose,
      resourceType: policy.resourceType,
      deliveryType: policy.deliveryType,
      publicId: uploaded.publicId,
      status: 'READY',
      assetId: uploaded.assetId,
      format: uploaded.format,
      bytes: uploaded.bytes,
      width: uploaded.width,
      height: uploaded.height,
      durationSec: uploaded.durationSec,
      etag: uploaded.etag,
      idempotencyKey: `${uploaded.assetId ?? uploaded.publicId}:${0}`,
    });

    this.logger.log(
      `Direct upload complete: mediaId=${media.id} purpose=${purpose} owner=${ownerId}`,
    );

    return {
      media: this.toResponse(media),
      url: uploaded.url,
    };
  }

  /**
   * Step 3 (fallback): client explicitly confirms the upload.
   * The webhook is the source of truth; this is a safety net only.
   */
  async confirmUpload(
    mediaId: string,
    requesterId: string,
    dto: ConfirmUploadDto,
  ): Promise<MediaResponse> {
    const media = await this.getOwnedMedia(mediaId, requesterId);

    if (media.status === 'READY') {
      return this.toResponse(media); // Already confirmed via webhook — idempotent
    }

    if (media.status !== 'PENDING') {
      throw new ForbiddenException(
        `Cannot confirm media in status "${media.status}"`,
      );
    }

    if (media.purpose === 'LISTING_VIDEO') {
      throw new BadRequestException(
        'Listing videos must be confirmed by the verified Cloudinary webhook',
      );
    }

    const maxBytes = PURPOSE_POLICIES[media.purpose].maxBytes;
    if (dto.bytes !== undefined && dto.bytes > maxBytes) {
      throw new BadRequestException('Uploaded file exceeds the maximum size for this media purpose');
    }

    const idempotencyKey = `${dto.assetId ?? media.publicId}:${dto.version ?? 0}`;
    const existing = await this.mediaRepo.findByIdempotencyKey(idempotencyKey);
    if (existing && existing.id !== mediaId) {
      this.logger.warn(
        `Duplicate confirm for idempotency key ${idempotencyKey}, returning existing`,
      );
      return this.toResponse(existing);
    }

    const updated = await this.mediaRepo.markReady(mediaId, {
      assetId: dto.assetId,
      version: dto.version != null ? BigInt(dto.version) : undefined,
      format: dto.format,
      bytes: dto.bytes,
      width: dto.width,
      height: dto.height,
      durationSec: dto.durationSec,
      etag: dto.etag,
      idempotencyKey,
    });

    return this.toResponse(updated);
  }

  /**
   * Return a delivery URL. For public assets, this is a plain CDN URL.
   * For private/authenticated assets, this is a short-lived signed URL (and access is logged).
   */
  async getAccessUrl(
    mediaId: string,
    requesterId: string,
    requesterRole: string,
    ip: string | undefined,
    userAgent: string | undefined,
    transformation?: string,
  ): Promise<SignedAccessResponse> {
    const media = await this.mediaRepo.findById(mediaId);
    if (!media) throw new NotFoundException('Media not found');
    if (media.status !== 'READY') {
      throw new NotFoundException('Media is not yet ready');
    }

    this.policyService.assertCanRead(requesterId, requesterRole, media.ownerId, media.purpose);

    const validated = this.policyService.validateTransformation(transformation);
    const resourceType = this.resourceTypeToSdk(media.resourceType);

    const requiresSigned = this.policyService.requiresSignedUrl(media.purpose);

    let url: string;
    let expiresAt: number | undefined;

    if (requiresSigned) {
      const ttl = 300; // 5 minutes
      url = this.storage.getSignedUrl(media.publicId, { ttlSeconds: ttl, resourceType });
      expiresAt = Math.floor(Date.now() / 1000) + ttl;

      // Log every access to sensitive documents
      await this.mediaRepo.logAccess({
        mediaId,
        accessorId: requesterId,
        ip,
        userAgent,
      });
    } else {
      url = this.storage.getDeliveryUrl(media.publicId, {
        transformation: validated,
        resourceType,
      });
    }

    return {
      url,
      expiresAt,
      mediaId,
    };
  }

  async listPendingUploads(ownerId: string): Promise<MediaResponse[]> {
    const pending = await this.mediaRepo.findPendingForOwner(ownerId);
    return pending.map((media) => this.toResponse(media));
  }

  async cancelPendingUpload(mediaId: string, ownerId: string): Promise<void> {
    const media = await this.getOwnedMedia(mediaId, ownerId);
    if (media.status !== 'PENDING') return;
    await this.deleteMedia(mediaId, ownerId, 'USER');
  }

  /**
   * Soft-delete a media record and enqueue the Cloudinary deletion.
   * Only owner or ADMIN may delete.
   */
  async deleteMedia(mediaId: string, requesterId: string, requesterRole: string): Promise<void> {
    const media = await this.mediaRepo.findById(mediaId);
    if (!media) throw new NotFoundException('Media not found');

    if (requesterRole !== 'ADMIN' && media.ownerId !== requesterId) {
      throw new ForbiddenException('You do not own this media');
    }

    if (media.status === 'DELETED' || media.status === 'DELETING') {
      return; // Already being deleted — idempotent
    }

    await this.mediaRepo.markDeleting(mediaId);

    await this.deletionQueue.add(
      'delete-asset',
      {
        mediaId,
        publicId: media.publicId,
        resourceType: this.resourceTypeToSdk(media.resourceType),
        deliveryType: this.deliveryTypeToSdk(media.deliveryType),
      },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: false,
      },
    );
  }

  /**
   * Handle a validated Cloudinary webhook payload.
   * Called ONLY after webhook signature has been verified.
   * Returns immediately — actual processing happens in the worker.
   */
  async enqueueWebhookJob(rawPayload: object): Promise<void> {
    await this.webhookQueue.add('process-webhook', rawPayload, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 200,
      removeOnFail: false,
    });
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async getOwnedMedia(mediaId: string, ownerId: string): Promise<Media> {
    const media = await this.mediaRepo.findById(mediaId);
    if (!media) throw new NotFoundException('Media not found');
    if (media.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this media');
    }
    return media;
  }

  toResponse(media: Media): MediaResponse {
    return {
      id: media.id,
      ownerId: media.ownerId,
      purpose: media.purpose,
      resourceType: media.resourceType,
      deliveryType: media.deliveryType,
      publicId: media.publicId,
      assetId: media.assetId ?? null,
      format: media.format ?? null,
      bytes: media.bytes ?? null,
      width: media.width ?? null,
      height: media.height ?? null,
      durationSec: media.durationSec ?? null,
      status: media.status,
      createdAt: media.createdAt,
      readyAt: media.readyAt ?? null,
    };
  }

  private resourceTypeToSdk(rt: string): 'image' | 'video' | 'raw' {
    const map: Record<string, 'image' | 'video' | 'raw'> = {
      IMAGE: 'image',
      VIDEO: 'video',
      RAW: 'raw',
    };
    return map[rt] ?? 'image';
  }

  private deliveryTypeToSdk(dt: string): 'upload' | 'authenticated' | 'private' {
    const map: Record<string, 'upload' | 'authenticated' | 'private'> = {
      UPLOAD: 'upload',
      AUTHENTICATED: 'authenticated',
      PRIVATE: 'private',
    };
    return map[dt] ?? 'upload';
  }
}
