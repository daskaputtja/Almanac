import { randomBytes } from 'node:crypto';
import {
  DISCORD_WEBHOOK_PATTERN,
  type NotificationsResponse,
  type NotifyChannel,
  type NotifyChannelInput,
  type NotifyLogEntry,
  type NotifyStatus,
  QUALITY_FILTERS,
  type QualityFilter,
} from '../../shared/notifications.js';
import type { Database } from '../db/database.js';
import type { CatalogPageQuery, SiloCatalogItem, SiloCollection } from '../silo/types.js';
import { DiscordError, type DiscordEmbed, episodeCode, episodesEmbed, movieEmbed, postToDiscord, summaryEmbed, versionsIn } from './discord.js';
import type { EpisodeMeta, MetadataService } from './metadata.js';

export interface NotifySource {
  listCatalogPage(query: CatalogPageQuery): Promise<SiloCollection<SiloCatalogItem>>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface NotifierOptions {
  fetchImpl?: FetchLike;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between posts to the same channel, to stay well inside Discord's limits. */
  gapMs?: number;
  pollMs?: number;
}

/** How often Silo is checked for new items. */
const POLL_MS = 2 * 60_000;
const FIRST_RUN_MS = 30_000;
/** Re-read a little before the last check, in case Silo recorded something late. */
const OVERLAP_MS = 15 * 60_000;
/** Episodes of a show are posted together once no more have arrived for this long… */
export const GROUP_QUIET_MS = 5 * 60_000;
/** …or once the first has waited this long, so a slow trickle still gets posted. */
const GROUP_MAX_WAIT_MS = 60 * 60_000;
/** A movie Silo hasn't matched yet waits up to this long for its details. */
export const MATCH_WAIT_MS = 30 * 60_000;
/** More messages than this for one channel at once (a big import) become one summary. */
export const FLOOD_LIMIT = 10;
const MAX_ATTEMPTS = 3;
const KEEP_LOG_MS = 30 * 86_400_000;
const GIVE_UP_MS = 3 * 86_400_000;
const MAX_PAGES = 10;
const LOOKUP_BATCH = 50;

export class NotifyError extends Error {}

interface ChannelRow {
  id: string;
  name: string;
  webhook_url: string;
  library_ids: string;
  quality: string;
  enabled: number;
  active_since: string;
  created_at: string;
  last_sent_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

interface ItemRow {
  channel_id: string;
  content_id: string;
  library_id: string;
  kind: 'movie' | 'episode';
  series_id: string | null;
  title: string;
  added_at: string;
  detected_at: string;
  item_json: string;
  status: NotifyStatus;
  attempts: number;
}

interface Message {
  rows: ItemRow[];
  label: string;
  build: () => Promise<DiscordEmbed>;
}

/**
 * Posts newly added movies and episodes to Discord. Each channel has its own
 * webhook and watches one or more Silo libraries; Silo tells us when each item
 * first appeared in each library, so a 4K copy of an old movie counts as new
 * in the 4K library.
 */
export class Notifier {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly fetchImpl: FetchLike;
  private readonly log: (message: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gapMs: number;

  constructor(
    private readonly db: Database,
    private readonly source: NotifySource,
    private readonly metadata: MetadataService,
    private readonly options: NotifierOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? console.log;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.gapMs = options.gapMs ?? 1500;
  }

  // --- Running -----------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.runOnce().catch((err) => this.log(`Notifications: ${err instanceof Error ? err.message : String(err)}`));
      this.timer = setTimeout(tick, this.options.pollMs ?? POLL_MS);
    };
    this.timer = setTimeout(tick, FIRST_RUN_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.detect(now);
      await this.deliver(now);
      this.prune(now);
    } finally {
      this.busy = false;
    }
  }

