import { DISCORD_WEBHOOK_PATTERN, type StatusBoardMonitor, type StatusBoardSettings } from '../../shared/notifications.js';
import type { Database } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import { type DiscordEmbed, upsertWebhookMessage } from './discord.js';
import { NotifyError, webhookHint } from './notifier.js';

const KEY = 'statusBoard';
const CHECK_EVERY_MS = 2 * 60_000;

interface Stored {
  /** The Uptime Kuma status page, e.g. https://uptime.example.com/status/main */
  pageUrl: string | null;
  /** Optional Cloudflare Access service token, for a status page behind Access. */
  accessClientId: string | null;
  accessClientSecret: string | null;
  webhookUrl: string | null;
  messageId: string | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
  monitors: StatusBoardMonitor[];
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Uptime Kuma's heartbeat states. */
const KUMA = { down: 0, up: 1, pending: 2, maintenance: 3 } as const;

/**
 * A Discord message showing each server on an Uptime Kuma status page with a
 * coloured dot and its uptime today, edited every couple of minutes.
 */
export class StatusBoard {
  private readonly settings: SettingsStore;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    db: Database,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.settings = new SettingsStore(db);
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.update().catch(() => {});
      this.timer = setTimeout(tick, CHECK_EVERY_MS);
    };
    this.timer = setTimeout(tick, 60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private stored(): Stored {
    return {
      pageUrl: null,
      accessClientId: null,
      accessClientSecret: null,
      webhookUrl: null,
      messageId: null,
      lastUpdatedAt: null,
      lastError: null,
      monitors: [],
      ...(this.settings.get<Stored>(KEY)?.value ?? {}),
    };
  }

  view(): StatusBoardSettings {
    const s = this.stored();
    return {
      pageUrl: s.pageUrl,
      accessTokenSet: Boolean(s.accessClientId && s.accessClientSecret),
      webhookHint: s.webhookUrl ? webhookHint(s.webhookUrl) : null,
      lastUpdatedAt: s.lastUpdatedAt,
      lastError: s.lastError,
      monitors: s.monitors,
    };
  }

  async configure(
    input: { pageUrl?: string | null; webhookUrl?: string | null; accessClientId?: string | null; accessClientSecret?: string | null },
    by: string,
  ): Promise<StatusBoardSettings> {
    const next = this.stored();
    if (input.pageUrl !== undefined) {
      const value = (input.pageUrl ?? '').trim();
      if (value) parsePageUrl(value); // throws a readable error
      next.pageUrl = value || null;
    }
    if (input.webhookUrl === null || input.webhookUrl === '') Object.assign(next, { webhookUrl: null, messageId: null });
    else if (typeof input.webhookUrl === 'string') {
      const value = input.webhookUrl.trim();
      if (!DISCORD_WEBHOOK_PATTERN.test(value)) throw new NotifyError('That isn’t a Discord webhook address. It should start with https://discord.com/api/webhooks/.');
      if (value !== next.webhookUrl) Object.assign(next, { webhookUrl: value, messageId: null });
    }
    if (input.accessClientId !== undefined) next.accessClientId = (input.accessClientId ?? '').trim() || null;
    if (input.accessClientSecret !== undefined) next.accessClientSecret = (input.accessClientSecret ?? '').trim() || null;
    next.lastError = null;
    this.settings.set(KEY, next, by);
    if (next.pageUrl) await this.update(true);
    return this.view();
  }

  /** Read the status page and, if there's a webhook, update the Discord message. */
  async update(throwErrors = false): Promise<void> {
    const s = this.stored();
    if (!s.pageUrl) return;
    try {
      const monitors = await this.read(s);
      let messageId = s.messageId;
      if (s.webhookUrl) messageId = await upsertWebhookMessage(s.webhookUrl, s.messageId, [statusEmbed(monitors)], this.fetchImpl);
      this.settings.set(KEY, { ...this.stored(), monitors, messageId, lastUpdatedAt: new Date().toISOString(), lastError: null }, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== s.lastError) this.log(`Server status not updated: ${message}`);
      this.settings.set(KEY, { ...this.stored(), lastError: message }, null);
      if (throwErrors) throw new NotifyError(message);
    }
  }

  private async read(s: Stored): Promise<StatusBoardMonitor[]> {
    const { base, slug } = parsePageUrl(s.pageUrl!);
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'Almanac' };
    if (s.accessClientId && s.accessClientSecret) {
      headers['CF-Access-Client-Id'] = s.accessClientId;
      headers['CF-Access-Client-Secret'] = s.accessClientSecret;
    }
    const get = async <T>(path: string): Promise<T> => {
      let res: Response;
      try {
        res = await this.fetchImpl(`${base}${path}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        throw new Error(`Couldn’t reach the status page: ${err instanceof Error ? err.message : String(err)}`);
      }
      const location = res.headers.get('location') ?? '';
      if ((res.status >= 300 && res.status < 400 && location.includes('cloudflareaccess.com')) || res.status === 403) {
        throw new Error(
          s.accessClientId
            ? 'Cloudflare Access didn’t let the service token through. In Zero Trust, the Uptime Kuma application needs a policy whose action is “Service Auth” (not “Allow”) that includes this token. If it has one, the secret may not match: make a new token and paste both parts again.'
            : 'The status page is behind a Cloudflare Access login. Give Almanac a service token (below), or add a bypass rule for /api/status-page/*.',
        );
      }
      if (res.status === 404) throw new Error(`Uptime Kuma has no status page called “${slug}”.`);
      if (!res.ok) throw new Error(`The status page answered ${res.status}.`);
      if (!(res.headers.get('content-type') ?? '').includes('json')) {
        throw new Error('The status page sent a web page instead of data. Is it Uptime Kuma, and is a login (like Cloudflare Access) in front of it?');
      }
      return (await res.json()) as T;
    };
    const page = await get<KumaStatusPage>(`/api/status-page/${encodeURIComponent(slug)}`);
    const beats = await get<KumaHeartbeats>(`/api/status-page/heartbeat/${encodeURIComponent(slug)}`);
    return toMonitors(page, beats);
  }
}

/** Accepts the status page's address (…/status/slug) and works out where its data is. */
export function parsePageUrl(url: string): { base: string; slug: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NotifyError('Enter the status page’s full address, like https://uptime.example.com/status/main');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new NotifyError('The status page address should start with https://');
  const match = parsed.pathname.match(/^(.*)\/status\/([\w-]+)\/?$/);
  if (!match) throw new NotifyError('That doesn’t look like an Uptime Kuma status page. Its address ends in /status/ and the page’s name.');
  return { base: `${parsed.origin}${match[1]}`, slug: match[2]! };
}

interface KumaStatusPage {
  publicGroupList?: { name?: string; monitorList?: { id: number; name: string }[] }[];
}
interface KumaHeartbeats {
  heartbeatList?: Record<string, { status: number; time: string; msg?: string }[]>;
  uptimeList?: Record<string, number>;
}

export function toMonitors(page: KumaStatusPage, beats: KumaHeartbeats, now = Date.now()): StatusBoardMonitor[] {
  const monitors: StatusBoardMonitor[] = [];
  for (const group of page.publicGroupList ?? []) {
    for (const m of group.monitorList ?? []) {
      const list = beats.heartbeatList?.[String(m.id)] ?? [];
      const latest = list[list.length - 1];
      const state =
        !latest ? 'unknown' : latest.status === KUMA.up ? 'up' : latest.status === KUMA.down ? 'down' : latest.status === KUMA.maintenance ? 'maintenance' : 'pending';
      // How long it has been down: back through the heartbeats to the last good one.
      let downSince: string | null = null;
      if (state === 'down') {
        let i = list.length - 1;
        while (i > 0 && list[i - 1]!.status === KUMA.down) i--;
        const at = kumaTime(list[i]!.time);
        if (at && at <= now && now - at < 30 * 86_400_000) downSince = new Date(at).toISOString();
      }
      const uptime = beats.uptimeList?.[`${m.id}_24`];
      monitors.push({
        name: m.name,
        group: group.name ?? null,
        state,
        uptimeToday: typeof uptime === 'number' && Number.isFinite(uptime) ? uptime : null,
        downSince,
      });
    }
  }
  return monitors;
}

/** Kuma sends "2026-11-25 01:12:00.123" (UTC) or an ISO time. */
function kumaTime(time: string): number | null {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(time) ? time : `${time.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

const DOT: Record<StatusBoardMonitor['state'], string> = { up: '🟢', down: '🔴', pending: '🟡', maintenance: '🔧', unknown: '⚪' };

export function statusLine(m: StatusBoardMonitor, now = Date.now()): string {
  const name = `**${m.name.replace(/([\\*_~`|[\]])/g, '\\$1')}**`;
  if (m.state === 'down') {
    const minutes = m.downSince ? Math.max(1, Math.round((now - Date.parse(m.downSince)) / 60_000)) : null;
    const length = minutes == null ? '' : minutes < 60 ? ` for ${minutes} min` : ` for ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    return `${DOT.down} ${name}: down${length}`;
  }
  if (m.state === 'maintenance') return `${DOT.maintenance} ${name}: maintenance`;
  if (m.state === 'pending') return `${DOT.pending} ${name}: checking`;
  if (m.state === 'unknown') return `${DOT.unknown} ${name}: no checks yet`;
  return `${DOT.up} ${name}: ${formatUptime(m.uptimeToday)} today`;
}

function formatUptime(ratio: number | null): string {
  if (ratio == null) return 'up';
  const pct = ratio * 100;
  if (pct >= 99.995) return '100%';
  // Two decimals, as Uptime Kuma shows it (99.86%).
  return `${(Math.floor(pct * 100) / 100).toFixed(2)}%`;
}

export function statusEmbed(monitors: StatusBoardMonitor[], now = Date.now()): DiscordEmbed {
  const groups = [...new Set(monitors.map((m) => m.group ?? ''))];
  const sections = groups.map((g) => {
    const lines = monitors.filter((m) => (m.group ?? '') === g).map((m) => statusLine(m, now));
    return groups.length > 1 && g ? `__${g}__\n${lines.join('\n')}` : lines.join('\n');
  });
  const anyDown = monitors.some((m) => m.state === 'down');
  const anyIssue = monitors.some((m) => m.state === 'pending' || m.state === 'maintenance');
  return {
    title: '🖥️ Server status',
    description: (sections.join('\n\n') || 'No servers on the status page.').slice(0, 4096),
    color: anyDown ? 0xd03b3b : anyIssue ? 0xfab219 : 0x0ca30c,
    footer: { text: 'Checked every 2 minutes by Almanac' },
    timestamp: new Date(now).toISOString(),
  };
}
