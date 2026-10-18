-- Own artwork pipeline: one row per source image (a TMDB file name, an album,
-- an audiobook or a photo), keyed like the cache paths under <data>/images.
-- fetched_at/failed_at/attempts back the fetch-once + negative cache;
-- blurhash/width/height describe the oriented original.
CREATE TABLE IF NOT EXISTS images (
  key TEXT PRIMARY KEY,
  blurhash TEXT,
  width INTEGER,
  height INTEGER,
  fetched_at TEXT,
  failed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- Audiobook cover (embedded art extracted into the artwork dir, or folder art
-- beside the book), mirroring albums.art_path from 0008.
ALTER TABLE audiobooks ADD COLUMN art_path TEXT;
