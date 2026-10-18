-- 0008_user_feedback_watched.sql
-- DESTRUCTIVE
-- (DROP TABLE below; the migrator requires this annotation and takes an
-- auto-backup of exchange.db before applying — see app/db.py _check_backup_gate.)
-- Add 'watched' to the user_feedback.signal CHECK so the implicit-feedback
-- loop can record what the household actually WATCHES (>=40% watched or
-- completed) as a positive engagement signal. 'watched' joins the engagement
-- tier (clicked/added) and feeds the recommender's positive centroid via
-- context.load_user_context, so watch behaviour now shapes recommendations.
--
-- SQLite cannot ALTER a CHECK constraint in place, so we rebuild the table
-- using the standard CREATE / INSERT / DROP / RENAME pattern (mirrors 0007).
-- user_feedback is small (per-user dot + engagement signals), so the copy is
-- cheap. No FKs reference it.

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS user_feedback_new;

CREATE TABLE user_feedback_new (
  sub     TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  tmdb_id INTEGER NOT NULL,
  signal  TEXT    NOT NULL CHECK (signal IN ('like','dislike','reject','shown','clicked','added','watched')),
  ts      TEXT    NOT NULL,
  PRIMARY KEY (sub, kind, tmdb_id, signal)
);

INSERT OR IGNORE INTO user_feedback_new (sub, kind, tmdb_id, signal, ts)
SELECT sub, kind, tmdb_id, signal, ts FROM user_feedback;

DROP TABLE user_feedback;
ALTER TABLE user_feedback_new RENAME TO user_feedback;

CREATE INDEX IF NOT EXISTS user_feedback_by_user ON user_feedback(sub, kind, ts DESC);

PRAGMA foreign_keys = ON;
