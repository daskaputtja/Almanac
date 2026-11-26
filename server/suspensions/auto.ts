import { FLAG_GROUP, type FlagKind } from '../../shared/moderation.js';
import { AUTO_REQUEST_KINDS, type AutoRequestSettings } from '../../shared/suspensions.js';
import type { Database } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import type { FlagEvent } from '../moderation/service.js';
import { SuspensionError, type SuspensionActor, type SuspensionService } from './suspensions.js';

const KEY = 'autoSuspensionRequests';
/** Requests filed by Almanac itself. A mod's role, so an admin still has to approve them. */
export const AUTO_ACTOR: SuspensionActor = { id: -1, name: 'Almanac (automatic)', role: 'mod' };

/**
 * When a chosen kind of flag becomes serious, file a suspension request with
 * the evidence as the reason. It waits for an admin like any mod's request:
 * nothing happens to the account until a person approves it.
 */
export class AutoRequests {
  private readonly settings: SettingsStore;

  constructor(
    private readonly db: Database,
    private readonly suspensions: SuspensionService,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.settings = new SettingsStore(db);
  }

  view(): AutoRequestSettings {
    const stored = this.settings.get<FlagKind[]>(KEY);
    return { kinds: stored?.value ?? [], updatedBy: stored?.updatedBy ?? null, updatedAt: stored?.updatedAt ?? null };
  }

  update(kinds: unknown, by: string): AutoRequestSettings {
    if (!Array.isArray(kinds) || kinds.some((k) => !AUTO_REQUEST_KINDS.includes(k as FlagKind))) throw new SuspensionError('Choose from the checks that can become serious.');
    this.settings.set(KEY, [...new Set(kinds as FlagKind[])], by);
    return this.view();
  }

  /** Called with new, worse or reopened flags. Returns the requests filed. */
  async onFlagEvents(events: FlagEvent[]): Promise<number> {
    const kinds = new Set(this.view().kinds);
    let filed = 0;
    for (const e of events) {
      if (e.severity !== 'high' || !kinds.has(e.kind)) continue;
      // Already turned off in Silo: nothing to ask for.
      const silo = this.db.prepare('SELECT enabled FROM silo_users WHERE id = ?').get(e.userId) as { enabled: number | null } | undefined;
      if (!silo || silo.enabled === 0) continue;
      const reason = `Automatic request (${FLAG_GROUP[e.kind] === 'ripping' ? 'possible ripping' : FLAG_GROUP[e.kind] === 'sharing' ? 'possible account sharing' : 'non-stop playback'}): ${e.headline}. ${e.details.map(plainTimes).join(' ')}`.slice(0, 1990);
      try {
        await this.suspensions.request(e.userId, 'suspend', reason, AUTO_ACTOR);
        filed++;
      } catch (err) {
        // Already a request waiting for this account: that one stands.
        if (err instanceof SuspensionError && err.status === 409) continue;
        this.log(`Automatic suspension request not filed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return filed;
  }
}

/** Flag text marks times as {{time:ISO}}; a request's reason is plain text, in UTC. */
function plainTimes(text: string): string {
  return text.replace(/\{\{time:([^}]+)\}\}/g, (_, iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : `${d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
  });
}
