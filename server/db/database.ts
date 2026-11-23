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