  /** Find items added to watched libraries since the last check and queue them for each channel. */
  async detect(now = Date.now()): Promise<void> {
    const channels = this.channelRows().filter((c) => c.enabled);
    const libraries = [...new Set(channels.flatMap((c) => parseIds(c.library_ids)))];
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO notify_items (channel_id, content_id, library_id, kind, series_id, title, added_at, detected_at, item_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const libraryId of libraries) {
      const cursorKey = `notify_cursor:${libraryId}`;
      const cursor = this.state(cursorKey);
      const since = new Date((cursor ? Date.parse(cursor) : now) - OVERLAP_MS).toISOString();
      try {
        for (const type of this.typesFor(libraryId)) {
          for (const item of await this.walk({ type, libraryId, addedAfter: since })) {
            for (const channel of channels) {
              if (!parseIds(channel.library_ids).includes(libraryId)) continue;
              if (item.added_at < channel.active_since) continue;
              if (!matchesQuality(item, libraryId, channel.quality as QualityFilter)) continue;
              insert.run(
                channel.id,
                item.content_id,
                libraryId,
                type,
                item.series_id ?? null,
                itemLabel(item),
                item.added_at,
                new Date(now).toISOString(),
                JSON.stringify(item),
              );
            }
          }
        }
        this.setState(cursorKey, new Date(now).toISOString());
      } catch (err) {
        this.log(`Notifications: couldn’t check library ${libraryId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Post whatever is ready: movies once matched, episodes once their show has gone quiet. */
  async deliver(now = Date.now()): Promise<void> {
    const pending = this.db.prepare("SELECT * FROM notify_items WHERE status = 'pending' ORDER BY added_at").all() as unknown as ItemRow[];
    if (!pending.length) return;

    const fresh = await this.refresh(pending);
    const seriesIds = [...new Set(pending.filter((r) => r.kind === 'episode' && r.series_id).map((r) => r.series_id!))];
    const series = await this.lookup(seriesIds, { type: 'series' });

    for (const channel of this.channelRows().filter((c) => c.enabled)) {
      const rows = pending.filter((r) => r.channel_id === channel.id);
      if (!rows.length) continue;
      const item = (r: ItemRow) => fresh.get(`${r.library_id}:${r.content_id}`) ?? (JSON.parse(r.item_json) as SiloCatalogItem);
      const gone = rows.filter((r) => fresh.has(`gone:${r.library_id}:${r.content_id}`));
      if (gone.length) this.mark(gone, 'skipped', 'Removed from Silo before it was posted');

      const messages: Message[] = [];
      for (const r of rows) {
        if (r.kind !== 'movie' || gone.includes(r)) continue;
        const movie = item(r);
        const matched = Boolean(movie.tmdb_id) || movie.status === 'matched';
        if (!matched && Date.parse(r.detected_at) > now - MATCH_WAIT_MS) continue;
        messages.push({
          rows: [r],
          label: itemLabel(movie),
          build: async () => movieEmbed(movie, r.library_id, this.libraryName(r.library_id), movie.tmdb_id ? await this.metadata.movie(movie.tmdb_id) : null),
        });
      }

      const groups = new Map<string, ItemRow[]>();
      for (const r of rows) {
        if (r.kind !== 'episode' || gone.includes(r)) continue;
        const key = `${r.library_id}:${r.series_id ?? item(r).series_title ?? r.content_id}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      for (const group of groups.values()) {
        const newest = Math.max(...group.map((r) => Date.parse(r.detected_at)));
        const oldest = Math.min(...group.map((r) => Date.parse(r.detected_at)));
        if (newest > now - GROUP_QUIET_MS && oldest > now - GROUP_MAX_WAIT_MS) continue;
        const episodes = group.map(item);
        const show = group[0]!.series_id ? (series.get(group[0]!.series_id) ?? null) : null;
        messages.push({
          rows: group,
          label: episodes.length === 1 ? itemLabel(episodes[0]!) : `${episodes[0]!.series_title ?? show?.title ?? 'Unknown show'} · ${episodes.length} episodes`,
          build: () => this.episodesMessage(show, episodes, group[0]!.library_id),
        });
      }
      if (!messages.length) continue;

      if (messages.length > FLOOD_LIMIT) {
        const libraryNames = [...new Set(messages.flatMap((m) => m.rows.map((r) => this.libraryName(r.library_id))))];
        const kinds = {
          movies: messages.filter((m) => m.rows[0]!.kind === 'movie').length,
          shows: messages.filter((m) => m.rows[0]!.kind === 'episode').length,
        };
        await this.send(channel, messages.flatMap((m) => m.rows), async () => summaryEmbed(messages.map((m) => m.label), libraryNames, kinds));
        continue;
      }
      for (const [i, message] of messages.entries()) {
        if (i > 0) await this.sleep(this.gapMs);
        const ok = await this.send(channel, message.rows, message.build);
        if (!ok) break; // the webhook is broken or Discord is struggling: try the rest next time
      }
    }
  }

  // --- Managing channels -------------------------------------------------------

  overview(): NotificationsResponse {
    const libraries = this.db.prepare('SELECT id, name, type FROM libraries ORDER BY sort_order, name').all() as unknown as NotificationsResponse['libraries'];
    return { channels: this.channels(), libraries, keys: this.metadata.status(), log: this.recent() };
  }

  channels(): NotifyChannel[] {
    const waiting = new Map(
      (this.db.prepare("SELECT channel_id, COUNT(*) AS n FROM notify_items WHERE status = 'pending' GROUP BY channel_id").all() as unknown as { channel_id: string; n: number }[]).map(
        (r) => [r.channel_id, r.n],
      ),
    );
    return this.channelRows().map((c) => ({
      id: c.id,
      name: c.name,
      webhookHint: webhookHint(c.webhook_url),
      libraryIds: parseIds(c.library_ids),
      quality: c.quality as QualityFilter,
      enabled: Boolean(c.enabled),
      createdAt: c.created_at,
      lastSentAt: c.last_sent_at,
      lastError: c.last_error,
      lastErrorAt: c.last_error_at,
      waiting: waiting.get(c.id) ?? 0,
    }));
  }

  create(input: NotifyChannelInput, by: string): NotifyChannel {
    const name = this.validName(input.name);
    const webhook = validWebhook(input.webhookUrl);
    const libraryIds = this.validLibraries(input.libraryIds);
    const quality = validQuality(input.quality ?? 'any');
    const id = randomBytes(6).toString('base64url');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO notify_channels (id, name, webhook_url, library_ids, quality, enabled, active_since, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, name, webhook, JSON.stringify(libraryIds), quality, now, by, now);
    return this.channels().find((c) => c.id === id)!;
  }

  update(id: string, input: NotifyChannelInput): NotifyChannel {
    const current = this.channelRow(id);
    const name = input.name === undefined ? current.name : this.validName(input.name);
    const webhook = input.webhookUrl?.trim() ? validWebhook(input.webhookUrl) : current.webhook_url;
    const libraryIds = input.libraryIds === undefined ? parseIds(current.library_ids) : this.validLibraries(input.libraryIds);
    const quality = input.quality === undefined ? current.quality : validQuality(input.quality);
    const enabled = input.enabled === undefined ? Boolean(current.enabled) : Boolean(input.enabled);
    const now = new Date().toISOString();
    // Turning a channel back on, or fixing its webhook, starts afresh rather than posting everything missed.
    const restart = (enabled && !current.enabled) || webhook !== current.webhook_url;
    this.db
      .prepare(
        `UPDATE notify_channels SET name = ?, webhook_url = ?, library_ids = ?, quality = ?, enabled = ?,
           active_since = CASE WHEN ? THEN ? ELSE active_since END,
           last_error = CASE WHEN ? THEN NULL ELSE last_error END,
           last_error_at = CASE WHEN ? THEN NULL ELSE last_error_at END
         WHERE id = ?`,
      )
      .run(name, webhook, JSON.stringify(libraryIds), quality, enabled ? 1 : 0, restart ? 1 : 0, now, restart ? 1 : 0, restart ? 1 : 0, id);
    if (restart || !enabled) {
      this.db.prepare("UPDATE notify_items SET status = 'skipped', error = ? WHERE channel_id = ? AND status = 'pending'").run(
        enabled ? 'Skipped when the webhook was changed' : 'Skipped because the channel was turned off',
        id,
      );
    }
    return this.channels().find((c) => c.id === id)!;
  }

  remove(id: string): void {
    this.channelRow(id);
    this.db.prepare('DELETE FROM notify_items WHERE channel_id = ?').run(id);
    this.db.prepare('DELETE FROM notify_channels WHERE id = ?').run(id);
  }

  /** Post the most recently added item in the channel's libraries, marked as a test. */
  async test(id: string): Promise<{ title: string }> {
    const channel = this.channelRow(id);
    const libraries = parseIds(channel.library_ids);
    const latest = this.db
      .prepare(
        `SELECT c.content_id, l.value AS library_id FROM catalog_items c, json_each(c.library_ids) l
         WHERE c.type IN ('movie', 'episode') AND l.value IN (SELECT value FROM json_each(?))
         ORDER BY c.added_at DESC LIMIT 1`,
      )
      .get(JSON.stringify(libraries)) as { content_id: string; library_id: string } | undefined;
    if (!latest) {
      throw new NotifyError('Almanac hasn’t seen anything recently added to these libraries yet, so there’s nothing to post as a test.');
    }
    const found = await this.lookup([latest.content_id], { libraryId: latest.library_id });
    const item = found.get(latest.content_id);
    if (!item) throw new NotifyError('That item has just been removed from Silo. Try again in a few minutes.');

    let embed: DiscordEmbed;
    if (item.type === 'episode') {
      const series = item.series_id ? (await this.lookup([item.series_id], { type: 'series' })).get(item.series_id) ?? null : null;
      embed = await this.episodesMessage(series, [item], latest.library_id, true);
    } else {
      embed = movieEmbed(item, latest.library_id, this.libraryName(latest.library_id), item.tmdb_id ? await this.metadata.movie(item.tmdb_id) : null, true);
    }
    try {
      await postToDiscord(channel.webhook_url, [embed], this.fetchImpl, this.sleep);
    } catch (err) {
      if (err instanceof DiscordError) throw new NotifyError(err.message);
      throw err;
    }
    this.db.prepare('UPDATE notify_channels SET last_sent_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?').run(new Date().toISOString(), id);
    return { title: itemLabel(item) };
  }

  // --- Internals ---------------------------------------------------------------

  private async episodesMessage(series: SiloCatalogItem | null, episodes: SiloCatalogItem[], libraryId: string, test = false): Promise<DiscordEmbed> {
    const ids = { tvdbId: series?.tvdb_id, tmdbId: series?.tmdb_id };
    const show = ids.tvdbId || ids.tmdbId ? await this.metadata.show(ids) : null;
    const episodeMeta = new Map<string, EpisodeMeta>();
    if (show) {
      for (const season of new Set(episodes.map((e) => e.season_number).filter((s): s is number => s != null))) {
        for (const [number, meta] of await this.metadata.season(show, ids, season)) episodeMeta.set(`${season}:${number}`, meta);
      }
    }
    return episodesEmbed(series, episodes, libraryId, this.libraryName(libraryId), show, episodeMeta, test);
  }

  /** Post one message and record the outcome. Returns false if the channel should stop for now. */
  private async send(channel: ChannelRow, rows: ItemRow[], build: () => Promise<DiscordEmbed>): Promise<boolean> {
    const now = new Date().toISOString();
    try {
      await postToDiscord(channel.webhook_url, [await build()], this.fetchImpl, this.sleep);
      this.mark(rows, 'sent', null, now);
      this.db.prepare('UPDATE notify_channels SET last_sent_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?').run(now, channel.id);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof DiscordError && err.permanent;
      const attempts = this.db.prepare('UPDATE notify_items SET attempts = attempts + 1, error = ? WHERE channel_id = ? AND content_id = ?');
      for (const r of rows) attempts.run(message, r.channel_id, r.content_id);
      const exhausted = rows.filter((r) => permanent || r.attempts + 1 >= MAX_ATTEMPTS);
      if (exhausted.length) this.mark(exhausted, 'failed', message);
      this.db
        .prepare(`UPDATE notify_channels SET last_error = ?, last_error_at = ?${permanent ? ', enabled = 0' : ''} WHERE id = ?`)
        .run(permanent ? `${message} The channel has been turned off.` : message, now, channel.id);
      if (permanent) this.log(`Notifications: turned off "${channel.name}": ${message}`);
      return false;
    }
  }

  private mark(rows: ItemRow[], status: NotifyStatus, error: string | null, at = new Date().toISOString()): void {
    const statement = this.db.prepare('UPDATE notify_items SET status = ?, error = ?, sent_at = ? WHERE channel_id = ? AND content_id = ?');
    for (const r of rows) statement.run(status, error, status === 'sent' ? at : null, r.channel_id, r.content_id);
  }

  /**
   * Re-read waiting items from Silo, so posts use the latest details (Silo
   * often matches a new file a minute or two after finding it). Items Silo
   * no longer has come back under a "gone:" key.
   */
  private async refresh(rows: ItemRow[]): Promise<Map<string, SiloCatalogItem>> {
    const result = new Map<string, SiloCatalogItem>();
    const byLibrary = new Map<string, string[]>();
    for (const r of rows) byLibrary.set(r.library_id, [...new Set([...(byLibrary.get(r.library_id) ?? []), r.content_id])]);
    for (const [libraryId, ids] of byLibrary) {
      try {
        const found = await this.lookup(ids, { libraryId });
        for (const id of ids) {
          const item = found.get(id);
          result.set(item ? `${libraryId}:${id}` : `gone:${libraryId}:${id}`, item ?? ({} as SiloCatalogItem));
        }
      } catch {
        // Silo is unreachable: use what was stored when the item was found.
      }
    }
    return result;
  }

  private async lookup(ids: string[], query: Omit<CatalogPageQuery, 'contentIds'>): Promise<Map<string, SiloCatalogItem>> {
    const found = new Map<string, SiloCatalogItem>();
    for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
      const chunk = ids.slice(i, i + LOOKUP_BATCH);
      for (const item of await this.walk({ ...query, contentIds: chunk })) found.set(item.content_id, item);
    }
    return found;
  }

  private async walk(query: Omit<CatalogPageQuery, 'cursor'>): Promise<SiloCatalogItem[]> {
    const items: SiloCatalogItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.source.listCatalogPage({ limit: 200, ...query, cursor });
      items.push(...result.items);
      cursor = result.page?.has_more ? result.page.next_cursor : undefined;
      if (!cursor) break;
    }
    return items;
  }

