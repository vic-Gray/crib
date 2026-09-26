ALTER TABLE "listings"
ADD COLUMN "discount_amount" INTEGER,
ADD COLUMN "location_reference" TEXT;

ALTER TABLE "listings"
ADD CONSTRAINT "listings_discount_amount_check"
CHECK ("discount_amount" IS NULL OR ("discount_amount" >= 0 AND "discount_amount" <= "price"));

ALTER TABLE "listing_photos"
ADD COLUMN "media_id" TEXT;

CREATE UNIQUE INDEX "listing_photos_media_id_key" ON "listing_photos"("media_id");

ALTER TABLE "listing_photos"
ADD CONSTRAINT "listing_photos_media_id_fkey"
FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "listing_videos" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_videos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "listing_videos_listing_id_key" ON "listing_videos"("listing_id");
CREATE UNIQUE INDEX "listing_videos_media_id_key" ON "listing_videos"("media_id");

ALTER TABLE "listing_videos"
ADD CONSTRAINT "listing_videos_listing_id_fkey"
FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "listing_videos"
ADD CONSTRAINT "listing_videos_media_id_fkey"
FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;