# Agent and Landlord Frontend Workflow

This document defines the frontend behavior for the agent/landlord area: provider verification, listing creation, photo and video uploads, location display, admin review, and duplicate/fraud handling.

Related references: [API reference](../API.md), [Media system](media.md).

## 1. User and access model

The agent area is for authenticated users whose account role is `AGENT` or `LANDLORD`. Send the access token as `Authorization: Bearer <accessToken>` to protected routes. The frontend must treat backend authorization as authoritative; hiding a control is not a substitute for handling `401` and `403` responses.

A user must have an approved, verified provider Page before creating a home. The backend checks this on `POST /listings` and returns `403` if the Page is missing or not `VERIFIED`. Therefore, the agent home should start by loading both:

- `GET /users/me` (to identify the signed-in account and role)
- `GET /provider-pages/me` (to find the provider Page and its verification state)

If there is no Page, route the user to provider setup. If its state is `DRAFT` or `REJECTED`, allow completion and submission. If it is `SUBMITTED`, show a pending-review state and disable listing creation. If it is `VERIFIED`, show the listing workspace and enable creating homes.

## 2. Recommended page areas

Keep the agent workspace task-oriented, with these primary views:

- **Overview:** Page verification state, review feedback, listing counts by status, and a clear next action.
- **Homes:** Listings from `GET /listings/my`, with status, base and discounted prices, availability, location, photos, and video.
- **Create/Edit Home:** A staged form for home details, map location, and up to five photos plus one optional video, with draft saving and a review-before-submit step.
- **Review status:** Submitted/rejected state and the latest available reason or notes. The current listing response does not include review notes, so notes need a future API contract if listing-specific rejection guidance should appear here.

Do not display an unverified or rejected home as publicly live. Public search only returns listings with status `VERIFIED`.

## 3. Provider Page verification

A provider Page is separate from a home listing. It verifies the agent/landlord before home creation is available.

### Required Page information

`POST /provider-pages` requires:

- `displayName`: 3-120 characters
- `proofOfLicense`: non-empty reference/string
- `profilePicture`: non-empty reference/string
- `payoutAccounts`: 1-10 entries; each has `provider`, `accountName`, and an 8-20 digit `accountNumber`

Optional fields include description (up to 2,000 characters), phone (up to 30), provider type (`AGENT` or `LANDLORD`), business name, registration number, business address, additional phone numbers, and social links. The license and profile values are references/URLs as currently validated; use the media system for uploading sensitive proof documents rather than exposing private documents as public URLs.

### Page lifecycle and endpoints

| User action | Request | Expected behavior |
|---|---|---|
| Load Page | `GET /provider-pages/me` | Returns the current Page or `null` |
| Create Page | `POST /provider-pages` | Creates a `DRAFT`; a rejected Page may be replaced |
| Edit Page | `PATCH /provider-pages/me` | Allowed only in `DRAFT` or `REJECTED`; changes reset it to `DRAFT` |
| Submit for review | `POST /provider-pages/me/submit` | Validates required verification information and changes state to `SUBMITTED` |

The backend creates an admin review-queue item when the Page is submitted. Admins review it through `GET /provider-pages/admin/pending`, then call `PATCH /provider-pages/:id/verify` or `PATCH /provider-pages/:id/reject`. Rejection requires a reason. After rejection, let the provider edit and resubmit. On approval, refresh `GET /provider-pages/me` and unlock the home workflow.

Show a persistent pending state after submit; do not allow repeated submissions while the Page is already `SUBMITTED`. The frontend should show the rejection reason from `verificationNotes` when available.

## 4. Create and submit a home

### Listing form fields

The current create contract is `POST /listings`:

```json
{
  "title": "Cozy room near campus",
  "description": "Spacious room with AC and wifi near main campus",
  "price": 50000,
  "discountAmount": 5000,
  "lat": 9.0765,
  "lng": 7.3986,
  "campus": "University of Abuja",
  "address": "123 Campus Road, Abuja",
  "locationReference": "ChIJN1t_tDeuEmsRUsoyG83frY4"
}
```

Field constraints from the backend DTO:

| Field | Requirement |
|---|---|
| `title` | Required string, 3-200 characters |
| `description` | Optional string, max 2,000 characters |
| `price` | Required positive integer in the configured currency's minor units |
| `discountAmount` | Optional non-negative integer; cannot exceed `price` |
| `lat` | Required latitude |
| `lng` | Required longitude |
| `campus` | Optional string, max 200 characters |
| `address` | Optional typed street/location description, max 500 characters |
| `locationReference` | Optional Google Maps URL, Place ID, or Plus Code, max 500 characters |

The API stores the base price and optional discount as integers and returns `discountedPrice = price - discountAmount`. Use the configured currency display. Coordinates are required in every location mode. Require either a typed `address` or a `locationReference` before submission.

Location entry supports three frontend paths: type a human-readable address; use a “share accommodation location” action to collect device coordinates and, through the configured Google Maps client integration, a place/reference value; or paste a Google Maps URL, Place ID, or Plus Code into `locationReference`. Send the resolved `lat`/`lng` and reference to the listing API. Listing responses return the coordinates and exact reference; use those values with Google Maps Embed/Maps SDK to render a real map for students instead of displaying the reference as text. The backend persists these values but does not geocode them or require a server-side Google API key.