  private typesFor(libraryId: string): ('movie' | 'episode')[] {
    const row = this.db.prepare('SELECT type FROM libraries WHERE id = ?').get(libraryId) as { type: string | null } | undefined;
    const type = (row?.type ?? '').toLowerCase();
    if (type.startsWith('movie')) return ['movie'];
    if (['series', 'shows', 'show', 'tv', 'tvshows'].includes(type)) return ['episode'];
    return ['movie', 'episode'];
  }

  private libraryName(id: string): string {
    const row = this.db.prepare('SELECT name FROM libraries WHERE id = ?').get(id) as { name: string } | undefined;
    return row?.name ?? `Library ${id}`;
  }

  private recent(): NotifyLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT i.channel_id, c.name AS channel_name, i.title, l.name AS library_name, i.status, i.detected_at, i.sent_at, i.error
         FROM notify_items i JOIN notify_channels c ON c.id = i.channel_id LEFT JOIN libraries l ON l.id = i.library_id
         ORDER BY COALESCE(i.sent_at, i.detected_at) DESC LIMIT 60`,
      )
      .all() as unknown as {
      channel_id: string;
      channel_name: string;
      title: string;
      library_name: string | null;
      status: NotifyStatus;
      detected_at: string;
      sent_at: string | null;
      error: string | null;
    }[];
    return rows.map((r) => ({
      channelId: r.channel_id,
      channelName: r.channel_name,
      title: r.title,
      libraryName: r.library_name,
      status: r.status,
      detectedAt: r.detected_at,
      sentAt: r.sent_at,
      error: r.error,
    }));
  }

  private prune(now: number): void {
    this.db.prepare("DELETE FROM notify_items WHERE status <> 'pending' AND detected_at < ?").run(new Date(now - KEEP_LOG_MS).toISOString());
    this.db
      .prepare("UPDATE notify_items SET status = 'skipped', error = 'Waited too long to be posted' WHERE status = 'pending' AND detected_at < ?")
      .run(new Date(now - GIVE_UP_MS).toISOString());
  }

  private channelRows(): ChannelRow[] {
    return this.db.prepare('SELECT * FROM notify_channels ORDER BY created_at').all() as unknown as ChannelRow[];
  }

  private channelRow(id: string): ChannelRow {
    const row = this.db.prepare('SELECT * FROM notify_channels WHERE id = ?').get(id) as unknown as ChannelRow | undefined;
    if (!row) throw new NotifyError('No such channel.');
    return row;
  }

  private validName(name: unknown): string {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || value.length > 80) throw new NotifyError('Give the channel a name (up to 80 characters).');
    return value;
  }

  private validLibraries(ids: unknown): string[] {
    if (!Array.isArray(ids) || !ids.length) throw new NotifyError('Choose at least one library.');
    const known = new Set((this.db.prepare('SELECT id FROM libraries').all() as unknown as { id: string }[]).map((r) => r.id));
    const clean = [...new Set(ids.map(String))];
    // Without libraries:read, Almanac doesn't know the names, so any ID is accepted.
    if (known.size && clean.some((id) => !known.has(id))) throw new NotifyError('One of those libraries doesn’t exist in Silo any more.');
    if (clean.some((id) => !/^[\w-]{1,64}$/.test(id))) throw new NotifyError('That isn’t a library ID.');
    return clean;
  }

  private state(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  private setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}

function parseIds(json: string): string[] {
  try {
    const ids = JSON.parse(json) as unknown;
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

function validWebhook(url: unknown): string {
  const value = typeof url === 'string' ? url.trim() : '';
  if (!DISCORD_WEBHOOK_PATTERN.test(value)) {
    throw new NotifyError('That isn’t a Discord webhook address. It should start with https://discord.com/api/webhooks/.');
  }
  return value;
}

function validQuality(value: unknown): QualityFilter {
  if (!QUALITY_FILTERS.some((q) => q.value === value)) throw new NotifyError('Unknown quality filter.');
  return value as QualityFilter;
}

/** "discord.com/api/webhooks/…1234" — enough to recognise, without the secret. */
export function webhookHint(url: string): string {
  const match = url.match(DISCORD_WEBHOOK_PATTERN);
  return match ? `discord.com/api/webhooks/…${match[1]!.slice(-4)}` : 'Discord webhook';
}

export function matchesQuality(item: SiloCatalogItem, libraryId: string, filter: QualityFilter): boolean {
  if (filter === 'any') return true;
  const versions = versionsIn(item, libraryId);
  return versions.some((v) => {
    const range = (v.dynamic_range ?? '').toLowerCase();
    if (filter === '4k') return v.resolution === '2160p' || v.resolution === '4320p';
    if (filter === 'dolby_vision') return range === 'dolby_vision';
    return range !== '' && range !== 'sdr';
  });
}

function itemLabel(item: SiloCatalogItem): string {
  if (item.type === 'episode') return `${item.series_title ?? 'Unknown show'} · ${episodeCode(item)}`;
  return `${item.title}${item.year ? ` (${item.year})` : ''}`;
}
