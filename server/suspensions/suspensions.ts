import { createHmac } from 'node:crypto';
import { can, type Role } from '../../shared/permissions.js';
import {
  type BillingPortalSettings,
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  type SuspensionAction,
  type SuspensionRequest,
  type SuspensionStatus,
  type SuspensionsResponse,
} from '../../shared/suspensions.js';
import type { Database } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import type { DiscordEmbed } from '../notify/discord.js';

const SETTINGS_KEY = 'billingPortal';

export class SuspensionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export interface SuspensionActor {
  /** Almanac account ID, for notes. */
  id: number;
  name: string;
  role: Role;
}

interface Stored {
  url: string | null;
  secret: string | null;
}

interface Row {
  id: number;
  user_id: string;
  username: string;
  email: string | null;
  action: SuspensionAction;
  reason: string;
  status: SuspensionStatus;
  requested_by: string;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  portal_message: string | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SuspensionHooks {
  /** Write a note on the user (who asked, why, what happened). */
  note: (userId: string, actor: SuspensionActor, text: string) => void;
  /** Tell staff (the staff Discord channel). Failures are ignored. */
  tellStaff?: (embed: DiscordEmbed) => Promise<void>;
  /** Almanac's own address, for links in staff posts. */
  baseUrl?: () => string | null;
}

/**
 * Suspensions go through the billing portal, which already turns Silo
 * accounts off for non-payment; Almanac's own Silo key stays read-only.
 * Mods ask, admins approve, and everything needs a written reason.
 */
export class SuspensionService {
  private readonly settings: SettingsStore;

  constructor(
    private readonly db: Database,
    private readonly hooks: SuspensionHooks,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.settings = new SettingsStore(db);
  }

  // --- Portal settings ---------------------------------------------------------

  portal(): BillingPortalSettings {
    const stored = this.settings.get<Stored>(SETTINGS_KEY);
    return {
      url: stored?.value.url ?? null,
      secretSet: Boolean(stored?.value.secret),
      updatedBy: stored?.updatedBy ?? null,
      updatedAt: stored?.updatedAt ?? null,
    };
  }

  configure(input: { url?: string | null; secret?: string | null }, by: string): BillingPortalSettings {
    const current = this.settings.get<Stored>(SETTINGS_KEY)?.value ?? { url: null, secret: null };
    let url = current.url;
    if (input.url !== undefined) {
      const value = (input.url ?? '').trim();
      if (value && !/^https?:\/\/[^\s]+$/i.test(value)) throw new SuspensionError('Enter the full address, starting with https://');
      url = value || null;
    }
    let secret = current.secret;
    if (input.secret !== undefined) {
      const value = (input.secret ?? '').trim();
      if (value && value.length < 24) throw new SuspensionError('Use a secret of at least 24 characters. A long random string is best.');
      secret = value || null;
    }
    this.settings.set(SETTINGS_KEY, { url, secret }, by);
    return this.portal();
  }

  /** Send a harmless "ping" so an admin can check the portal is set up to receive requests. */
  async testPortal(by: string): Promise<string> {
    return this.callPortal({ event: 'ping', requested_by: by });
  }

  // --- Requests ----------------------------------------------------------------

