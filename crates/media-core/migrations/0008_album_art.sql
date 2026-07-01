-- Music v2: album artwork discovered during the scan. Either a folder image
-- (cover/folder/front/album.{jpg,png,webp} beside the tracks) or a JPEG the
-- scanner extracted from a track's embedded attached_pic into the artwork dir.
ALTER TABLE albums ADD COLUMN art_path TEXT;
