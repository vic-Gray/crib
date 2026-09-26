import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
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
import { Roles } from '../../common/roles.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { ListingsService } from './listings.service.js';
import { CreateListingDto } from './dto/listing.dto.js';
import { UpdateListingDto } from './dto/listing.dto.js';
import { SearchListingsDto } from './dto/listing.dto.js';
import { AttachListingMediaDto } from './dto/listing.dto.js';

@ApiTags('Listings')
@ApiBearerAuth('access-token')
@Controller('listings')
export class ListingsController {
  constructor(private readonly listingsService: ListingsService) {}

  @Get()
  @Roles('STUDENT', 'AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Search listings' })
  @ApiResponse({ status: 200, type: [Object] })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  searchListings(@Query() query: SearchListingsDto) {
    return this.listingsService.searchListings(query);
  }

  @Get('admin/pending-review')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'List homes awaiting verification' })
  pendingReview() { return this.listingsService.listPendingReview(); }

  @Get('my')
  @Roles('AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Get my listings' })
  @ApiResponse({ status: 200, type: [Object] })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  getMyListings(@CurrentUser() user: { id: string }) {
    return this.listingsService.getMyListings(user.id);
  }

  @Get('bookmarks')
  @Roles('STUDENT', 'AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Get my saved listings' })
  getBookmarks(@CurrentUser() user: { id: string }) {
    return this.listingsService.getBookmarks(user.id);
  }

  @Get(':id')
  @Roles('STUDENT', 'AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Get a listing by ID' })
  @ApiResponse({ status: 200, type: Object })
  @ApiResponse({ status: 404, description: 'Listing not found' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  getListings(@Param('id') id: string) {
    return this.listingsService.getListing(id);
  }

  @Post(':id/bookmark')
  @Roles('STUDENT', 'AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Save a listing' })
  bookmark(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.listingsService.bookmark(id, user.id);
  }

  @Delete(':id/bookmark')
  @Roles('STUDENT', 'AGENT', 'LANDLORD', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a saved listing' })
  unbookmark(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.listingsService.unbookmark(id, user.id);
  }

  @Post()
  @Roles('AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Create a listing (agents/landlords only)' })
  @ApiResponse({ status: 201, type: Object })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  createListing(
    @CurrentUser() user: { id: string; role: string },
    @Body() dto: CreateListingDto,
  ) {
    return this.listingsService.createListing(
      user.id,
      user.role as any,
      {
        title: dto.title,
        description: dto.description,
        price: dto.price,
        discountAmount: dto.discountAmount,
        lat: dto.lat,
        lng: dto.lng,
        campus: dto.campus,
        address: dto.address,
        locationReference: dto.locationReference,
      },
    );
  }

  @Post(':id/submit')
  @Roles('AGENT', 'LANDLORD')
  @ApiOperation({ summary: 'Submit a draft home for server-side verification' })
  submitListing(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.listingsService.submitListing(id, user.id);
  }

  @Patch(':id/verify')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Verify a submitted home and make it visible in the marketplace' })
  verifyListing(@Param('id') id: string, @CurrentUser() user: { id: string }, @Body('notes') notes?: string) {
    return this.listingsService.reviewListing(id, user.id, true, notes);
  }

  @Patch(':id/reject')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Reject a submitted home' })
  rejectListing(@Param('id') id: string, @CurrentUser() user: { id: string }, @Body('notes') notes?: string) {
    return this.listingsService.reviewListing(id, user.id, false, notes);
  }

  @Post(':id/photos')
  @Roles('AGENT', 'LANDLORD', 'ADMIN')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Upload a photo for a listing (computes pHash)' })
  @ApiResponse({ status: 200, type: Object })
  @ApiResponse({ status: 404, description: 'Listing not found' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async uploadPhoto(
    @Param('id') listingId: string,
    @CurrentUser() user: { id: string },
    @UploadedFile() file: Express.Multer.File,
    @Query('url') url?: string,
  ) {
    const imageUrl = url ?? file?.path;
    if (!imageUrl) {
      throw new BadRequestException('Either a file upload or a url query param is required');
    }
    const buffer = file?.buffer
      ? file.buffer
      : file?.path
        ? await this.readFileAsBuffer(file.path)
        : undefined;
    return this.listingsService.uploadPhoto(listingId, user.id, imageUrl, buffer);
  }

  @Post(':id/photos/media')
  @Roles('AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Attach a ready LISTING_PHOTO media upload to a listing' })
  attachPhotoMedia(
    @Param('id') listingId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: AttachListingMediaDto,
  ) {
    return this.listingsService.attachPhotoMedia(listingId, user.id, dto.mediaId);
  }

  @Delete(':id/photos/:photoId')
  @Roles('AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Remove a photo from a listing' })
  removePhoto(
    @Param('id') listingId: string,
    @Param('photoId') photoId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.listingsService.removePhoto(listingId, photoId, user.id);
  }

  @Post(':id/video')
  @Roles('AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Attach the single ready LISTING_VIDEO media upload to a listing' })
  attachVideoMedia(
    @Param('id') listingId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: AttachListingMediaDto,
  ) {
    return this.listingsService.attachVideoMedia(listingId, user.id, dto.mediaId);
  }

  @Delete(':id/video')
  @Roles('AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Remove the video attached to a listing' })
  removeVideo(@Param('id') listingId: string, @CurrentUser() user: { id: string }) {
    return this.listingsService.removeVideo(listingId, user.id);
  }

  private async readFileAsBuffer(path: string): Promise<Buffer | undefined> {
    const fs = await import('node:fs/promises');
    return fs.readFile(path);
  }

  @Patch(':id')
  @Roles('AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Update a listing' })
  @ApiResponse({ status: 200, type: Object })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Listing not found' })
  @HttpCode(HttpStatus.OK)
  updateListing(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateListingDto,
  ) {
    return this.listingsService.updateListing(id, user.id, dto);
  }

  @Delete(':id')
  @Roles('AGENT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Delete (deactivate) a listing' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Listing not found' })
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteListing(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.listingsService.deleteListing(id, user.id);
  }
}
