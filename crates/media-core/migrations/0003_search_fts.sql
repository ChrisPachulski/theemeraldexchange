-- media-core schema v3: case- and diacritic-insensitive library search (§7-7).
--
-- The list endpoints previously matched titles with `LIKE '%' || ? || '%'`,
-- which (a) cannot use the title index (leading wildcard → full table scan) and
-- (b) is ASCII-case-insensitive only with NO diacritic folding ('amelie' would
-- not match 'Amélie'). We add FTS5 virtual tables with the unicode61 tokenizer
-- and remove_diacritics=2, kept in sync via triggers, so MATCH folds both case
-- and diacritics AND avoids the full scan.
--
-- DECISION: FTS5 (token/prefix matching) replaces substring LIKE. For a media
-- library this is the better UX (whole-word + prefix matching with diacritic
-- folding) and the scalable choice on the App-Store trajectory; the queries
-- append '*' to the final term for prefix matching so partial typing still
-- matches. FTS5 ships in the SQLite bundled with sqlx's sqlite feature.

-- Movies: index title + overview.
CREATE VIRTUAL TABLE IF NOT EXISTS movies_fts USING fts5(
    title,
    overview,
    content='movies',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- Shows: index title + overview.
CREATE VIRTUAL TABLE IF NOT EXISTS shows_fts USING fts5(
    title,
    overview,
    content='shows',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- Episodes: index title only (the episodes table has no overview column).
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
    title,
    content='episodes',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- Backfill any rows that already exist (instances that predate this migration).
INSERT INTO movies_fts(rowid, title, overview)
    SELECT id, title, overview FROM movies;
INSERT INTO shows_fts(rowid, title, overview)
    SELECT id, title, overview FROM shows;
INSERT INTO episodes_fts(rowid, title)
    SELECT id, title FROM episodes;

-- Keep the FTS tables in sync. content=... makes these "external content"
-- tables, so deletes/updates use the special 'delete' command form.
CREATE TRIGGER IF NOT EXISTS movies_ai AFTER INSERT ON movies BEGIN
    INSERT INTO movies_fts(rowid, title, overview) VALUES (new.id, new.title, new.overview);
END;
CREATE TRIGGER IF NOT EXISTS movies_ad AFTER DELETE ON movies BEGIN
    INSERT INTO movies_fts(movies_fts, rowid, title, overview) VALUES ('delete', old.id, old.title, old.overview);
END;
CREATE TRIGGER IF NOT EXISTS movies_au AFTER UPDATE ON movies BEGIN
    INSERT INTO movies_fts(movies_fts, rowid, title, overview) VALUES ('delete', old.id, old.title, old.overview);
    INSERT INTO movies_fts(rowid, title, overview) VALUES (new.id, new.title, new.overview);
END;

CREATE TRIGGER IF NOT EXISTS shows_ai AFTER INSERT ON shows BEGIN
    INSERT INTO shows_fts(rowid, title, overview) VALUES (new.id, new.title, new.overview);
END;
CREATE TRIGGER IF NOT EXISTS shows_ad AFTER DELETE ON shows BEGIN
    INSERT INTO shows_fts(shows_fts, rowid, title, overview) VALUES ('delete', old.id, old.title, old.overview);
END;
CREATE TRIGGER IF NOT EXISTS shows_au AFTER UPDATE ON shows BEGIN
    INSERT INTO shows_fts(shows_fts, rowid, title, overview) VALUES ('delete', old.id, old.title, old.overview);
    INSERT INTO shows_fts(rowid, title, overview) VALUES (new.id, new.title, new.overview);
END;

CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
    INSERT INTO episodes_fts(rowid, title) VALUES (new.id, new.title);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
    INSERT INTO episodes_fts(episodes_fts, rowid, title) VALUES ('delete', old.id, old.title);
END;
CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
    INSERT INTO episodes_fts(episodes_fts, rowid, title) VALUES ('delete', old.id, old.title);
    INSERT INTO episodes_fts(rowid, title) VALUES (new.id, new.title);
END;
