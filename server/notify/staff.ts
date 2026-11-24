import { DISCORD_WEBHOOK_PATTERN } from '../../shared/notifications.js';
import { FLAG_GROUP, GROUP_LABELS, type Severity } from '../../shared/moderation.js';
import type { FlagAlertLevel, StaffAlertsSettings } from '../../shared/reliability.js';
import type { FlagEvent } from '../moderation/service.js';
import type { Database } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import { DiscordError, type DiscordEmbed, postToDiscord } from './discord.js';
import { NotifyError, webhookHint } from './notifier.js';

const KEY = 'staffAlerts';

interface Stored {
  webhookUrl: string | null;
  reliability: boolean;
  flagLevel: FlagAlertLevel;
  /** Almanac's own address, from the browser that saved these settings, for links in posts. */
  baseUrl: string | null;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
const SEVERITY_LABEL: Record<Severity, string> = { low: 'Minor', medium: 'Worth a look', high: 'Serious' };
const SEVERITY_COLOUR: Record<Severity, number> = { low: 0x737373, medium: 0xfab219, high: 0xd03b3b };
const REASON_LABEL: Record<FlagEvent['reason'], string> = { new: 'New flag', worse: 'Flag got more serious', reopened: 'Reviewed flag is back' };
/** More flags than this at once (say, after an update adds a check) become one summary post. */
const MAX_SEPARATE_POSTS = 5;

interface AlertState {
  alerting: boolean;
  lastAlertAt: string | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A Discord channel for staff: alerts about the server rather than new content. */
export class StaffAlerts {
  private readonly settings: SettingsStore;

  constructor(
    private readonly db: Database,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.settings = new SettingsStore(db);
  }

  private stored(): Stored {
    return { webhookUrl: null, reliability: true, flagLevel: 'medium', baseUrl: null, ...(this.settings.get<Stored>(KEY)?.value ?? {}) };
  }

  state(): AlertState {
    return { alerting: false, lastAlertAt: null, ...(this.settings.get<AlertState>(`${KEY}.reliabilityState`)?.value ?? {}) };
  }

  setState(state: AlertState): void {
    this.settings.set(`${KEY}.reliabilityState`, state, null);
  }

  view(): StaffAlertsSettings {
    const s = this.stored();
    const state = this.state();
    return {
      webhookHint: s.webhookUrl ? webhookHint(s.webhookUrl) : null,
      reliability: s.reliability,
      flagLevel: s.flagLevel,
      lastAlertAt: state.lastAlertAt,
      alerting: state.alerting,
    };
  }

  update(input: { webhookUrl?: string | null; reliability?: boolean; flagLevel?: FlagAlertLevel; baseUrl?: string | null }, by: string): StaffAlertsSettings {
    const current = this.stored();
    let webhookUrl = current.webhookUrl;
    if (input.webhookUrl === null || input.webhookUrl === '') webhookUrl = null;
    else if (typeof input.webhookUrl === 'string') {
      const value = input.webhookUrl.trim();
      if (!DISCORD_WEBHOOK_PATTERN.test(value)) throw new NotifyError('That isn’t a Discord webhook address. It should start with https://discord.com/api/webhooks/.');
      webhookUrl = value;
    }
    if (input.flagLevel !== undefined && !['off', 'high', 'medium', 'low'].includes(input.flagLevel)) throw new NotifyError('Unknown flag alert level.');
    const baseUrl = input.baseUrl && /^https?:\/\/[^/\s]+$/.test(input.baseUrl) ? input.baseUrl : current.baseUrl;
    const next: Stored = { webhookUrl, reliability: input.reliability ?? current.reliability, flagLevel: input.flagLevel ?? current.flagLevel, baseUrl };
    this.settings.set(KEY, next, by);
    return this.view();
  }

  /** Almanac's own address (learned when the staff settings were saved), for links. */
  baseUrl(): string | null {
    return this.stored().baseUrl;
  }

