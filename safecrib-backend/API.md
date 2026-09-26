# SafeCrib Platform API

All endpoints are under `/api/v1/`.

## Authentication

JWT Bearer tokens are required for protected routes. Use the access token as `Authorization: Bearer <accessToken>`. Registration and login are available before student-profile approval; approval is required only for protected marketplace actions such as bookings and reviews.

### Frontend auth flow

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | No | Create a student account. Body: `{ email, password, displayName? }` |
| POST | `/auth/login` | No | Return `{ accessToken, refreshToken }` |
| POST | `/auth/refresh` | No | Exchange `{ refreshToken }` for a new token pair |
| POST | `/auth/logout` | No | Revoke `{ refreshToken }` |
| POST | `/auth/forgot-password` | No | Request a password-reset email with `{ email }` |
| POST | `/auth/reset-password` | No | Reset with `{ token, password }` |
| GET | `/users/me` | Yes | Current user plus full linked student profile, including `profilePicture` and review status |
| PATCH | `/users/me` | Yes | Update the account display name |
| POST | `/users/me/change-password` | Yes | Change password with `{ currentPassword, newPassword }` |

### Student profile flow

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/student-profiles/me` | Student | Current submitted profile/review record, or `null` before submission |
| GET | `/student-profiles/status` | Student | `{ status, profile }`; status is `NOT_SUBMITTED`, `PENDING`, `APPROVED`, or `REJECTED` |
| POST | `/student-profiles/complete` | Student | Submit or resubmit the full student profile for review |

These student-profile endpoints work before approval. Booking and review endpoints still require an `APPROVED` student profile.

## Student / Basic Account

| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | Create a minimal student account |
| POST | `/student-profiles/signup` | Submit the same basic profile for review |
| GET | `/student-profiles/me` | Get the current user's basic submission |
| GET | `/student-profiles/submissions/:id` | Get a submission by review queue ID |
| POST | `/auth/login` | Log in and receive tokens |
| POST | `/auth/refresh` | Refresh an access token |
| POST | `/auth/forgot-password` | Send reset email |
| POST | `/auth/reset-password` | Reset password |
| POST | `/auth/logout` | Revoke refresh token |
| GET | `/users/me` | Get profile |
| PATCH | `/users/me` | Update profile |
| POST | `/users/me/change-password` | Change password |
| GET | `/users/me/trust` | Your trust score |
| GET | `/listings` | Search listings |
| GET | `/listings/my` | Get the authenticated provider's listings |
| GET | `/listings/:id` | Listing details |
| POST | `/listings/:id/bookmark` | Save a listing; returns `{ saved: true, listingId }` |
| DELETE | `/listings/:id/bookmark` | Unsave a listing; returns `{ saved: false, listingId }` |
| GET | `/listings/bookmarks` | Get saved listings in listing response shape |
| POST | `/bookings` | Create booking hold |
| PATCH | `/bookings/:id/confirm` | Confirm booking |
| PATCH | `/bookings/:id/cancel` | Cancel booking |
| PATCH | `/bookings/:id/complete` | Mark completed |
| PATCH | `/bookings/:id/dispute` | Raise dispute |
| GET | `/bookings` | List your bookings |
| GET | `/bookings/:id` | Get booking details |
| GET | `/trust/me` | Your trust score |
| GET | `/trust/users/:userId` | Public trust score |
| POST | `/fraud/reports` | Submit fraud report |

## Profile pictures and cover photos

Uploads use a signed direct-to-Cloudinary flow. The frontend does not send the image binary to the API.

1. Request a signature using one of these endpoints with `{ contentType, sizeBytes }`:

| Method | Path | Purpose | Limit |
|---|---|---|---|
| POST | `/media/profile-picture/upload-signature` | Profile picture/avatar | JPEG, PNG, WebP, GIF; 5 MB |
| POST | `/media/cover-photo/upload-signature` | Profile cover photo | JPEG, PNG, WebP; 10 MB |

2. POST the returned `uploadPayload` to Cloudinary using its `api_key`, `timestamp`, `signature`, `public_id`, `folder`, and `upload_preset` fields plus the file.

3. Confirm the upload after Cloudinary returns its asset metadata:

`POST /media/:mediaId/confirm` with `{ assetId, version, format, bytes, width, height, etag }`. The webhook normally marks the asset ready; confirmation is an idempotent fallback.

4. Read the finished image with `GET /media/:mediaId/access`. For profile images this returns a permanent CDN URL. Use `?transformation=avatar_sm` or `avatar_md` for profile-picture sizing.

5. Send the returned media URL or public asset reference in `profilePicture` when calling `/student-profiles/complete`. Cover photos are represented by the returned media record and accessed by its `mediaId`.

The generic `POST /media/upload-signature` also accepts `purpose: AVATAR` or `purpose: COVER_PHOTO`.

## Agent / Landlord Pages

| Method | Path | Description |
|---|---|---|
| GET | `/provider-pages/me` | Get the current provider Page |
| POST | `/provider-pages` | Create a Page or replace a rejected Page |
| PATCH | `/provider-pages/me` | Update a draft or rejected Page |
| POST | `/provider-pages/me/submit` | Submit Tier 2 Page verification |
| GET | `/provider-pages/admin/pending` | List pending Tier 2 Pages |
| PATCH | `/provider-pages/:id/verify` | Approve a Tier 2 Page |
| PATCH | `/provider-pages/:id/reject` | Reject a Tier 2 Page with a reason |
| POST | `/providers/:id/contact` | Email a verified provider from an approved student account |

Tier 2 submissions require a license/authorization reference, a profile picture, and at least one payout account. Payout account numbers are validated for supported providers.

## Response contracts

`GET /student-profiles/status` returns `{ status, profile }`. `status` is one of `NOT_SUBMITTED`, `PENDING`, `APPROVED`, or `REJECTED`. `profile` is `null` when the student has not submitted a profile; otherwise it includes the submitted profile fields and `rejectionReason` when rejected.

`GET /provider-pages/me` returns the Page fields plus `status` (`DRAFT`, `SUBMITTED`, `VERIFIED`, or `REJECTED`) and `rejectionReason` (the review reason or `null`). Account approval and Page approval are independent.

Listing responses include `id`, `title`, `description`, base `price`, optional `discountAmount`, computed `discountedPrice`, `lat`, `lng`, `campus`, `address`, `locationReference`, `status`, derived `availabilityStatus` (`AVAILABLE` or `SECURED`), `ownerId`, `photos`, optional `video` (`mediaId` and `durationSec`), `createdAt`, and `updatedAt`. Each photo contains its `id`, optional `mediaId`, `url`, and `phash`. A listing allows up to five photos and one video; submission requires a location address or Google Maps reference and at least one photo or video. Availability reflects an active hold/booking or `SOLD` status and does not indicate payment collection.

Use `POST /listings/:id/photos/media` and `POST /listings/:id/video` with `{ "mediaId": "..." }` to attach ready, owned media of the corresponding purpose. Remove them with `DELETE /listings/:id/photos/:photoId` or `DELETE /listings/:id/video`. Google Maps references are persisted with coordinates for clients to render through Google Maps; the backend does not geocode them.

`POST /providers/:id/contact` is email-only for now. An approved student sends `{ "message": "...", "listingId": "optional-listing-id" }`; the provider receives an email and the response is `{ "accepted": true, "delivery": "email" }`. It does not create in-app messages.

## Admin Review

Admin review covers both verification tracks:

- `entityType: "student_profile"` is a student account submission.
- `entityType: "provider_page"` is an agent account submission. The submitted
	Page may have `providerType: "AGENT"` or `providerType: "LANDLORD"`; both are
	reviewed in the same provider/agent queue and should not be treated as a
	separate admin product.

The frontend route `/admin/login` uses `POST /auth/login` because the backend
currently has one login endpoint. After login, it must call `POST /auth/me` and
allow access only when the response has `role: "ADMIN"`; there is no admin
signup flow. Every review request must still send the admin bearer token because
the API enforces `ADMIN` authorization server-side.

| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | Admin login transport; frontend follows with `POST /auth/me` and accepts only `role: ADMIN` |
| POST | `/admin/create` | Bootstrap an admin account; public for initial setup, so protect it at the deployment layer until bootstrap is complete |
| POST | `/auth/logout` | Revoke the stored admin refresh token |
| POST | `/admin/onboard` | Exceptional manual onboarding; creates an already-verified provider account, not an admin and not a Page review |
| GET | `/admin/review-queue` | List student and provider/agent submissions; optional `status` and `tier` filters |
| GET | `/admin/review-queue/:id` | Get one submission and its submitted data |
| POST | `/admin/review` | Approve or reject a submission; rejection requires `reason` |
| GET | `/provider-pages/admin/pending` | Direct provider Page pending list; admin only |
| PATCH | `/provider-pages/:id/verify` | Directly approve a submitted provider Page; admin only |
| PATCH | `/provider-pages/:id/reject` | Directly reject a submitted provider Page; admin only |
| PATCH | `/admin/users/:id/verify-identity` | Verify identity |
| GET | `/admin/users` | List all users |
| GET | `/admin/users/:id` | User detail with trust events |
| PATCH | `/admin/listings/:id/flag` | Flag listing for review |

For the frontend request/response flow, see
[`docs/admin-review-frontend.md`](docs/admin-review-frontend.md).

## Support Conversations

Authenticated users can send support messages from their dashboard. Messages
are persisted immediately and verified admin accounts are notified through the
email queue. Admins can read, reply to, and resolve conversations.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/support/conversations` | User | Start a support conversation with `message` and optional `subject` |
| GET | `/support/conversations` | User | List the current user's conversations |
| GET | `/support/conversations/:id` | User | Read one owned conversation |
| POST | `/support/conversations/:id/messages` | User | Send a follow-up message |
| GET | `/admin/support/conversations` | Admin | List support conversations; optional `status=OPEN\|RESOLVED` |
| GET | `/admin/support/conversations/:id` | Admin | Read a conversation and all messages |
| POST | `/admin/support/conversations/:id/messages` | Admin | Reply to the user; reopens a resolved conversation |
| PATCH | `/admin/support/conversations/:id/resolve` | Admin | Mark a conversation resolved |

Frontend implementation details are in
[`docs/support-frontend.md`](docs/support-frontend.md).

## Media Upload Recovery

Pending upload reservations are automatically cleaned every five minutes;
uploads older than 30 minutes are moved out of `PENDING` and scheduled for
storage deletion. The frontend can also recover immediately from an interrupted
upload:

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/media/pending` | User | List the current user's pending uploads |
| DELETE | `/media/pending/:id` | User | Cancel one owned pending upload and release its quota |

Successful Cloudinary upload webhooks and the authenticated confirmation
endpoint both mark the media `READY`, so completed uploads no longer count
toward the pending limit. Deploy the media cleanup migration/code and keep the
media cleanup worker running alongside the API.
| GET | `/fraud/reports` | List all fraud reports |
| GET | `/fraud/reports/pending` | Pending reports |
| PATCH | `/fraud/reports/:id/resolve` | Resolve fraud report |
| GET | `/fraud/duplicates/pending` | Pending duplicate flags |
| PATCH | `/fraud/duplicates/:id/resolve` | Resolve duplicate flag |
| GET | `/trust/users/:userId/breakdown` | Full trust breakdown |

## Swagger

API documentation: `/api/v1/docs` when `ENABLE_SWAGGER=true`.
