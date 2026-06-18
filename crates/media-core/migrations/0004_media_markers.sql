-- Intro/credit markers (M6 — "Skip Intro" / "Skip Credits" bucket).
--
-- A marker is a property of the TITLE, shared across all viewers (an episode's
-- intro is the same span for everyone), so it is keyed on
-- (media_kind, media_id, marker_type) — NOT per-user `sub` like watch state.
-- At most one intro and one credits span per item. `source` records how the
-- marker was set (manual edit, imported from an external source, or auto-detected
-- by a future detector).
CREATE TABLE media_markers (
  media_kind  TEXT NOT NULL CHECK (media_kind IN ('movie','episode')),
  media_id    INTEGER NOT NULL,
  marker_type TEXT NOT NULL CHECK (marker_type IN ('intro','credits')),
  start_secs  INTEGER NOT NULL,
  end_secs    INTEGER NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (media_kind, media_id, marker_type)
);

CREATE INDEX media_markers_by_item ON media_markers(media_kind, media_id);
