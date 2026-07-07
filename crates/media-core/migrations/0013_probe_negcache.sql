-- Negative-result cache for ffprobe failures.
--
-- A file whose ffprobe fails (corrupt/truncated container, or a hung probe that
-- hits the 30s timeout) never gets a media_files row, so the unchanged-file
-- skip could not see it and the scanner re-probed it on EVERY scan forever --
-- up to 30s each per pass while the scan guard blocks manual scans, and the
-- episode never appears in the library. This table caches the failure keyed on
-- the file path with the (size_bytes, mtime) observed at failure time. An
-- unchanged failing file is skipped until the cooldown elapses (mirroring the
-- 0009 episode negcache), but a re-encoded file -- new size/mtime -- is probed
-- immediately. `error` records the ProbeError variant (timeout vs non-zero exit
-- with stderr) so the Mandalorian/Wednesday root cause is diagnosable from
-- GET /scan/status. A successful probe clears the row.
CREATE TABLE IF NOT EXISTS probe_failures (
    path       TEXT PRIMARY KEY,
    size_bytes INTEGER NOT NULL,
    mtime      TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    failed_at  TEXT NOT NULL,
    error      TEXT
);
