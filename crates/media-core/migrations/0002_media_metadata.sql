-- media.db v2: TMDB enrichment metadata + show-name normalization & dedup.
--
-- (1) Add the columns enrichment lands in: movies.overview/poster_path and
--     shows.imdb_id/overview/poster_path. (2) Add shows.norm_title, the
--     canonical lowercase/year-stripped dedup key, backfill it for existing
--     rows using the same rule the Rust normalizer applies for the common
--     cases (lowercase, separators->space, collapse ws, strip a single
--     trailing 19xx/20xx year), repoint episodes to the lowest surviving show
--     id per norm_title, delete the now-orphaned duplicate shows, drop the old
--     non-unique title index, and add a UNIQUE index on norm_title so one
--     series maps to exactly one row going forward.

-- 1. New metadata columns ---------------------------------------------------
ALTER TABLE movies ADD COLUMN overview TEXT;
ALTER TABLE movies ADD COLUMN poster_path TEXT;

ALTER TABLE shows ADD COLUMN imdb_id TEXT;
ALTER TABLE shows ADD COLUMN overview TEXT;
ALTER TABLE shows ADD COLUMN poster_path TEXT;
ALTER TABLE shows ADD COLUMN norm_title TEXT;

-- 2. Backfill norm_title for existing rows ----------------------------------
-- Mirror the Rust normalize_show_name rule closely enough for legacy data:
-- lowercase, turn '.', '_', '-' into spaces, collapse runs of spaces, trim,
-- then strip a single trailing 4-digit 19xx/20xx year token. SQLite has no
-- regex, so the year strip is expressed as a guarded substring trim.
UPDATE shows
SET norm_title = TRIM(
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    LOWER(TRIM(title)),
    '.', ' '), '_', ' '), '-', ' '),
    '   ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' '), '  ', ' ')
);

-- Strip a single trailing year (e.g. "adventure time 2008" -> "adventure time").
UPDATE shows
SET norm_title = TRIM(SUBSTR(norm_title, 1, LENGTH(norm_title) - 5))
WHERE LENGTH(norm_title) > 5
  AND SUBSTR(norm_title, LENGTH(norm_title) - 4, 1) = ' '
  AND SUBSTR(norm_title, LENGTH(norm_title) - 3, 2) IN ('19', '20')
  AND SUBSTR(norm_title, LENGTH(norm_title) - 1, 1) BETWEEN '0' AND '9'
  AND SUBSTR(norm_title, LENGTH(norm_title), 1) BETWEEN '0' AND '9';

-- Collapse to non-empty; fall back to the lowercased raw title if blank.
UPDATE shows
SET norm_title = LOWER(TRIM(title))
WHERE norm_title IS NULL OR norm_title = '';

-- 3. Repoint episodes of duplicate shows onto the lowest surviving id -------
-- The canonical id per norm_title is MIN(id).
UPDATE episodes
SET show_id = (
  SELECT MIN(s2.id) FROM shows s2
  WHERE s2.norm_title = (SELECT s1.norm_title FROM shows s1 WHERE s1.id = episodes.show_id)
)
WHERE show_id IN (
  SELECT s.id FROM shows s
  WHERE s.id <> (
    SELECT MIN(s3.id) FROM shows s3 WHERE s3.norm_title = s.norm_title
  )
);

-- 4. Delete the now-orphaned duplicate show rows ----------------------------
DELETE FROM shows
WHERE id <> (
  SELECT MIN(s3.id) FROM shows s3 WHERE s3.norm_title = shows.norm_title
);

-- 5. Swap the non-unique title index for a UNIQUE norm_title index ----------
DROP INDEX IF EXISTS idx_shows_title;
CREATE UNIQUE INDEX idx_shows_norm_title ON shows(norm_title);