  list(options: { status?: SuspensionStatus; userId?: string } = {}): SuspensionsResponse {
    const where: string[] = [];
    const params: string[] = [];
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.userId) {
      where.push('user_id = ?');
      params.push(options.userId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM suspension_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC LIMIT 200`)
      .all(...params) as unknown as Row[];
    const portal = this.portal();
    return { requests: rows.map(toRequest), portalConfigured: Boolean(portal.url && portal.secretSet) };
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM suspension_requests WHERE status = 'pending'").get() as { n: number }).n;
  }

  /**
   * Ask for an account to be suspended or unsuspended. A mod's request waits
   * for an admin; an admin's goes to the portal straight away.
   */
  async request(userId: string, action: SuspensionAction, reason: string, actor: SuspensionActor): Promise<SuspensionRequest> {
    if (!can(actor.role, 'requestSuspension')) throw new SuspensionError('You can’t ask for suspensions.', 403);
    if (action !== 'suspend' && action !== 'unsuspend') throw new SuspensionError('Unknown action.');
    const text = validReason(reason);
    const user = this.db.prepare('SELECT username, email FROM silo_users WHERE id = ?').get(userId) as { username: string; email: string | null } | undefined;
    if (!user) throw new SuspensionError('No account with that ID in Silo.', 404);
    const waiting = this.db.prepare("SELECT id FROM suspension_requests WHERE user_id = ? AND status = 'pending'").get(userId);
    if (waiting) throw new SuspensionError('There’s already a request for this account waiting for an admin.', 409);

    const now = new Date().toISOString();
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO suspension_requests (user_id, username, email, action, reason, status, requested_by, requested_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(userId, user.username, user.email, action, text, actor.name, now).lastInsertRowid,
    );

    if (can(actor.role, 'reviewSuspension')) return this.carryOut(id, actor, null);

    this.hooks.note(userId, actor, `Asked for this account to be ${action === 'suspend' ? 'suspended' : 'unsuspended'}: ${text}\n(Waiting for an admin to review it.)`);
    void this.tell({
      author: { name: 'Almanac · needs an admin' },
      title: `${actor.name} asks to ${action} ${user.username}`,
      url: this.link(userId),
      description: [`**${escape(user.username)}**${user.email ? ` · ${escape(user.email)}` : ''}`, `Reason: ${escape(text)}`].join('\n'),
      color: action === 'suspend' ? 0xd03b3b : 0x0ca30c,
      footer: { text: 'Approve or reject it on the Moderation page' },
      timestamp: now,
    });
    return this.get(id);
  }

  /** An admin approves (the portal is told) or rejects (with a note saying why) a waiting request. */
  async review(id: number, decision: 'approve' | 'reject', note: string, actor: SuspensionActor): Promise<SuspensionRequest> {
    if (!can(actor.role, 'reviewSuspension')) throw new SuspensionError('Only admins can approve or reject requests.', 403);
    const row = this.row(id);
    if (row.status !== 'pending') throw new SuspensionError('That request has already been dealt with.', 409);
    if (decision === 'reject') {
      const why = validReason(note, 'Say why you’re rejecting it');
      this.db
        .prepare("UPDATE suspension_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?")
        .run(actor.name, new Date().toISOString(), why, id);
      this.hooks.note(row.user_id, actor, `Rejected ${row.requested_by}’s request to ${row.action} this account: ${why}`);
      return this.get(id);
    }
    return this.carryOut(id, actor, note.trim() || null);
  }

  /** Try a failed request again (say, the portal was down). */
  async retry(id: number, actor: SuspensionActor): Promise<SuspensionRequest> {
    if (!can(actor.role, 'reviewSuspension')) throw new SuspensionError('Only admins can do that.', 403);
    const row = this.row(id);
    if (row.status !== 'failed') throw new SuspensionError('Only failed requests can be tried again.', 409);
    return this.carryOut(id, actor, row.review_note);
  }

  // --- Internals ---------------------------------------------------------------

  private async carryOut(id: number, approver: SuspensionActor, note: string | null): Promise<SuspensionRequest> {
    const row = this.row(id);
    const now = new Date().toISOString();
    let status: SuspensionStatus = 'done';
    let message: string;
    try {
      message = await this.callPortal({
        event: row.action,
        request_id: row.id,
        user: { silo_id: row.user_id, username: row.username, email: row.email },
        reason: row.reason,
        requested_by: row.requested_by,
        approved_by: approver.name,
      });
    } catch (err) {
      status = 'failed';
      message = err instanceof Error ? err.message : String(err);
    }
    this.db
      .prepare('UPDATE suspension_requests SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, portal_message = ? WHERE id = ?')
      .run(status, approver.name, now, note, message, id);

    const verb = row.action === 'suspend' ? 'Suspended' : 'Lifted the suspension on';
    const asked = row.requested_by === approver.name ? '' : ` Asked for by ${row.requested_by}.`;
    this.hooks.note(
      row.user_id,
      approver,
      status === 'done'
        ? `${verb} this account through the billing portal.${asked} Reason: ${row.reason}${note ? `\nApproval note: ${note}` : ''}\nPortal: ${message}`
        : `Tried to ${row.action} this account through the billing portal, but it failed: ${message}${asked}\nReason: ${row.reason}`,
    );
    void this.tell({
      author: { name: status === 'done' ? 'Almanac · done' : 'Almanac · failed' },
      title:
        status === 'done'
          ? `${row.username} ${row.action === 'suspend' ? 'suspended' : 'unsuspended'}`
          : `Couldn’t ${row.action} ${row.username}`,
      url: this.link(row.user_id),
      description: [`Reason: ${escape(row.reason)}`, `By ${escape(approver.name)}${asked}`, `Portal: ${escape(message)}`].join('\n'),
      color: status === 'done' ? (row.action === 'suspend' ? 0xd03b3b : 0x0ca30c) : 0xfab219,
      footer: { text: 'Almanac' },
      timestamp: now,
    });
    return this.get(id);
  }

  /** Send one signed request to the portal. Returns its message, or throws a readable error. */
  private async callPortal(payload: Record<string, unknown>): Promise<string> {
    const stored = this.settings.get<Stored>(SETTINGS_KEY)?.value;
    if (!stored?.url || !stored.secret) throw new SuspensionError('The billing portal isn’t set up yet. An admin can add it in Settings.');
    const body = JSON.stringify({ ...payload, sent_at: new Date().toISOString() });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', stored.secret).update(`${timestamp}.${body}`).digest('hex');
    let res: Response;
    try {
      res = await this.fetchImpl(stored.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Almanac',
          'X-Almanac-Timestamp': timestamp,
          'X-Almanac-Signature': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Couldn’t reach the billing portal: ${err instanceof Error ? err.message : String(err)}`);
    }
    const reply = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    const said = (reply?.message ?? reply?.error ?? '').toString().slice(0, 500);
    if (res.ok) return said || 'OK';
    if (res.status === 401 || res.status === 403) throw new Error(`The billing portal refused the request (${res.status}). Check the secret matches on both sides.`);
    if (res.status === 404) throw new Error(`The billing portal doesn’t know this customer${said ? `: ${said}` : '.'}`);
    throw new Error(`The billing portal answered ${res.status}${said ? `: ${said}` : ''}`);
  }

