import { Worker, Job } from 'bullmq';
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseRedisConnection } from '../../../infra/queue/redis-connection.util.js';
import { MEDIA_WEBHOOK_QUEUE } from '../../../infra/queue/queue.constants.js';
import { MediaRepository } from '../media.repository.js';
import type { WebhookNotificationPayload } from '../dto/media.dto.js';
import { PURPOSE_POLICIES } from '../policies/purpose-policies.js';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../providers/storage-provider.interface.js';

@Injectable()
export class MediaWebhookProcessor implements OnModuleInit {
  private readonly logger = new Logger(MediaWebhookProcessor.name);
  private worker: Worker | null = null;

  constructor(
    private readonly mediaRepo: MediaRepository,
    private readonly configService: ConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  onModuleInit(): void {
    const redisUrl =
      this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379';

    this.worker = new Worker<object>(
      MEDIA_WEBHOOK_QUEUE,
      async (job: Job<object>) => {
        await this.process(job.data as WebhookNotificationPayload);
      },
      {
        connection: parseRedisConnection(redisUrl),
        concurrency: 5,
      },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Webhook job ${job?.id ?? 'unknown'} failed after ${job?.attemptsMade ?? 0} attempts: ${err?.message}`,
        err?.stack,
      );
    });

    this.worker.on('completed', (job) => {
      this.logger.debug(`Webhook job ${job.id} completed`);
    });
  }

  private async process(payload: WebhookNotificationPayload): Promise<void> {
    const notificationType = payload.notification_type;

    if (notificationType === 'upload' || notificationType === 'eager') {
      await this.handleUploadComplete(payload);
    } else if (notificationType === 'delete') {
      await this.handleDeleteComplete(payload);
    } else if (notificationType === 'error') {
      await this.handleUploadError(payload);
    } else {
      this.logger.debug(`Unhandled webhook notification_type: ${notificationType}`);
    }
  }

  private async handleUploadComplete(
    payload: WebhookNotificationPayload,
  ): Promise<void> {
    const { public_id, asset_id, version, format, bytes, width, height, duration, etag } =
      payload;

    if (!public_id) {
      this.logger.warn('Webhook upload event missing public_id');
      return;
    }

    // Idempotency: assetId + version as the dedup key
    const idempotencyKey = `${asset_id ?? public_id}:${version ?? 0}`;

    // Check if already processed (handles duplicate and out-of-order deliveries)
    const existing = await this.mediaRepo.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      this.logger.debug(
        `Webhook idempotent: key=${idempotencyKey} mediaId=${existing.id} already READY`,
      );
      return;
    }

    const media = await this.mediaRepo.findByPublicId(public_id);
    if (!media) {
      // Could be from a different environment or an old/orphaned upload
      this.logger.warn(
        `Webhook upload for unknown public_id: ${public_id} — ignoring`,
      );
      return;
    }

    if (media.status !== 'PENDING') {
      this.logger.debug(
        `Webhook upload for media ${media.id} in status ${media.status} — skipping`,
      );
      return;
    }

    const maxBytes = PURPOSE_POLICIES[media.purpose].maxBytes;
    if (bytes == null || bytes > maxBytes) {
      const reason =
        bytes == null
          ? 'Cloudinary upload metadata did not include the actual file size'
          : `Uploaded file size ${bytes} bytes exceeds the ${maxBytes} byte limit`;
      const result = await this.storage.deleteAsset(public_id, {
        resourceType:
          media.resourceType === 'VIDEO'
            ? 'video'
            : media.resourceType === 'RAW'
              ? 'raw'
              : 'image',
        deliveryType:
          media.deliveryType === 'AUTHENTICATED'
            ? 'authenticated'
            : media.deliveryType === 'PRIVATE'
              ? 'private'
              : 'upload',
      });
      if (result.result !== 'ok' && result.result !== 'not found') {
        throw new Error(`Unable to remove an invalid upload: ${result.result}`);
      }
      await this.mediaRepo.markFailed(media.id, reason);
      this.logger.warn(`Oversized or unverifiable upload rejected: id=${media.id} ${reason}`);
      return;
    }

    await this.mediaRepo.markReady(media.id, {
      assetId: asset_id,
      version: version != null ? BigInt(version) : undefined,
      format,
      bytes,
      width,
      height,
      durationSec: duration,
      etag,
      idempotencyKey,
    });

    this.logger.log(
      `Media READY: id=${media.id} publicId=${public_id} bytes=${bytes ?? '?'}`,
    );
  }

  private async handleUploadError(
    payload: WebhookNotificationPayload,
  ): Promise<void> {
    const { public_id } = payload;
    if (!public_id) return;

    const media = await this.mediaRepo.findByPublicId(public_id);
    if (!media) return;

    const reason = (payload as unknown as { error?: unknown })['error']
      ? JSON.stringify((payload as unknown as { error?: unknown })['error'])
      : 'Cloudinary upload error';

    await this.mediaRepo.markFailed(media.id, reason);
    this.logger.warn(`Media FAILED: id=${media.id} reason=${reason}`);
  }

  private async handleDeleteComplete(
    payload: WebhookNotificationPayload,
  ): Promise<void> {
    const { public_id } = payload;
    if (!public_id) return;

    const media = await this.mediaRepo.findByPublicId(public_id);
    if (!media) return;

    await this.mediaRepo.markDeleted(media.id);
    this.logger.log(`Media DELETED: id=${media.id} publicId=${public_id}`);
  }
}
