import type { Database } from './database.js';

/** Settings changed from the dashboard, kept as JSON in the database. */
export class SettingsStore {
  constructor(private readonly db: Database) {}

  get<T>(key: string): { value: T; updatedBy: string | null; updatedAt: string } | null {
    const row = this.db.prepare('SELECT value, updated_by, updated_at FROM app_settings WHERE key = ?').get(key) as
      | { value: string; updated_by: string | null; updated_at: string }
      | undefined;
    if (!row) return null;
    try {
      return { value: JSON.parse(row.value) as T, updatedBy: row.updated_by, updatedAt: row.updated_at };
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown, updatedBy: string | null): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), updatedBy, new Date().toISOString());
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }
}
