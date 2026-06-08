import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations as runMigrations } from './migrator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations', 'iptv')

export interface IptvDb {
  raw: Database.Database
  /**
   * Re-run the migrator. Safe to call multiple times (idempotent).
   * Pass an open server.db handle to enable DESTRUCTIVE migration enforcement.
   */
  applyMigrations: (serverDb?: Database.Database) => void
  stmts: {
    upsertChannel: Database.Statement
    upsertVod: Database.Statement
    upsertSeries: Database.Statement
    upsertEpisode: Database.Statement
    upsertCategory: Database.Statement
    upsertEpg: Database.Statement
    addFavorite: Database.Statement
    removeFavorite: Database.Statement
    getFavorites: Database.Statement
    putHistory: Database.Statement
    getHistory: Database.Statement
    // Implicit-feedback wiring: read the prior watch row (transition detection)
    // and resolve an IPTV item_id to its TMDB id so a watch can be forwarded to
    // the recommender as a 'watched' positive signal.
    getHistoryItem: Database.Statement
    vodTmdbByStreamId: Database.Statement
    episodeSeriesTmdbByEpisodeId: Database.Statement
    putSyncState: Database.Statement
    getSyncState: Database.Statement
    // playlist token persistence (D12 / §6.2)
    insertPlaylistToken: Database.Statement
    getPlaylistToken: Database.Statement
    revokePlaylistToken: Database.Statement
    revokePlaylistTokensBySub: Database.Statement
    listPlaylistTokensBySub: Database.Statement
    listAllPlaylistTokens: Database.Statement
  }
  close: () => void
}

