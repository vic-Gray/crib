import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { IMAGE_HASH_QUEUE } from '../../infra/queue/queue.constants.js';
import type { UpdateListingDto } from './dto/listing.dto.js';
import type { SearchListingsDto } from './dto/listing.dto.js';
import type { ListingResponse } from './dto/listing.dto.js';
import type { Role } from '../../common/roles.decorator.js';
import { ProviderPagesService } from '../provider-pages/provider-pages.service.js';
import { MediaService } from '../media/services/media.service.js';
import type { MediaPurpose, Prisma } from '@prisma/client';

export interface CreateListingInput {
  title: string;
  description?: string;
  price: number;
  discountAmount?: number;
  lat: number;
  lng: number;
  campus?: string;
  address?: string;
  locationReference?: string;
}

export interface PhotoInput {
  url: string;
  buffer?: Buffer;
}

@Injectable()
export class ListingsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(IMAGE_HASH_QUEUE) private readonly imageHashQueue: Queue,
    private readonly providerPages: ProviderPagesService,
    private readonly mediaService: MediaService,
  ) {}

  async createListing(
    ownerId: string,
    ownerRole: Role,
    input: CreateListingInput,
    photos: PhotoInput[] = [],
  ): Promise<ListingResponse> {
    if (ownerRole !== 'AGENT' && ownerRole !== 'LANDLORD') {
      throw new ForbiddenException('Only agents and landlords can create listings');
    }
    this.validateDiscount(input.price, input.discountAmount);
    this.assertPhotoCapacity(0, photos.length);
    const page = await this.providerPages.requireVerifiedPage(ownerId);

    const listing = await this.prisma.listing.create({
      data: {
        ownerId,
        title: input.title,
        description: input.description ?? null,
        price: input.price,
        discountAmount: input.discountAmount ?? null,
        lat: input.lat,
        lng: input.lng,
        campus: input.campus ?? null,
        address: input.address ?? null,
        locationReference: input.locationReference ?? null,
        providerPageId: page.id,
        status: 'DRAFT',
      },
    });

    for (const photo of photos) {
      const phash = photo.buffer
        ? await this.computePhashFromBuffer(photo.buffer)
        : '';

      const dbPhoto = await this.prisma.listingPhoto.create({
        data: {
          listingId: listing.id,
          url: photo.url,
          phash: phash || '',
        },
      });

      if (phash) {
        await this.imageHashQueue.add('phash-check', {
          listingId: listing.id,
          photoId: dbPhoto.id,
          phash,
          url: photo.url,
        });
      }
    }

    return this.toResponse(listing, []);
  }

  async updateListing(
    listingId: string,
    ownerId: string,
    input: UpdateListingDto,
  ): Promise<ListingResponse> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { ownerId: true, price: true, discountAmount: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    if (listing.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this listing');
    }

    this.validateDiscount(
      input.price ?? listing.price,
      input.discountAmount ?? listing.discountAmount ?? undefined,
    );

    const updated = await this.prisma.listing.update({
      where: { id: listingId },
      data: {
        title: input.title ?? undefined,
        description: input.description ?? undefined,
        price: input.price ?? undefined,
        discountAmount: input.discountAmount ?? undefined,
        lat: input.lat ?? undefined,
        lng: input.lng ?? undefined,
        campus: input.campus ?? undefined,
        address: input.address ?? undefined,
        locationReference: input.locationReference ?? undefined,
      },
      include: this.listingInclude(),
    });

    return this.toResponse(updated, updated.photos);
  }

  async deleteListing(listingId: string, ownerId: string): Promise<void> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { ownerId: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    if (listing.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this listing');
    }

    await this.prisma.listing.delete({
      where: { id: listingId },
    });
  }

  async getListing(listingId: string): Promise<ListingResponse> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: this.listingInclude(),
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    return this.toResponse(listing, listing.photos);
  }

  async searchListings(dto: SearchListingsDto): Promise<ListingResponse[]> {
    const where: any = {
      status: 'VERIFIED',
    };

    if (dto.maxPrice !== undefined || dto.minPrice !== undefined) {
      where.price = {};
      if (dto.maxPrice !== undefined) where.price.lte = dto.maxPrice;
      if (dto.minPrice !== undefined) where.price.gte = dto.minPrice;
    }

    if (dto.campus) {
      where.OR = [
        { campus: { equals: dto.campus, mode: 'insensitive' } },
        { campus: { contains: dto.campus, mode: 'insensitive' } },
      ];
    }

    if (dto.lat !== undefined && dto.lng !== undefined) {
      where.AND = [
        {
          lat: {
            gte: dto.lat - 0.05,
            lte: dto.lat + 0.05,
          },
          lng: {
            gte: dto.lng - 0.05,
            lte: dto.lng + 0.05,
          },
        },
      ];
    }

    const listings = await this.prisma.listing.findMany({
      where,
      include: this.listingInclude(),
      orderBy: { createdAt: 'desc' },
    });

    return listings.map((l) => this.toResponse(l, l.photos));
  }

  async getMyListings(userId: string): Promise<ListingResponse[]> {
    const listings = await this.prisma.listing.findMany({
      where: { ownerId: userId },
      include: this.listingInclude(),
      orderBy: { createdAt: 'desc' },
    });

    return listings.map((l) => this.toResponse(l, l.photos));
  }

  async bookmark(listingId: string, userId: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new NotFoundException('Listing not found');

    await this.prisma.bookmark.upsert({
      where: { userId_listingId: { userId, listingId } },
      create: { userId, listingId },
      update: {},
    });
    return { saved: true, listingId };
  }

  async unbookmark(listingId: string, userId: string) {
    await this.prisma.bookmark.deleteMany({ where: { userId, listingId } });
    return { saved: false, listingId };
  }

  async getBookmarks(userId: string): Promise<ListingResponse[]> {
    const bookmarks = await this.prisma.bookmark.findMany({
      where: { userId },
      include: { listing: { include: this.listingInclude() } },
      orderBy: { createdAt: 'desc' },
    });
    return bookmarks.map(({ listing }) => this.toResponse(listing, listing.photos));
  }

  async uploadPhoto(
    listingId: string,
    ownerId: string,
    url: string,
    buffer?: Buffer,
  ): Promise<ListingResponse> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { ownerId: true, photos: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    if (listing.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this listing');
    }

    this.assertPhotoCapacity(listing.photos.length, 1);

    const phash = buffer ? await this.computePhashFromBuffer(buffer) : '';

    const photo = await this.prisma.listingPhoto.create({
      data: {
        listingId,
        url,
        phash: phash || '',
      },
    });

    if (phash) {
      await this.imageHashQueue.add('phash-check', {
        listingId,
        photoId: photo.id,
        phash,
        url,
      });
    }

    const fullListing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: this.listingInclude(),
    });

    return this.toResponse(fullListing!, [...listing.photos, photo]);
  }

  async submitListing(listingId: string, ownerId: string): Promise<ListingResponse> {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId }, include: this.listingInclude() });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.ownerId !== ownerId) throw new ForbiddenException('You do not own this listing');
    if (listing.status !== 'DRAFT' && listing.status !== 'REJECTED') {
      throw new ForbiddenException('Only draft or rejected listings can be submitted for verification');
    }
    if (listing.price < 1) throw new BadRequestException('Listing price must be greater than zero');
    if (!listing.address?.trim() && !listing.locationReference?.trim()) {
      throw new BadRequestException('Provide a typed address or a Google Maps location reference');
    }
    if (listing.photos.length === 0 && !listing.video) {
      throw new BadRequestException('Attach at least one photo or one video before submitting a home');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.listing.update({ where: { id: listingId }, data: { status: 'SUBMITTED' }, include: this.listingInclude() });
      await tx.auditLog.create({ data: { actorId: ownerId, action: 'LISTING_SUBMITTED', entityType: 'listing', entityId: listingId } });
      return result;
    });
    return this.toResponse(updated, updated.photos);
  }

  async listPendingReview(): Promise<ListingResponse[]> {
    const listings = await this.prisma.listing.findMany({ where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } }, include: this.listingInclude(), orderBy: { updatedAt: 'asc' } });
    return listings.map((listing) => this.toResponse(listing, listing.photos));
  }

  async reviewListing(listingId: string, adminId: string, approved: boolean, notes?: string): Promise<ListingResponse> {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId }, include: this.listingInclude() });
    if (!listing) throw new NotFoundException('Listing not found');
    if (!['SUBMITTED', 'UNDER_REVIEW'].includes(listing.status)) {
      throw new ForbiddenException('Only submitted listings can be reviewed');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.listing.update({ where: { id: listingId }, data: { status: approved ? 'VERIFIED' : 'REJECTED' }, include: this.listingInclude() });
      await tx.auditLog.create({ data: { actorId: adminId, action: approved ? 'LISTING_VERIFIED' : 'LISTING_REJECTED', entityType: 'listing', entityId: listingId, metadata: { notes } } });
      return result;
    });
    return this.toResponse(updated, updated.photos);
  }

  private async computePhashFromBuffer(buffer: Buffer): Promise<string> {
    const { computePhash } = await import('../../domain/fraud/image-phash.js');
    return computePhash(buffer);
  }

  async attachPhotoMedia(
    listingId: string,
    ownerId: string,
    mediaId: string,
  ): Promise<ListingResponse> {
    const listing = await this.getOwnedListing(listingId, ownerId);
    const media = await this.getReadyListingMedia(mediaId, ownerId, 'LISTING_PHOTO');
    this.assertPhotoCapacity(listing.photos.length, 1);
    const access = await this.mediaService.getAccessUrl(
      media.id,
      ownerId,
      'AGENT',
      undefined,
      undefined,
    );
    const photo = await this.prisma.listingPhoto.create({
      data: { listingId, mediaId, url: access.url, phash: '' },
    });
    const updated = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: this.listingInclude(),
    });
    return this.toResponse(updated!, [...listing.photos, photo]);
  }

  async attachVideoMedia(
    listingId: string,
    ownerId: string,
    mediaId: string,
  ): Promise<ListingResponse> {
    await this.getOwnedListing(listingId, ownerId);
    const media = await this.getReadyListingMedia(mediaId, ownerId, 'LISTING_VIDEO');
    const existing = await this.prisma.listingVideo.findUnique({
      where: { listingId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'This listing already has a video; remove it before attaching another',
      );
    }

    try {
      await this.prisma.listingVideo.create({ data: { listingId, mediaId: media.id } });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('This listing or video is already attached');
      }
      throw error;
    }
    return this.getListing(listingId);
  }

  async removePhoto(
    listingId: string,
    photoId: string,
    ownerId: string,
  ): Promise<ListingResponse> {
    await this.getOwnedListing(listingId, ownerId);
    const photo = await this.prisma.listingPhoto.findFirst({
      where: { id: photoId, listingId },
      select: { id: true, mediaId: true },
    });
    if (!photo) throw new NotFoundException('Listing photo not found');
    await this.prisma.listingPhoto.delete({ where: { id: photoId } });
    if (photo.mediaId) await this.mediaService.deleteMedia(photo.mediaId, ownerId, 'AGENT');
    return this.getListing(listingId);
  }

  async removeVideo(listingId: string, ownerId: string): Promise<ListingResponse> {
    await this.getOwnedListing(listingId, ownerId);
    const video = await this.prisma.listingVideo.findUnique({
      where: { listingId },
      select: { mediaId: true },
    });
    if (video) {
      await this.prisma.listingVideo.delete({ where: { listingId } });
      await this.mediaService.deleteMedia(video.mediaId, ownerId, 'AGENT');
    }
    return this.getListing(listingId);
  }

  private async getOwnedListing(listingId: string, ownerId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: { photos: true },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this listing');
    }
    return listing;
  }

  private async getReadyListingMedia(
    mediaId: string,
    ownerId: string,
    purpose: MediaPurpose,
  ) {
    const media = await this.prisma.media.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');
    if (media.ownerId !== ownerId) throw new ForbiddenException('You do not own this media');
    if (media.purpose !== purpose) {
      throw new BadRequestException(`Media must have purpose ${purpose}`);
    }
    if (media.status !== 'READY') {
      throw new BadRequestException('Wait for the upload to finish before attaching this media');
    }
    return media;
  }

  private assertPhotoCapacity(currentCount: number, additionalCount: number): void {
    if (currentCount + additionalCount > 5) {
      throw new ConflictException('A listing can have no more than 5 photos');
    }
  }

  private validateDiscount(price: number, discountAmount?: number): void {
    if (discountAmount !== undefined && discountAmount > price) {
      throw new BadRequestException('Discount amount cannot exceed the listing price');
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }

  private listingInclude(): Prisma.ListingInclude {
    return {
      photos: true,
      video: { include: { media: { select: { id: true, durationSec: true } } } },
      bookings: {
        where: {
          OR: [
            { status: 'BOOKED' },
            { status: 'HELD', holdExpiresAt: { gt: new Date() } },
          ],
        },
        select: { id: true },
        take: 1,
      },
    };
  }

  private toResponse(listing: any, photos: any[]): ListingResponse {
    return {
      id: listing.id,
      title: listing.title,
      description: listing.description ?? null,
      price: listing.price,
      discountAmount: listing.discountAmount ?? null,
      discountedPrice: listing.price - (listing.discountAmount ?? 0),
      lat: listing.lat,
      lng: listing.lng,
      campus: listing.campus ?? null,
      address: listing.address ?? null,
      locationReference: listing.locationReference ?? null,
      status: listing.status,
      availabilityStatus:
        listing.status === 'SOLD' || (listing.bookings?.length ?? 0) > 0
          ? 'SECURED'
          : 'AVAILABLE',
      ownerId: listing.ownerId,
      photos: photos.map((p) => ({
        id: p.id,
        mediaId: p.mediaId ?? null,
        url: p.url,
        phash: p.phash,
      })),
      video: listing.video
        ? {
            mediaId: listing.video.mediaId,
            durationSec: listing.video.media?.durationSec ?? null,
          }
        : null,
      createdAt: listing.createdAt,
      updatedAt: listing.updatedAt,
    };
  }
}
