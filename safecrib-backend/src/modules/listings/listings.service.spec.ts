import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ListingsService } from './listings.service.js';

function makeListing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'listing_1',
    ownerId: 'agent_1',
    title: 'Near campus room',
    description: null,
    price: 50000,
    discountAmount: null,
    lat: 9.0765,
    lng: 7.3986,
    campus: null,
    address: '123 Campus Road',
    locationReference: null,
    status: 'DRAFT',
    createdAt: new Date(),
    updatedAt: new Date(),
    photos: [],
    video: null,
    bookings: [],
    ...overrides,
  };
}

function makeService() {
  const transactionListing = makeListing({ status: 'SUBMITTED' });
  const tx = {
    listing: { update: vi.fn(async () => transactionListing) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    listing: {
      create: vi.fn(async () => makeListing()),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    listingPhoto: { create: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
    listingVideo: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
    media: { findUnique: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const providerPages = { requireVerifiedPage: vi.fn(async () => ({ id: 'page_1' })) };
  const mediaService = {
    getAccessUrl: vi.fn(async () => ({ url: 'https://cdn.example/photo.jpg' })),
    deleteMedia: vi.fn(async () => {}),
  };
  const queue = { add: vi.fn(async () => {}) };
  const service = new ListingsService(prisma as never, queue as never, providerPages as never, mediaService as never);
  return { service, prisma, providerPages, mediaService, tx, transactionListing };
}

describe('ListingsService listing media and pricing rules', () => {
  it('rejects a discount greater than the listing price', async () => {
    const { service, providerPages } = makeService();

    await expect(
      service.createListing('agent_1', 'AGENT', {
        title: 'Near campus room',
        price: 50000,
        discountAmount: 50001,
        lat: 9.0765,
        lng: 7.3986,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(providerPages.requireVerifiedPage).not.toHaveBeenCalled();
  });

  it('rejects more than five photos on initial listing creation', async () => {
    const { service, providerPages } = makeService();

    await expect(
      service.createListing(
        'agent_1',
        'AGENT',
        { title: 'Near campus room', price: 50000, lat: 9.0765, lng: 7.3986 },
        Array.from({ length: 6 }, (_, index) => ({ url: `https://cdn.example/${index}.jpg` })),
      ),
    ).rejects.toThrow(ConflictException);
    expect(providerPages.requireVerifiedPage).not.toHaveBeenCalled();
  });

  it('allows submission with a video and location even when there are no photos', async () => {
    const { service, prisma, transactionListing } = makeService();
    transactionListing.video = {
      mediaId: 'media_video',
      media: { id: 'media_video', durationSec: 30 },
    };
    prisma.listing.findUnique.mockResolvedValueOnce(
      makeListing({ video: { mediaId: 'media_video', media: { id: 'media_video', durationSec: 30 } } }),
    );

    const result = await service.submitListing('listing_1', 'agent_1');

    expect(result.status).toBe('SUBMITTED');
    expect(result.video?.mediaId).toBe('media_video');
  });

  it('rejects submission without either media type or a location description', async () => {
    const { service, prisma } = makeService();
    prisma.listing.findUnique.mockResolvedValueOnce(makeListing({ address: null }));

    await expect(service.submitListing('listing_1', 'agent_1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('does not allow attaching a second video to a listing', async () => {
    const { service, prisma } = makeService();
    prisma.listing.findUnique.mockResolvedValueOnce(makeListing());
    prisma.media.findUnique.mockResolvedValueOnce({
      id: 'media_video_2',
      ownerId: 'agent_1',
      purpose: 'LISTING_VIDEO',
      status: 'READY',
    });
    prisma.listingVideo.findUnique.mockResolvedValueOnce({ id: 'listing_video_1' });

    await expect(
      service.attachVideoMedia('listing_1', 'agent_1', 'media_video_2'),
    ).rejects.toThrow(ConflictException);
    expect(prisma.listingVideo.create).not.toHaveBeenCalled();
  });
});