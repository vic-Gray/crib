import type { MediaPurpose, MediaDeliveryType, MediaResourceType } from '@prisma/client';

export interface PurposePolicy {
  purpose: MediaPurpose;
  resourceType: MediaResourceType;
  deliveryType: MediaDeliveryType;
  /** Allowed MIME types */
  allowedMimeTypes: string[];
  /** Maximum file size in bytes */
  maxBytes: number;
  /** Max pending uploads per user per purpose at one time */
  maxPendingPerUser: number;
  /** Human-readable label */
  label: string;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PURPOSE_POLICIES: Record<MediaPurpose, PurposePolicy> = {
  AVATAR: {
    purpose: 'AVATAR',
    resourceType: 'IMAGE',
    deliveryType: 'UPLOAD',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    maxBytes: 5 * MB,
    maxPendingPerUser: 2,
    label: 'Profile avatar',
  },
  COVER_PHOTO: {
    purpose: 'COVER_PHOTO',
    resourceType: 'IMAGE',
    deliveryType: 'UPLOAD',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 10 * MB,
    maxPendingPerUser: 2,
    label: 'Profile cover photo',
  },
  LISTING_PHOTO: {
    purpose: 'LISTING_PHOTO',
    resourceType: 'IMAGE',
    deliveryType: 'UPLOAD',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 15 * MB,
    maxPendingPerUser: 20,
    label: 'Listing photo',
  },
  LISTING_VIDEO: {
    purpose: 'LISTING_VIDEO',
    resourceType: 'VIDEO',
    deliveryType: 'UPLOAD',
    allowedMimeTypes: ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'],
    maxBytes: 100 * MB,
    maxPendingPerUser: 3,
    label: 'Listing video',
  },
  PROVIDER_LOGO: {
    purpose: 'PROVIDER_LOGO',
    resourceType: 'IMAGE',
    deliveryType: 'UPLOAD',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'],
    maxBytes: 5 * MB,
    maxPendingPerUser: 2,
    label: 'Provider logo',
  },
  STUDENT_ID: {
    purpose: 'STUDENT_ID',
    resourceType: 'IMAGE',
    deliveryType: 'AUTHENTICATED',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * MB,
    maxPendingPerUser: 3,
    label: 'Student ID document',
  },
  PROOF_OF_STUDENTSHIP: {
    purpose: 'PROOF_OF_STUDENTSHIP',
    resourceType: 'IMAGE',
    deliveryType: 'AUTHENTICATED',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * MB,
    maxPendingPerUser: 3,
    label: 'Proof of studentship',
  },
  PROOF_OF_LICENSE: {
    purpose: 'PROOF_OF_LICENSE',
    resourceType: 'IMAGE',
    deliveryType: 'AUTHENTICATED',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    maxBytes: 10 * MB,
    maxPendingPerUser: 3,
    label: 'Proof of license',
  },
  CONTRACT_DOCUMENT: {
    purpose: 'CONTRACT_DOCUMENT',
    resourceType: 'RAW',
    deliveryType: 'PRIVATE',
    allowedMimeTypes: ['application/pdf'],
    maxBytes: 25 * MB,
    maxPendingPerUser: 5,
    label: 'Contract document',
  },
};

/** Named transformations exposed to clients (never let clients pass raw transformation strings) */
export const NAMED_TRANSFORMATIONS: Record<string, string> = {
  avatar_sm: 'c_fill,w_64,h_64,f_auto,q_auto',
  avatar_md: 'c_fill,w_200,h_200,f_auto,q_auto',
  listing_card: 'c_fill,w_400,h_300,f_auto,q_auto',
  listing_hero: 'c_fill,w_1200,h_800,f_auto,q_auto',
  listing_thumb: 'c_fill,w_80,h_60,f_auto,q_auto',
  video_poster: 'f_jpg,q_auto,so_0',
};

export const ALLOWED_TRANSFORMATION_NAMES = Object.keys(NAMED_TRANSFORMATIONS);

// Re-export the GB constant for use in scripts
export { GB };
