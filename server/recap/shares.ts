import { randomBytes } from 'node:crypto';
import type { Recap, RecapShare } from '../../shared/recap.js';
import type { Database } from '../db/database.js';
import type { RecapService } from './recap.js';

interface ShareRow {
  id: string;
  token: string;
  user_id: string;
  year: number;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  views: number;
  last_viewed_at: string | null;
}

export class ShareError extends Error {}

/**
 * Private links to one user's recap for one year. The token in the link is
 * 128 random bits; anyone with the link can see that recap and nothing else,
 * until it's revoked.
 */
export class RecapShares {
  constructor(
    private readonly db: Database,
    private readonly recaps: RecapService,
  ) {}

  create(userId: string, year: number, createdBy: string): RecapShare {
    // Check the user exists (throws for unknown users).
    this.recaps.get(year, userId);
    const id = randomBytes(6).toString('base64url');
    const token = randomBytes(16).toString('base64url');
    this.db
      .prepare('INSERT INTO recap_shares (id, token, user_id, year, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, token, userId, year, createdBy, new Date().toISOString());
    return this.list(userId).find((s) => s.id === id)!;
  }

  list(userId: string): RecapShare[] {
    const rows = this.db
      .prepare('SELECT * FROM recap_shares WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as unknown as ShareRow[];
    return rows.map((r) => ({
      id: r.id,
      path: `/r/${r.token}`,
      year: r.year,
      createdBy: r.created_by,
      createdAt: r.created_at,
      revoked: Boolean(r.revoked_at),
      views: r.views,
      lastViewedAt: r.last_viewed_at,
    }));
  }

  revoke(id: string): void {
    const result = this.db.prepare('UPDATE recap_shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id);
    if (result.changes === 0) throw new ShareError('No such link.');
  }

  /** The recap behind a link, trimmed to what the person it's for should see. Null if the link isn't valid. */
  open(token: string): Recap | null {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const row = this.db.prepare('SELECT * FROM recap_shares WHERE token = ? AND revoked_at IS NULL').get(token) as unknown as ShareRow | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE recap_shares SET views = views + 1, last_viewed_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    const recap = this.recaps.get(row.year, row.user_id);
    return {
      ...recap,
      // Only the year that was shared, and no internal IDs.
      availableYears: [row.year],
      user: recap.user ? { id: '', name: recap.user.name } : null,
      server: null,
    };
  }
}