  /** Post anything to the staff channel, if there is one. */
  async post(embed: DiscordEmbed): Promise<void> {
    if (!this.stored().webhookUrl) return;
    await this.send(embed);
  }

  /** Is this kind of alert turned on, with somewhere to send it? */
  wants(kind: 'reliability'): boolean {
    const s = this.stored();
    return Boolean(s.webhookUrl) && s[kind];
  }

  /** Post new, worse or reopened flags at or above the chosen severity. */
  async flagAlerts(events: FlagEvent[]): Promise<number> {
    const s = this.stored();
    if (!s.webhookUrl || s.flagLevel === 'off') return 0;
    const wanted = events.filter((e) => SEVERITY_RANK[e.severity] >= SEVERITY_RANK[s.flagLevel as Severity]);
    if (!wanted.length) return 0;
    const link = (e: FlagEvent) => (s.baseUrl ? `${s.baseUrl}/users/${encodeURIComponent(e.userId)}` : undefined);

    if (wanted.length > MAX_SEPARATE_POSTS) {
      const sorted = [...wanted].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
      const lines = sorted.slice(0, 25).map((e) => {
        const name = link(e) ? `[${escape(e.username)}](${link(e)})` : `**${escape(e.username)}**`;
        return `${SEVERITY_LABEL[e.severity]} · ${name} · ${escape(e.headline)}`;
      });
      if (sorted.length > 25) lines.push(`…and ${sorted.length - 25} more on the Moderation page`);
      await this.send({
        author: { name: 'Almanac · moderation' },
        title: `${wanted.length} new flags`,
        url: s.baseUrl ? `${s.baseUrl}/moderation` : undefined,
        description: lines.join('\n'),
        color: SEVERITY_COLOUR[sorted[0]!.severity],
        footer: { text: 'Almanac' },
        timestamp: new Date().toISOString(),
      });
      return wanted.length;
    }

    for (const e of wanted) {
      await this.send({
        author: { name: `${REASON_LABEL[e.reason]} · ${GROUP_LABELS[FLAG_GROUP[e.kind]].title}` },
        title: e.headline,
        url: link(e),
        description: [`**${escape(e.username)}**${e.email ? ` · ${escape(e.email)}` : ''}`, ...e.details.map(discordTimes)].join('\n'),
        fields: [{ name: 'Severity', value: SEVERITY_LABEL[e.severity], inline: true }],
        color: SEVERITY_COLOUR[e.severity],
        footer: { text: 'Almanac' },
        timestamp: new Date().toISOString(),
      });
    }
    return wanted.length;
  }

  async send(embed: DiscordEmbed): Promise<void> {
    const url = this.stored().webhookUrl;
    if (!url) throw new NotifyError('Add a staff webhook first.');
    try {
      await postToDiscord(url, [embed], this.fetchImpl);
    } catch (err) {
      if (err instanceof DiscordError) {
        this.log(`Staff alert not sent: ${err.message}`);
        throw new NotifyError(err.message);
      }
      throw err;
    }
  }

  async test(): Promise<void> {
    await this.send({
      author: { name: 'Almanac staff alerts' },
      title: 'Test alert',
      description: 'Server alerts will appear in this channel.',
      color: 0xef4444,
      footer: { text: 'Almanac · test message' },
      timestamp: new Date().toISOString(),
    });
  }
}

/** Flag text marks times as {{time:ISO}}; Discord shows <t:unix:f> in each reader's own time zone. */
function discordTimes(text: string): string {
  return text.replace(/\{\{time:([^}]+)\}\}/g, (_, iso: string) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : `<t:${Math.floor(ms / 1000)}:f>`;
  });
}

/** Stop names and emails being read as Discord formatting. Posts can't ping anyone (allowed_mentions is empty). */
function escape(text: string): string {
  return text.replace(/([\\*_~`|[\]])/g, '\\$1');
}
