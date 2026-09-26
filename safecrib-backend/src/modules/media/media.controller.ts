import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import type { MediaPurpose } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/public.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { MediaService } from './services/media.service.js';
import {
  ConfirmUploadDto,
  GetSignedUrlDto,
  RequestProfileImageSignatureDto,
  RequestUploadSignatureDto,
} from './dto/media.dto.js';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from './providers/storage-provider.interface.js';

@ApiTags('Media')
@ApiBearerAuth('access-token')
@Controller('media')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(
    private readonly mediaService: MediaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  @Post('profile-picture/upload-signature')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request a signed profile-picture upload payload' })
  async requestProfilePictureSignature(
    @CurrentUser() user: { id: string },
    @Body() dto: RequestProfileImageSignatureDto,
  ) {
    return this.mediaService.requestUploadSignature(user.id, {
      ...dto,
      purpose: 'AVATAR',
    });
  }

  @Post('cover-photo/upload-signature')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request a signed profile cover-photo upload payload' })
  async requestCoverPhotoSignature(
    @CurrentUser() user: { id: string },
    @Body() dto: RequestProfileImageSignatureDto,
  ) {
    return this.mediaService.requestUploadSignature(user.id, {
      ...dto,
      purpose: 'COVER_PHOTO',
    });
  }

  // ─── POST /media/upload-signature ─────────────────────────────────────────

  @Post('upload-signature')
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // 20 signatures/min per user
  @ApiOperation({
    summary: 'Request a signed upload payload for direct-to-Cloudinary upload',
  })
  @ApiResponse({ status: 201, description: 'Signed upload payload returned' })
  @ApiResponse({ status: 400, description: 'Validation or policy error' })
  @ApiResponse({ status: 429, description: 'Upload quota exceeded' })
  async requestUploadSignature(
    @CurrentUser() user: { id: string },
    @Body() dto: RequestUploadSignatureDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.mediaService.requestUploadSignature(user.id, dto);
  }

  // ─── POST /media/upload ─────────────────────────────────────────────────────
  // Simple direct-upload flow: the client sends the file to the backend, which
  // uploads it to Cloudinary server-side (no upload preset / signed client
  // payload required) and returns the resulting URL.
  @Post('upload')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ summary: 'Upload a file directly to Cloudinary via the backend' })
  @ApiResponse({ status: 201, description: 'Asset uploaded; URL returned' })
  @ApiResponse({ status: 400, description: 'Validation or policy error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async uploadAsset(
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
    @Body('purpose') purpose: string,
    @Body('entityId') entityId?: string,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!file) {
      throw new BadRequestException('`file` is required (multipart/form-data)');
    }
    const result = await this.mediaService.uploadAsset(
      user.id,
      purpose as MediaPurpose,
      file,
      entityId,
    );
    return result;
  }

  @Get('pending')
  @ApiOperation({ summary: 'List the current user pending uploads' })
  async listPendingUploads(@CurrentUser() user: { id: string }) {
    return this.mediaService.listPendingUploads(user.id);
  }

  @Delete('pending/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel a current user pending upload' })
  async cancelPendingUpload(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    await this.mediaService.cancelPendingUpload(id, user.id);
  }

  // ─── POST /media/:id/confirm ───────────────────────────────────────────────

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm an upload (fallback; webhook is the source of truth)',
  })
  @ApiResponse({ status: 200, description: 'Media confirmed as ready' })
  async confirmUpload(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: ConfirmUploadDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.mediaService.confirmUpload(id, user.id, dto);
  }

  // ─── GET /media/:id/access ─────────────────────────────────────────────────

  @Get(':id/access')
  @ApiOperation({
    summary:
      'Get a delivery URL. Returns a short-lived signed URL for private/authenticated assets.',
  })
  @ApiResponse({ status: 200, description: 'URL returned' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @ApiResponse({ status: 404, description: 'Media not found or not ready' })
  async getAccessUrl(
    @Param('id') id: string,
    @CurrentUser() user: { id: string; role: string },
    @Query() query: GetSignedUrlDto,
    @Req() req: Request,
  ) {
    if (!user) throw new UnauthorizedException();
    const ip = req.ip;
    const ua = req.get('user-agent');
    return this.mediaService.getAccessUrl(
      id,
      user.id,
      user.role,
      ip,
      ua,
      query.transformation,
    );
  }

  // ─── DELETE /media/:id ─────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a media asset (owner or admin)' })
  @ApiResponse({ status: 204, description: 'Media scheduled for deletion' })
  async deleteMedia(
    @Param('id') id: string,
    @CurrentUser() user: { id: string; role: string },
  ) {
    if (!user) throw new UnauthorizedException();
    await this.mediaService.deleteMedia(id, user.id, user.role);
  }

  // ─── POST /media/webhook (raw body, public endpoint) ──────────────────────

  @Post('webhook')
  @Public() // No JWT — verified via Cloudinary signature header
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cloudinary webhook receiver (internal use)' })
  async handleWebhook(@Req() req: Request) {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      throw new BadRequestException('Raw body not available');
    }

    const signature = req.headers['x-cld-signature'];
    const timestamp = req.headers['x-cld-timestamp'];

    if (typeof signature !== 'string' || typeof timestamp !== 'string') {
      this.logger.warn('Webhook rejected: missing signature headers');
      return { ok: false };
    }

    const verification = this.storage.verifyWebhook(rawBody, signature, timestamp);
    if (!verification.valid) {
      this.logger.warn(`Webhook rejected: ${verification.reason}`);
      return { ok: false };
    }

    let payload: object;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as object;
    } catch {
      this.logger.warn('Webhook rejected: invalid JSON body');
      return { ok: false };
    }

    // Enqueue and return 200 immediately — processing happens asynchronously
    await this.mediaService.enqueueWebhookJob(payload);

    return { ok: true };
  }
}
