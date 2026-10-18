-- 0007_google_auth_mode.sql — admit Google identities to the members allowlist.
--
-- The original relation is retained as members_pre_google for incident
-- recovery. Its existing globally named indexes follow it during the rename,
-- so the canonical relation receives new, non-conflicting index names.

ALTER TABLE members RENAME TO members_pre_google;

CREATE TABLE members (
  sub           TEXT PRIMARY KEY,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  auth_mode     TEXT NOT NULL CHECK (auth_mode IN ('plex','local','apple','google')),
  invited_by    TEXT,
  joined_at     TEXT NOT NULL,
  revoked_at    TEXT
);

INSERT INTO members (
  sub,
  display_name,
  role,
  auth_mode,
  invited_by,
  joined_at,
  revoked_at
)
SELECT
  sub,
  display_name,
  role,
  auth_mode,
  invited_by,
  joined_at,
  revoked_at
FROM members_pre_google;

CREATE INDEX members_v2_by_revoked ON members(revoked_at);
CREATE INDEX members_v2_by_invited_by ON members(invited_by);