`availabilityStatus` is derived from an active `HELD`/`BOOKED` booking or `SOLD` listing status (`SECURED` vs `AVAILABLE`). It is not an agent-editable field and does not assert that payment was collected; this backend currently has no payment processor.

### Recommended form sequence

1. Load provider Page and confirm it is `VERIFIED`.
2. Collect and validate home details. Preserve the draft locally while the user is in the form.
3. Create the server-side draft with `POST /listings`; save the returned `id` immediately.
4. Upload up to five photos and/or one video, then attach each completed upload to the listing using section 5.
5. Refresh the listing from `GET /listings/:id` or `GET /listings/my` and verify every intended media item is attached.
6. Show a final review of the description, base/discounted price, rendered map, photos, and video.
7. On explicit user confirmation, call `POST /listings/:id/submit`.
8. Replace the edit/submit controls with a pending-review status and refresh the listing. Do not optimistically mark it verified.

A listing is created as `DRAFT`. Submission is permitted only for `DRAFT` or `REJECTED`; it requires a typed address or Google Maps reference and at least one attached photo or video. It moves the listing to `SUBMITTED` and records an audit event. Admin review can also find `UNDER_REVIEW` listings.

### Listing lifecycle

| Status | Frontend meaning | Provider actions |
|---|---|---|
| `DRAFT` | In progress; not publicly visible | Edit, add photos, submit |
| `SUBMITTED` | Waiting for admin review | View details; do not resubmit or edit |
| `UNDER_REVIEW` | Admin review in progress | View details; do not resubmit or edit |
| `VERIFIED` | Admin approved; visible in marketplace search | View; editing policy is not defined by the current service |
| `REJECTED` | Admin did not approve | Edit, address feedback if provided, resubmit |
| `FLAGGED` | Listing has a confirmed fraud report or other flag | Show a restricted/attention state; support/admin action is required |
| `INACTIVE`, `SOLD`, `ACTIVE` | Additional schema states | Do not infer unsupported transitions; use backend response as source of truth |

`DELETE /listings/:id` deletes a listing record; it is not a documented soft-deactivation operation despite the controller summary. Do not use it as a normal hide/unpublish button. A dedicated deactivate endpoint/state transition should be agreed with the backend before exposing that action.

## 5. Listing photos and video

Listings support up to five photos and exactly one attached video. Submission requires at least one photo or the video. The legacy listing routes remain available:

- `POST /listings/:id/photos?url=<encoded-url>` to attach a URL
- Or `POST /listings/:id/photos` with a multipart field named `file`

The legacy multipart photo route accepts at most 15 MB and computes an image perceptual hash when it receives image bytes. URL-only attachments do not provide bytes and therefore have no image hash. The route enforces the same five-photo limit.

The production media system separately provides a signed upload flow:

For each asset:

1. Request a signature with `POST /media/upload-signature`, using `purpose: "LISTING_PHOTO"` or `"LISTING_VIDEO"`, the MIME type, byte size, and `entityId: listingId`.
2. Upload directly to Cloudinary using the returned `uploadPayload`; keep upload progress and retry state in the UI.
3. Wait until the verified media record is `READY`. Listing videos must be confirmed by the Cloudinary webhook; `POST /media/:id/confirm` is not accepted for videos.
4. Attach the ready media ID with `POST /listings/:id/photos/media` or `POST /listings/:id/video`, each with `{ "mediaId": "<mediaId>" }`.
5. Use the returned listing response as the source of truth. A video is returned as `{ "mediaId", "durationSec" }`; request its playback URL with `GET /media/:mediaId/access`. Listing photo URLs are included directly.

The attach routes verify listing ownership, media ownership, purpose, and `READY` status. A database uniqueness constraint prevents more than one video per listing. `DELETE /listings/:id/photos/:photoId` removes a photo; `DELETE /listings/:id/video` removes the video and schedules its asset deletion. Do not count an uploaded media record as attached until the listing API returns it.

Enforce photo types JPEG/PNG/WebP up to 15 MB and video types MP4/MOV/AVI/WebM up to 100 MB in the picker, while still handling API policy errors. The server also checks Cloudinary-reported bytes before marking any asset `READY`, deletes oversized uploads, and rejects manual video confirmation. Signed-media photo attachment currently has no source bytes for pHash calculation; do not claim image-based duplicate detection ran for those photos. Submission is allowed with one or more attached photos, one attached video, or both.

## 6. Admin review handoff

Provider-facing clients must not call admin routes. Admin listing review is handled with:

- `GET /listings/admin/pending-review`
- `PATCH /listings/:id/verify` with optional `{ "notes": "..." }`
- `PATCH /listings/:id/reject` with optional `{ "notes": "..." }`

The listing review service accepts `SUBMITTED` and `UNDER_REVIEW`. Approval changes the status to `VERIFIED`; rejection changes it to `REJECTED`. The provider's `GET /listings/my` response includes status and photos but currently does not include review notes. The provider UI should therefore show the rejection state and offer correction/resubmission, but cannot reliably show a listing-specific rejection reason until the response contract exposes it.