export function openIptvDb(filePath: string, serverDb?: Database.Database): IptvDb {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const raw = new Database(filePath)
  // Match the shared openDb() pragmas (server.db). Without busy_timeout a
  // concurrent reader/writer — or the VACUUM-INTO backup snapshot — fails
  // immediately with SQLITE_BUSY instead of briefly waiting for the lock.
  raw.pragma('busy_timeout = 5000')
  raw.pragma('journal_mode = WAL')
  raw.pragma('synchronous = NORMAL')
  raw.pragma('foreign_keys = ON')

  const applyMigrations = (overrideServerDb?: Database.Database): void => {
    runMigrations({
      migrationsDir: MIGRATIONS_DIR,
      db: raw,
      serverDb: overrideServerDb ?? serverDb,
    })
  }

  // Apply at construction so callers can prepare statements immediately.
  applyMigrations()

  const stmts = {
    upsertChannel: raw.prepare(`
      INSERT INTO channels (stream_id, num, name, stream_icon, epg_channel_id, category_id,
        is_adult, tv_archive, tv_archive_duration, added_ts, fetched_at)
      VALUES (@stream_id, @num, @name, @stream_icon, @epg_channel_id, @category_id,
        @is_adult, @tv_archive, @tv_archive_duration, @added_ts, @fetched_at)
      ON CONFLICT(stream_id) DO UPDATE SET
        num=excluded.num, name=excluded.name, stream_icon=excluded.stream_icon,
        epg_channel_id=excluded.epg_channel_id, category_id=excluded.category_id,
        is_adult=excluded.is_adult, tv_archive=excluded.tv_archive,
        tv_archive_duration=excluded.tv_archive_duration, added_ts=excluded.added_ts,
        fetched_at=excluded.fetched_at
    `),
    upsertVod: raw.prepare(`
      INSERT INTO vod (stream_id, name, stream_icon, rating, category_id, container_extension,
        added_ts, tmdb_id, year, plot, director, cast_csv, fetched_at)
      VALUES (@stream_id, @name, @stream_icon, @rating, @category_id, @container_extension,
        @added_ts, @tmdb_id, @year, @plot, @director, @cast_csv, @fetched_at)
      ON CONFLICT(stream_id) DO UPDATE SET
        name=excluded.name, stream_icon=excluded.stream_icon, rating=excluded.rating,
        category_id=excluded.category_id, container_extension=excluded.container_extension,
        added_ts=excluded.added_ts, tmdb_id=excluded.tmdb_id, year=excluded.year,
        plot=excluded.plot, director=excluded.director, cast_csv=excluded.cast_csv,
        fetched_at=excluded.fetched_at
    `),
    upsertSeries: raw.prepare(`
      INSERT INTO series (series_id, name, cover, plot, rating, category_id, tmdb_id,
        last_modified, fetched_at)
      VALUES (@series_id, @name, @cover, @plot, @rating, @category_id, @tmdb_id,
        @last_modified, @fetched_at)
      ON CONFLICT(series_id) DO UPDATE SET
        name=excluded.name, cover=excluded.cover, plot=excluded.plot, rating=excluded.rating,
        category_id=excluded.category_id, tmdb_id=excluded.tmdb_id,
        last_modified=excluded.last_modified, fetched_at=excluded.fetched_at
    `),
    upsertEpisode: raw.prepare(`
      INSERT INTO series_episodes (episode_id, series_id, season, episode_num, title,
        container_extension, added_ts, plot, duration_secs)
      VALUES (@episode_id, @series_id, @season, @episode_num, @title,
        @container_extension, @added_ts, @plot, @duration_secs)
      ON CONFLICT(episode_id) DO UPDATE SET
        series_id=excluded.series_id, season=excluded.season, episode_num=excluded.episode_num,
        title=excluded.title, container_extension=excluded.container_extension,
        added_ts=excluded.added_ts, plot=excluded.plot, duration_secs=excluded.duration_secs
    `),
    upsertCategory: raw.prepare(`
      INSERT INTO categories (category_id, kind, name, parent_id)
      VALUES (@category_id, @kind, @name, @parent_id)
      ON CONFLICT(kind, category_id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id
    `),
    upsertEpg: raw.prepare(`
      INSERT INTO epg_programs (channel_id, start_utc, stop_utc, title, description)
      VALUES (@channel_id, @start_utc, @stop_utc, @title, @description)
      ON CONFLICT(channel_id, start_utc) DO UPDATE SET
        stop_utc=excluded.stop_utc, title=excluded.title, description=excluded.description
    `),
    addFavorite: raw.prepare(`
      INSERT OR IGNORE INTO iptv_favorites (sub, kind, item_id, added_ts)
      VALUES (@sub, @kind, @item_id, @added_ts)
    `),
    removeFavorite: raw.prepare(`
      DELETE FROM iptv_favorites WHERE sub=@sub AND kind=@kind AND item_id=@item_id
    `),
    getFavorites: raw.prepare(`
      SELECT sub, kind, item_id, added_ts
      FROM iptv_favorites
      WHERE sub = ?
      ORDER BY added_ts DESC
    `),
    putHistory: raw.prepare(`
      INSERT INTO iptv_watch_history (sub, kind, item_id, position_secs, duration_secs, watched_at, completed)
      VALUES (@sub, @kind, @item_id, @position_secs, @duration_secs, @watched_at, @completed)
      ON CONFLICT(sub, kind, item_id) DO UPDATE SET
        position_secs=excluded.position_secs, duration_secs=excluded.duration_secs,
        watched_at=excluded.watched_at, completed=excluded.completed
    `),
    getHistory: raw.prepare(`
      SELECT sub, kind, item_id, position_secs, duration_secs, watched_at, completed
      FROM iptv_watch_history
      WHERE sub = ?
      ORDER BY watched_at DESC
      LIMIT ?
    `),
    getHistoryItem: raw.prepare(`
      SELECT position_secs, duration_secs, completed
      FROM iptv_watch_history
      WHERE sub = @sub AND kind = @kind AND item_id = @item_id
    `),
    vodTmdbByStreamId: raw.prepare(`
      SELECT tmdb_id FROM vod WHERE stream_id = @stream_id
    `),
    episodeSeriesTmdbByEpisodeId: raw.prepare(`
      SELECT s.tmdb_id AS tmdb_id
      FROM series_episodes e
      JOIN series s ON s.series_id = e.series_id
      WHERE e.episode_id = @episode_id
    `),
    putSyncState: raw.prepare(`
      INSERT INTO iptv_sync_state (key, value, ts) VALUES (@key, @value, @ts)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts
    `),
    getSyncState: raw.prepare(`SELECT value, ts FROM iptv_sync_state WHERE key = ?`),
    // playlist token persistence (D12 / §6.2)
    insertPlaylistToken: raw.prepare(`
      INSERT INTO iptv_playlist_tokens (jti, sub, device_name, issued_at, expires_at, revoked_at)
      VALUES (@jti, @sub, @device_name, @issued_at, @expires_at, NULL)
    `),
    getPlaylistToken: raw.prepare(`
      SELECT jti, sub, device_name, issued_at, expires_at, revoked_at
      FROM iptv_playlist_tokens WHERE jti = ?
    `),
    revokePlaylistToken: raw.prepare(`
      UPDATE iptv_playlist_tokens SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL
    `),
    revokePlaylistTokensBySub: raw.prepare(`
      UPDATE iptv_playlist_tokens SET revoked_at = ? WHERE sub = ? AND revoked_at IS NULL
    `),
    listPlaylistTokensBySub: raw.prepare(`
      SELECT jti, sub, device_name, issued_at, expires_at, revoked_at
      FROM iptv_playlist_tokens WHERE sub = ? ORDER BY issued_at DESC
    `),
    listAllPlaylistTokens: raw.prepare(`
      SELECT jti, sub, device_name, issued_at, expires_at, revoked_at
      FROM iptv_playlist_tokens ORDER BY issued_at DESC
    `),
  }

  return { raw, applyMigrations, stmts, close: () => raw.close() }
}
