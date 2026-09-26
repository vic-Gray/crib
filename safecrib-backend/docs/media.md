# SafeCrib Media System

Production-grade, horizontally scalable media handling built on Cloudinary.
The API server **never receives or proxies file bytes** — clients upload directly
to Cloudinary. The backend only issues signed payloads and processes webhooks.

---

## Table of contents

- [Upload flow overview](#upload-flow-overview)
- [Web client example](#web-client-example)
- [Mobile client example](#mobile-client-example)
- [Chunked upload for large videos](#chunked-upload-for-large-videos)
- [Purposes table](#purposes-table)
- [Named transformations](#named-transformations)
- [API reference](#api-reference)
- [Error codes](#error-codes)
- [Delivery URL rules](#delivery-url-rules)
- [Security model](#security-model)
- [Operations](#operations)

---

## Upload flow overview

```
Client                  SafeCrib API              Cloudinary
  │                          │                        │
  │  POST /media/upload-     │                        │
  │  signature               │                        │
  │  {purpose, contentType,  │                        │
  │   sizeBytes, entityId?}  │                        │
  │ ─────────────────────►   │                        │
  │                          │ — validate policy       │
  │                          │ — check quota           │
  │                          │ — create Media(PENDING) │
  │                          │ — generate signature    │
  │  {media, uploadPayload}  │                        │
  │ ◄─────────────────────   │                        │
  │                          │                        │
  │  POST https://api.cloudinary.com/v1_1/{cloud}/    │
  │  {file, signature, api_key, public_id, …}         │
  │ ─────────────────────────────────────────────►    │
  │                          │                        │
  │  {public_id, asset_id,   │                        │
  │   secure_url, …}         │                        │
  │ ◄─────────────────────────────────────────────    │
  │                          │                        │
  │                          │ ◄── POST /media/webhook │
  │                          │     {notification_type: │
  │                          │      "upload", …}       │
  │                          │ — verify signature      │
  │                          │ — enqueue BullMQ job    │
  │                          │ ──► { ok: true }        │
  │                          │                        │
  │                          │  [worker marks READY]   │
  │                          │                        │
  │  POST /media/:id/confirm │                        │
  │  (optional fallback)     │                        │
  │ ─────────────────────►   │                        │
  │  {status: "READY"}       │                        │
  │ ◄─────────────────────   │                        │
```

**Key rule:** The webhook is the source of truth. `POST /media/:id/confirm` is a
client-side fallback for environments where webhooks are not reachable (local dev),
except listing videos, which require webhook-verified actual size metadata.

---

## Web client example

```ts
// 1. Request a signed payload
const signatureRes = await fetch('/api/v1/media/upload-signature', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    purpose: 'LISTING_PHOTO',
    contentType: 'image/jpeg',
    sizeBytes: file.size,
    entityId: listingId,  // optional: attach to a listing
  }),
});
const { media, uploadPayload } = await signatureRes.json();

// 2. Upload directly to Cloudinary (no bytes touch your server)
const formData = new FormData();
formData.append('file', file);
formData.append('signature', uploadPayload.signature);
formData.append('timestamp', String(uploadPayload.timestamp));
formData.append('api_key', uploadPayload.api_key);
formData.append('public_id', uploadPayload.public_id);
formData.append('folder', uploadPayload.folder);
formData.append('upload_preset', uploadPayload.upload_preset);
// Any extra signed params
for (const [k, v] of Object.entries(uploadPayload)) {
  if (!['signature','timestamp','api_key','cloud_name','public_id','folder','upload_preset','expires_at'].includes(k)) {
    formData.append(k, String(v));
  }
}

const uploadRes = await fetch(
  `https://api.cloudinary.com/v1_1/${uploadPayload.cloud_name}/image/upload`,
  { method: 'POST', body: formData },
);
const cloudinaryData = await uploadRes.json();

// 3. (Optional fallback) confirm to the backend — the webhook will also do this
await fetch(`/api/v1/media/${media.id}/confirm`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    assetId: cloudinaryData.asset_id,
    version: cloudinaryData.version,
    format: cloudinaryData.format,
    bytes: cloudinaryData.bytes,
    width: cloudinaryData.width,
    height: cloudinaryData.height,
  }),
});
```

---

## Mobile client example

Same flow using `fetch` / `XMLHttpRequest` or a Cloudinary SDK. Replace
`formData.append('file', file)` with the appropriate file handle for your platform.

**React Native (Expo):**

```ts
const formData = new FormData();
formData.append('file', {
  uri: pickerResult.uri,
  type: 'image/jpeg',
  name: 'photo.jpg',
} as any);
// ... append the same signed params from uploadPayload
const res = await fetch(
  `https://api.cloudinary.com/v1_1/${uploadPayload.cloud_name}/image/upload`,
  { method: 'POST', body: formData },
);
```

---

## Chunked upload for large videos

Cloudinary supports chunked uploads via `X-Unique-Upload-Id` headers. Use the
Cloudinary JS SDK for this — it handles resumable uploads automatically:

```ts
import { Cloudinary } from '@cloudinary/url-gen';
// See: https://cloudinary.com/documentation/upload_images#chunked_asset_upload

// Request signature with purpose=LISTING_VIDEO
const { uploadPayload } = await requestSignature('LISTING_VIDEO', 'video/mp4', file.size, listingId);

// Use the cloudinary widget or SDK's chunked uploader:
cloudinary.uploader.upload_chunked(
  file,
  {
    upload_preset: uploadPayload.upload_preset,
    public_id: uploadPayload.public_id,
    folder: uploadPayload.folder,
    signature: uploadPayload.signature,
    api_key: uploadPayload.api_key,
    timestamp: uploadPayload.timestamp,
    chunk_size: 20 * 1024 * 1024, // 20 MB chunks
  },
  (result) => { /* confirm to backend */ }
);
```

Videos are transcoded asynchronously after upload. An HLS streaming playlist
(`m3u8`) and a poster thumbnail (`f_jpg,so_0`) are generated via eager
transformations. The webhook `notification_type: "eager"` fires when they're ready.

---

## Purposes table

| Purpose | Resource type | Delivery | Allowed types | Max size |
|---|---|---|---|---|
| `AVATAR` | image | public CDN | jpeg, png, webp, gif | 5 MB |
| `COVER_PHOTO` | image | public CDN | jpeg, png, webp | 10 MB |
| `LISTING_PHOTO` | image | public CDN | jpeg, png, webp | 15 MB |
| `LISTING_VIDEO` | video | public CDN | mp4, mov, avi, webm | 100 MB |
| `PROVIDER_LOGO` | image | public CDN | jpeg, png, webp, svg | 5 MB |
| `STUDENT_ID` | image / raw | authenticated (signed URL, 5-min TTL) | jpeg, png, webp, pdf | 10 MB |
| `PROOF_OF_STUDENTSHIP` | image / raw | authenticated (signed URL, 5-min TTL) | jpeg, png, webp, pdf | 10 MB |
| `PROOF_OF_LICENSE` | image / raw | authenticated (signed URL, 5-min TTL) | jpeg, png, webp, pdf | 10 MB |
| `CONTRACT_DOCUMENT` | raw | private (signed URL, 5-min TTL) | pdf | 25 MB |

Private and authenticated assets **never** return a permanent URL. Every call to
`GET /media/:id/access` generates a fresh 5-minute signed URL and logs the access.

---

## Named transformations

Clients request a transformation by name — raw transformation strings are rejected.
This prevents unbounded derived-asset creation and transformation injection.

| Name | Effect |
|---|---|
| `avatar_sm` | 64×64, fill, auto format + quality |
| `avatar_md` | 200×200, fill, auto format + quality |
| `listing_card` | 400×300, fill, auto format + quality |
| `listing_hero` | 1200×800, fill, auto format + quality |
| `listing_thumb` | 80×60, fill, auto format + quality |
| `video_poster` | JPEG thumbnail at time=0, auto quality |

Usage:

```
GET /api/v1/media/:id/access?transformation=listing_card
```

---

## API reference

### `POST /api/v1/media/upload-signature`

**Auth:** Required (any role with verified email)
**Rate limit:** 20 requests/min per user

**Request body:**

```json
{
  "purpose": "LISTING_PHOTO",
  "contentType": "image/jpeg",
  "sizeBytes": 2097152,
  "entityId": "listing_abc123"
}
```

**Response 201:**

```json
{
  "media": {
    "id": "3fa85f64-...",
    "status": "PENDING",
    "purpose": "LISTING_PHOTO",
    "resourceType": "IMAGE",
    "deliveryType": "UPLOAD",
    "publicId": "prod/listings/photo/listing_abc123/uuid-...",
    "createdAt": "2026-09-20T22:00:00.000Z"
  },
  "uploadPayload": {
    "signature": "a1b2c3...",
    "timestamp": 1726869600,
    "api_key": "513673348573289",
    "cloud_name": "u1dad45h",
    "public_id": "prod/listings/photo/listing_abc123/uuid-...",
    "folder": "prod/listings/photo/listing_abc123",
    "upload_preset": "sc_photo",
    "expires_at": 1726870200,
    "context": "purpose=LISTING_PHOTO|owner=user_id"
  }
}
```

---

### `POST /api/v1/media/:id/confirm`

**Auth:** Required (owner only)

**Request body** (all fields optional):

```json
{
  "assetId": "abc123def456",
  "version": 1726869600,
  "format": "jpg",
  "bytes": 204800,
  "width": 1920,
  "height": 1080
}
```

**Response 200:** Returns the updated media object.

---

### `GET /api/v1/media/:id/access`

**Auth:** Required

**Query params:**
- `transformation` — optional named transformation (public assets only)

**Response 200:**

```json
{
  "url": "https://res.cloudinary.com/u1dad45h/image/upload/...",
  "mediaId": "3fa85f64-...",
  "expiresAt": 1726870200
}
```

`expiresAt` is only present for signed URLs. Public CDN URLs do not expire.

---

### `DELETE /api/v1/media/:id`

**Auth:** Required (owner or ADMIN)
**Response 204:** Media scheduled for deletion (soft delete). Cloudinary deletion
happens asynchronously in the background.

---

### `POST /api/v1/media/webhook`

**Auth:** None — verified via `X-Cld-Signature` + `X-Cld-Timestamp` headers.

This endpoint is for Cloudinary only. Configure it in your Cloudinary dashboard
or via `npm run cloudinary:sync-presets` as the notification URL.

Always returns `200 { ok: true/false }` — never 4xx (to avoid Cloudinary retrying).

---

## Error codes

| Status | Code | When |
|---|---|---|
| 400 | `Bad Request` | Invalid purpose, content type not allowed, file too large, unknown transformation |
| 401 | `Unauthorized` | Missing or expired access token |
| 403 | `Forbidden` | Non-owner trying to access private asset or delete other's media |
| 404 | `Not Found` | Media ID not found, or asset not yet READY |
| 429 | `Too Many Requests` | Pending upload quota exceeded for this purpose |

---

## Delivery URL rules

| Delivery type | How URL is served | TTL |
|---|---|---|
| `UPLOAD` (public) | Plain CDN URL, no signature | Permanent (CDN cached) |
| `AUTHENTICATED` | Cloudinary signed URL | 5 minutes |
| `PRIVATE` | Cloudinary signed URL | 5 minutes |

Every access to `AUTHENTICATED` or `PRIVATE` assets is logged in `media_access_logs`
with the accessor ID, IP, and user agent.

---

## Security model

1. **Signed uploads only.** All upload presets have `unsigned: false`. Clients
   cannot alter the `public_id`, `folder`, `upload_preset`, `context`, or
   `timestamp` — those are covered by the SHA-256 signature with a 10-minute TTL.

2. **No overwrite.** Every upload gets a new UUID-based `public_id`. Replacing an
   avatar means a new upload → new `publicId` → update reference → schedule old
   asset for deletion. The CDN never serves stale content.

3. **Env isolation.** `CLOUDINARY_ENV_PREFIX` (e.g. `prod`, `staging`, `dev`)
   prefixes every `public_id` and folder. Dev and prod can share one Cloudinary
   account without files colliding.

4. **Strict transformations.** Named transformations are created with
   `allowed_for_strict: true`. Enable "Strict Transformations" in the Cloudinary
   Security settings to block all ad-hoc transformation strings from being served
   via CDN. See: [Cloudinary strict transformations](https://cloudinary.com/documentation/control_access_to_media#strict_transformations).

5. **Webhook replay protection.** The webhook handler rejects:
   - Missing `X-Cld-Signature` or `X-Cld-Timestamp` headers
   - Timestamps older than 5 minutes (replay attack prevention)
   - Signatures that don't match SHA-1(body + timestamp + api_secret)

6. **Idempotency.** The `idempotency_key` column (`asset_id:version`) prevents
   duplicate webhook deliveries from creating duplicate READY records.

---

## Operations

### First-time setup

```bash
# 1. Set env vars (see .env.example for the full list)
CLOUDINARY_CLOUD_NAME=u1dad45h
CLOUDINARY_API_KEY=513673348573289
CLOUDINARY_API_SECRET=<your_secret>
CLOUDINARY_WEBHOOK_URL=https://your-api.example.com/api/v1/media/webhook
CLOUDINARY_ENV_PREFIX=prod

# 2. Sync upload presets and named transformations
npm run cloudinary:sync-presets

# 3. Run the database migration
npx prisma migrate deploy
```

### Cancelling failed uploads

If a deploy ever served signed uploads against a Cloudinary account whose
presets were missing (Cloudinary responds `{"error":{"message":"Upload preset
not found"}}`), those uploads never stored an asset and leave `PENDING` rows in
the `media` table. After correcting the configuration, cancel them with:

```bash
npm run cloudinary:cancel-failed-uploads      # cancels PENDING rows older than 10 min (the signature TTL)
# MAX_AGE_MINUTES=60 npm run cloudinary:cancel-failed-uploads   # custom cutoff
```

Stale `PENDING` rows whose uploads *did* reach Cloudinary are handled
automatically by the orphan cleanup cron (see _Orphan cleanup cron_ below).

### Automatic preset sync on deploy

`render.yaml` runs `npm run cloudinary:sync-presets` as a `postdeploy` hook on
every Render deploy, so the upload presets always exist before the service
receives traffic. The required Cloudinary secrets are set in the Render
dashboard (they are never committed to version control).

### Cloudinary console steps (manual)

1. **Set webhook URL.** In Settings → Notifications (or handled automatically by
   `sync-presets` via `notification_url` on each preset).

2. **Enable Strict Transformations** (recommended for production).
   Settings → Security → Strict Transformations → Enable.
   This ensures only named transformations (`listing_card`, `avatar_sm`, etc.) can
   be served; arbitrary `c_fill,w_999` strings are blocked at the CDN level.

3. **Optional: Enable Cloudinary Moderation add-on** for auto-moderation of ID
   documents. The `sc_student_id` preset references `aws_rek` moderation but it
   only activates if the add-on is enabled on your account.

### Orphan cleanup cron

The `MEDIA_CLEANUP_QUEUE` expects a recurring job. Schedule it externally or add
a repeatable job at app startup:

```ts
// In your bootstrap or a startup hook:
import { Queue } from 'bullmq';
const cleanupQueue = app.get<Queue>(getQueueToken(MEDIA_CLEANUP_QUEUE));
await cleanupQueue.add('cleanup', {}, {
  repeat: { pattern: '*/30 * * * *' }, // every 30 minutes
  jobId: 'media-cleanup-cron',
});
```

---

## Known limits at scale (1 M concurrent users)

| Limit | Impact | Mitigation |
|---|---|---|
| Cloudinary Admin API: 500 req/min (free), 2000/min (paid) | `deleteAsset` uses the Admin API | BullMQ deletion queue with `limiter: { max: 10, duration: 1000 }`; never call Admin API in request path |
| Cloudinary bandwidth: depends on plan | High video delivery | Use Cloudinary's built-in CDN (100+ PoPs); upgrade plan as needed |
| Cloudinary storage: depends on plan | Accumulation of orphaned PENDING records | 30-minute orphan cleanup cron |
| Cloudinary transformations: derived assets cached but billed by count | Unbounded transformation strings | Strict Transformations enabled; named-only policy |
| Webhook delivery: Cloudinary retries up to 10× over ~1 hour | Must be idempotent | `idempotency_key` unique index in DB; duplicate detection in webhook processor |
| Signature TTL: 10 minutes | Client must upload within window | Increase `SIGNATURE_TTL_SECONDS` in `cloudinary.provider.ts` if needed |
| Prisma connection pool: limited per instance | Webhook bursts hitting DB | Webhook handler enqueues immediately and returns; DB work is in workers |