## 7. Duplicate detection and fraud flags

Duplicate detection is server-side and asynchronous. The frontend must not attempt to recreate these algorithms as authoritative decisions or block a listing based on its own approximation. It may show a neutral “additional review may be required” message only if the API returns an actual flag; the current provider listing response does not expose duplicate flags.

### Current duplicate signals

The duplicate engine compares a candidate against existing listing fingerprints and can create one or more flags for the same listing pair:

- **Image pHash (`IMAGE_PHASH`):** compares the hash strings position by position. A flag is emitted when the difference count is at most 15. Similarity is `1 - difference / hash length`.
- **Description text (`TEXT_SIMILARITY`):** lowercases the description, removes punctuation, ignores tokens of 1-2 characters, and computes Jaccard similarity over unique tokens. A flag is emitted at similarity `>= 0.85`.
- **Location and price (`GEO_PRICE`):** emits a flag when both latitude and longitude differ by less than `0.001` and the integer price is exactly equal.

The engine has an `isHighRiskFlag` helper, but the current worker does not use it to automatically reject, hide, or flag a listing. A duplicate flag itself is a review signal, not a final fraud decision.

### Current worker behavior and implementation caveats

- Image-hash work is queued by the listing photo route only when that route receives image bytes. URL-only photos are stored with an empty pHash and do not enqueue this check.
- The image worker and scheduled duplicate sweep compare against listings whose status is `ACTIVE` or `FLAGGED`.
- The listing search service exposes only `VERIFIED` listings, and listing admin approval sets status to `VERIFIED`. This means the worker's `ACTIVE`/`FLAGGED` comparison set does not currently line up with the principal verified listing state. Confirm/fix this status mismatch in the backend before relying on comprehensive duplicate coverage.
- The image worker uses the newly uploaded photo hash as the candidate but compares against only the first stored photo hash for each existing listing.
- The duplicate sweep uses only the first photo hash from each listing.
- Flags are stored as `PENDING` and are available to admins through `GET /fraud/duplicates/pending`. Creating a duplicate flag does not itself change either listing's status.

### Admin resolution and user reporting

Admins resolve a pending duplicate flag with `PATCH /fraud/duplicates/:id/resolve` and body `{ "status": "CONFIRMED" | "DISMISSED", "notes": "..." }`. A confirmed duplicate applies a `-40` trust event to each distinct listing owner and queues trust-score recomputation. It does not currently change listing status in this resolution path.

A signed-in user can report a listing using `POST /fraud/reports`, for example:

```json
{
  "targetListingId": "<listingId>",
  "type": "FAKE_LISTING",
  "description": "This appears to be the same home as another listing."
}
```

The supported report types are `FAKE_LISTING`, `MISREPRESENTED`, `DOUBLE_BOOKING`, `SCAM_AGENT`, and `OTHER`. The description is required and must be 10-2,000 characters. The report starts as `PENDING`. Admins inspect `GET /fraud/reports/pending` and resolve with `PATCH /fraud/reports/:id/resolve`. A confirmed report targeting a listing changes it to `FLAGGED`; if a target user is also included, the service also applies a trust event to that user. The frontend should acknowledge successful report submission and avoid implying the report immediately removes a listing.

Expose no admin-only duplicate queue, flag-resolution, listing verification, or report-resolution controls to agents/landlords.

## 8. API and UI error handling

Use server errors to drive the UI state, with a friendly explanation and a recovery action where possible:

- `401`: refresh authentication or return to sign-in.
- `403` on create listing: provider Page is not verified, listing is not owned by the user, or current status disallows the operation; refresh Page/listing state and explain the relevant next step.
- `404`: listing or Page no longer exists; return to the list and refresh.
- `409` during media attachment: a listing already has a video, already has five photos, or the media was already attached; refresh the listing and offer removal/replacement.
- `409` during Page update/create/submit: state has changed or a Page already exists; reload `GET /provider-pages/me`.
- Media `400`/`429`: show validation/quota feedback; keep the selected file available for retry where safe.
- Network or upload failure: preserve the draft and distinguish a failed upload from an attached photo.

Do not infer success from a request starting. Update the UI from successful response bodies or a subsequent fetch; make submit actions idempotent from the user's perspective by disabling the button while the request is in flight.

## 9. Frontend acceptance checklist

- A non-verified provider can complete Page setup and see its review state, but cannot create a listing.
- A verified provider can create a draft, edit it, attach up to five photos and one video, and submit with either media type.
- A draft with no attached photos or video, or with no human-readable location reference, cannot be submitted; the backend error is surfaced clearly.
- Submitted homes remain pending until the API reports `VERIFIED` or `REJECTED`.
- Rejected homes can be edited and resubmitted; the UI does not claim a rejection reason is available unless the response contains it.
- Duplicate flags are described as admin-review signals, not automatic proof or automatic blocking.
- Media upload completion and listing attachment are represented as separate states; students see a rendered Google map and can play the attached accommodation video.
- No user-facing agent control invokes admin-only endpoints.
