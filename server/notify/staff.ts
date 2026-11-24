import { DISCORD_WEBHOOK_PATTERN } from '../../shared/notifications.js';
import type { StaffAlertsSettings } from '../../shared/reliability.js';
import type { Database } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import { DiscordError, type DiscordEmbed, postToDiscord } from './discord.js';
import { NotifyError, webhookHint } from './notifier.js';

const KEY = 'staffAlerts';

interface Stored {
  webhookUrl: string | null;
  reliability: boolean;
}

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
    return { webhookUrl: null, reliability: true, ...(this.settings.get<Stored>(KEY)?.value ?? {}) };
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
    return { webhookHint: s.webhookUrl ? webhookHint(s.webhookUrl) : null, reliability: s.reliability, lastAlertAt: state.lastAlertAt, alerting: state.alerting };
  }

  update(input: { webhookUrl?: string | null; reliability?: boolean }, by: string): StaffAlertsSettings {
    const current = this.stored();
    let webhookUrl = current.webhookUrl;
    if (input.webhookUrl === null || input.webhookUrl === '') webhookUrl = null;
    else if (typeof input.webhookUrl === 'string') {
      const value = input.webhookUrl.trim();
      if (!DISCORD_WEBHOOK_PATTERN.test(value)) throw new NotifyError('That isn’t a Discord webhook address. It should start with https://discord.com/api/webhooks/.');
      webhookUrl = value;
    }
    this.settings.set(KEY, { webhookUrl, reliability: input.reliability ?? current.reliability }, by);
    return this.view();
  }

  /** Is this kind of alert turned on, with somewhere to send it? */
  wants(kind: 'reliability'): boolean {
    const s = this.stored();
    return Boolean(s.webhookUrl) && s[kind];
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
