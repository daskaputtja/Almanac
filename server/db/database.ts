import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Each entry upgrades the schema by one version. Never edit a migration that
 * has shipped; add a new one instead. The schema version is SQLite's
 * `user_version`.
 */
const MIGRATIONS: string[] = [
  /* 1: play history and sync state */ `
    CREATE TABLE plays (
      session_id         TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL,
      username           TEXT NOT NULL,
      profile_id         TEXT NOT NULL,
      profile_name       TEXT,
      media_item_id      TEXT,
      media_file_id      TEXT,
      media_type         TEXT NOT NULL,
      title              TEXT NOT NULL,
      series_title       TEXT,
      season_number      INTEGER,
      episode_number     INTEGER,
      duration_seconds   REAL,
      started_at         TEXT NOT NULL,
      ended_at           TEXT NOT NULL,
      start_position     REAL,
      end_position       REAL NOT NULL,
      watched_seconds    REAL,
      paused_seconds     REAL,
      completed          INTEGER NOT NULL,
      play_method        TEXT NOT NULL,
      video_decision     TEXT,
      audio_decision     TEXT,
      client_name        TEXT,
      client_version     TEXT,
      device_platform    TEXT,
      device_id          TEXT,
      client_ip          TEXT,
      subtitle_language  TEXT,
      subtitle_codec     TEXT,
      end_reason         TEXT,
      lifecycle_seq      INTEGER,
      imported_at        TEXT NOT NULL
    );
    CREATE INDEX plays_ended_at ON plays (ended_at DESC);
    CREATE INDEX plays_user_ended_at ON plays (user_id, ended_at DESC);
    CREATE INDEX plays_media_item ON plays (media_item_id);

    CREATE TABLE sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `,
  /* 2: indexes for the History page's sort orders */ `
    CREATE INDEX plays_sort_user ON plays (username COLLATE NOCASE, ended_at DESC);
    CREATE INDEX plays_sort_title ON plays (COALESCE(NULLIF(series_title, ''), title) COLLATE NOCASE, ended_at DESC);
    CREATE INDEX plays_sort_watched ON plays (COALESCE(watched_seconds, 0), ended_at DESC);
  `,
  /* 3: the Statistics page filters and groups by when plays started */ `
    CREATE INDEX plays_started_at ON plays (started_at);
    CREATE INDEX plays_user_started_at ON plays (user_id, started_at);
  `,
  /* 4: Silo accounts, libraries and catalog */ `
    CREATE TABLE silo_users (
      id             TEXT PRIMARY KEY,
      username       TEXT NOT NULL,
      role           TEXT,
      enabled        INTEGER,
      is_owner       INTEGER,
      created_at     TEXT,
      last_active_at TEXT,
      synced_at      TEXT NOT NULL
    );

    CREATE TABLE libraries (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT,
      sort_order INTEGER,
      synced_at  TEXT NOT NULL
    );

    -- Movies and series are a full copy of Silo's catalog; episodes are kept
    -- only while recent, for the recently added feed.
    CREATE TABLE catalog_items (
      content_id     TEXT PRIMARY KEY,
      type           TEXT NOT NULL,
      title          TEXT NOT NULL,
      year           INTEGER,
      series_id      TEXT,
      series_title   TEXT,
      season_number  INTEGER,
      episode_number INTEGER,
      library_ids    TEXT NOT NULL,
      added_at       TEXT NOT NULL,
      poster_url     TEXT,
      genres         TEXT,
      rating_imdb    REAL,
      rating_tmdb    REAL,
      resolution     TEXT,
      dynamic_range  TEXT,
      codec_video    TEXT,
      file_size      INTEGER,
      synced_at      TEXT NOT NULL
    );
    CREATE INDEX catalog_type_added ON catalog_items (type, added_at DESC);
    CREATE INDEX catalog_series ON catalog_items (series_id);
  `,
  /* 5: plays per library match episodes to shows by title */ `
    CREATE INDEX IF NOT EXISTS catalog_type_title ON catalog_items (type, title);
  `,
  /* 6: Almanac's own accounts, two-factor authentication and sessions */ `
    CREATE TABLE auth_users (
      id                  INTEGER PRIMARY KEY,
      username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash       TEXT NOT NULL,
      totp_secret         TEXT,
      totp_enabled        INTEGER NOT NULL DEFAULT 0,
      totp_last_step      INTEGER,
      created_at          TEXT NOT NULL,
      password_changed_at TEXT NOT NULL
    );

    CREATE TABLE auth_recovery_codes (
      user_id   INTEGER NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used_at   TEXT,
      PRIMARY KEY (user_id, code_hash)
    );

    -- Tokens are stored hashed, so a copy of the database can't be used to sign in.
    -- stage: 'totp' (password checked, waiting for a code), 'enroll' (password
    -- checked, setting up 2FA) or 'full' (signed in).
    CREATE TABLE auth_sessions (
      token_hash     TEXT PRIMARY KEY,
      public_id      TEXT NOT NULL UNIQUE,
      user_id        INTEGER NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
      stage          TEXT NOT NULL,
      pending_secret TEXT,
      failed_codes   INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      last_seen_at   TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      ip             TEXT,
      user_agent     TEXT
    );
    CREATE INDEX auth_sessions_user ON auth_sessions (user_id);
  `,
  /* 7: account roles. Accounts that existed before roles are admins. */ `
    ALTER TABLE auth_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
  `,
  /* 8: moderation: account flags, notes and tags on Silo users */ `
    -- One row per user and kind of flag. Rows stay after the behaviour stops
    -- (active = 0) so a reviewed flag can reopen if it comes back worse.
    CREATE TABLE moderation_flags (
      user_id        TEXT NOT NULL,
      kind           TEXT NOT NULL,
      severity       TEXT NOT NULL,
      value          REAL NOT NULL,
      headline       TEXT NOT NULL,
      details        TEXT NOT NULL,
      admin_details  TEXT NOT NULL DEFAULT '[]',
      first_seen     TEXT NOT NULL,
      last_seen      TEXT NOT NULL,
      active         INTEGER NOT NULL DEFAULT 1,
      status         TEXT NOT NULL DEFAULT 'open',
      reviewed_by    TEXT,
      reviewed_at    TEXT,
      review_note    TEXT,
      reviewed_value REAL,
      PRIMARY KEY (user_id, kind)
    );

    CREATE TABLE user_notes (
      id          INTEGER PRIMARY KEY,
      user_id     TEXT NOT NULL,
      author_id   INTEGER,
      author_name TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX user_notes_user ON user_notes (user_id, created_at DESC);

    CREATE TABLE user_tags (
      user_id   TEXT NOT NULL,
      tag       TEXT NOT NULL COLLATE NOCASE,
      added_by  TEXT NOT NULL,
      added_at  TEXT NOT NULL,
      PRIMARY KEY (user_id, tag)
    );
  `,
  /* 9: settings changed from the dashboard, stored as JSON */ `
    CREATE TABLE app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );
  `,
];

export type Database = DatabaseSync;

/** Open (creating if needed) the database at `path` and bring its schema up to date. */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (current > MIGRATIONS.length) {
    throw new Error(
      `This database was created by a newer version of Almanac (schema ${current}, this version knows ${MIGRATIONS.length}). Update Almanac.`,
    );
  }

  for (let version = current; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
