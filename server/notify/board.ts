import { DISCORD_WEBHOOK_PATTERN, type LibraryBoardSettings } from '../../shared/notifications.js';
import type { Database } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import type { LibraryService } from '../library/library.js';
import { DiscordError, type DiscordEmbed, upsertWebhookMessage } from './discord.js';
import { NotifyError, webhookHint } from './notifier.js';

const KEY = 'libraryBoard';
const UPDATE_EVERY_MS = 60 * 60_000;
const COLOUR = 0xef4444;

interface Stored {
  webhookUrl: string | null;
  /** Libraries to leave off the board. New libraries show up automatically. */
  hiddenLibraryIds: string[];
  messageId: string | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A message in a Discord channel listing every library and how much is in
 * it. Posted once, then edited every hour, so the channel doesn't fill up.
 */
export class LibraryBoard {
  private readonly settings: SettingsStore;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly library: LibraryService,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.settings = new SettingsStore(db);
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.update().catch(() => {});
      this.timer = setTimeout(tick, UPDATE_EVERY_MS);
    };
    this.timer = setTimeout(tick, 2 * 60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private stored(): Stored {
    return { webhookUrl: null, hiddenLibraryIds: [], messageId: null, lastUpdatedAt: null, lastError: null, ...(this.settings.get<Stored>(KEY)?.value ?? {}) };
  }

  private save(next: Stored, by: string | null): void {
    this.settings.set(KEY, next, by);
  }

  view(): LibraryBoardSettings {
    const s = this.stored();
    return {
      webhookHint: s.webhookUrl ? webhookHint(s.webhookUrl) : null,
      hiddenLibraryIds: s.hiddenLibraryIds,
      lastUpdatedAt: s.lastUpdatedAt,
      lastError: s.lastError,
    };
  }

  async configure(input: { webhookUrl?: string | null; hiddenLibraryIds?: string[] }, by: string): Promise<LibraryBoardSettings> {
    const current = this.stored();
    const next: Stored = { ...current };
    if (input.webhookUrl === null || input.webhookUrl === '') {
      Object.assign(next, { webhookUrl: null, messageId: null, lastError: null });
    } else if (typeof input.webhookUrl === 'string') {
      const value = input.webhookUrl.trim();
      if (!DISCORD_WEBHOOK_PATTERN.test(value)) throw new NotifyError('That isn’t a Discord webhook address. It should start with https://discord.com/api/webhooks/.');
      // A new webhook means a new message in (maybe) a new channel.
      if (value !== current.webhookUrl) Object.assign(next, { webhookUrl: value, messageId: null, lastError: null });
    }
    if (input.hiddenLibraryIds) next.hiddenLibraryIds = [...new Set(input.hiddenLibraryIds.map(String))];
    this.save(next, by);
    if (next.webhookUrl) await this.update();
    return this.view();
  }

  /** Post or edit the message now. */
  async update(): Promise<void> {
    const s = this.stored();
    if (!s.webhookUrl) return;
    if (!this.library.libraries().status.ready) return; // counts would be partial
    try {
      const messageId = await upsertWebhookMessage(s.webhookUrl, s.messageId, this.embeds(s.hiddenLibraryIds), this.fetchImpl);
      this.save({ ...this.stored(), messageId, lastUpdatedAt: new Date().toISOString(), lastError: null }, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.save({ ...this.stored(), lastError: message }, null);
      if (err instanceof DiscordError) this.log(`Library board not updated: ${message}`);
      throw new NotifyError(message);
    }
  }

  /** The message: one block for movies, one for TV, each library on its own line. */
  embeds(hidden: string[] = this.stored().hiddenLibraryIds): DiscordEmbed[] {
    const shown = this.library.libraries().libraries.filter((l) => !hidden.includes(l.id));
    // New this week, per library: films for movie libraries, episodes for TV.
    const newThisWeek = new Map(
      (
        this.db
          .prepare(
            `SELECT j.value AS id, SUM(c.type = 'movie') AS movies, SUM(c.type = 'episode') AS episodes
             FROM catalog_items c, json_each(c.library_ids) j WHERE c.added_at >= ? GROUP BY j.value`,
          )
          .all(new Date(Date.now() - 7 * 86_400_000).toISOString()) as { id: string; movies: number; episodes: number }[]
      ).map((r) => [r.id, r]),
    );
    const isMovies = (type: string | null) => (type ?? '').startsWith('movie');
    const groups = [
      { title: '🎬 Movies', libraries: shown.filter((l) => isMovies(l.type)), kind: 'movie' as const, count: (l: (typeof shown)[number]) => l.movies },
      { title: '📺 TV shows', libraries: shown.filter((l) => !isMovies(l.type)), kind: 'series' as const, count: (l: (typeof shown)[number]) => l.shows },
    ].filter((g) => g.libraries.length);

    const embeds = groups.map((g): DiscordEmbed => {
      // A title in several libraries (say, 1080p and 4K) counts once in the total.
      const distinct = this.distinctTitles(g.kind, g.libraries.map((l) => l.id));
      const noun = g.kind === 'movie' ? (distinct === 1 ? 'movie' : 'movies') : distinct === 1 ? 'show' : 'shows';
      const lines = g.libraries.map((l) => {
        const fresh = newThisWeek.get(l.id);
        const n = g.kind === 'movie' ? (fresh?.movies ?? 0) : (fresh?.episodes ?? 0);
        const added = n ? ` · +${n.toLocaleString('en')} ${g.kind === 'movie' ? 'this week' : `new ${n === 1 ? 'episode' : 'episodes'} this week`}` : '';
        return `**${escape(l.name)}**: ${g.count(l).toLocaleString('en')}${added}`;
      });
      return {
        title: `${g.title}: ${distinct.toLocaleString('en')} ${noun}`,
        description: `${g.libraries.length} ${g.libraries.length === 1 ? 'library' : 'libraries'}\n\n${lines.join('\n')}`.slice(0, 4096),
        color: COLOUR,
      };
    });
    if (!embeds.length) return [{ title: 'No libraries to show', color: COLOUR }];
    const last = embeds[embeds.length - 1]!;
    last.footer = { text: 'Updated every hour by Almanac' };
    last.timestamp = new Date().toISOString();
    return embeds;
  }

  private distinctTitles(type: 'movie' | 'series', libraryIds: string[]): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT c.content_id) AS n FROM catalog_items c, json_each(c.library_ids) j
         WHERE c.type = ? AND j.value IN (SELECT value FROM json_each(?))`,
      )
      .get(type, JSON.stringify(libraryIds)) as { n: number };
    return row.n;
  }
}

function escape(text: string): string {
  return text.replace(/([\\*_~`|[\]])/g, '\\$1');
}