  private async tell(embed: DiscordEmbed): Promise<void> {
    try {
      await this.hooks.tellStaff?.(embed);
    } catch {
      // No staff channel, or Discord is down: the request still stands.
    }
  }

  private link(userId: string): string | undefined {
    const base = this.hooks.baseUrl?.();
    return base ? `${base}/users/${encodeURIComponent(userId)}` : undefined;
  }

  private row(id: number): Row {
    const row = this.db.prepare('SELECT * FROM suspension_requests WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!row) throw new SuspensionError('No such request.', 404);
    return row;
  }

  private get(id: number): SuspensionRequest {
    return toRequest(this.row(id));
  }
}

function validReason(reason: unknown, label = 'Give a reason'): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < MIN_REASON_LENGTH) throw new SuspensionError(`${label} (at least ${MIN_REASON_LENGTH} characters).`);
  if (text.length > MAX_REASON_LENGTH) throw new SuspensionError(`Keep it under ${MAX_REASON_LENGTH} characters.`);
  return text;
}

function toRequest(r: Row): SuspensionRequest {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    email: r.email,
    action: r.action,
    reason: r.reason,
    status: r.status,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
    portalMessage: r.portal_message,
  };
}

function escape(text: string): string {
  return text.replace(/([\\*_~`|[\]])/g, '\\$1');
}
