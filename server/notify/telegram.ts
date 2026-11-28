import type { TelegramBoard, TelegramChat, TelegramSettings } from '../../shared/notifications.js';
import type { Database } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import type { DiscordEmbed } from './discord.js';
import { NotifyError } from './notifier.js';

const KEY = 'telegram';
const API = 'https://api.telegram.org';
/** Telegram bot tokens look like 123456789:AA… */
const TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

interface Target {
  chatId: string | null;
  /** A topic in a group with topics (its message_thread_id), or null for the main chat. */
  threadId: number | null;
  messageId: number | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
}

interface Stored {
  token: string | null;
  botUsername: string | null;
  /** Groups and channels the bot has been added to (seen in its updates). */
  chats: TelegramChat[];
  targets: Record<TelegramBoard, Target>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const emptyTarget = (): Target => ({ chatId: null, threadId: null, messageId: null, lastUpdatedAt: null, lastError: null });

/**
 * Where a Telegram link points: "https://t.me/c/1234567890/33288" is topic 33288 in
 * the group -1001234567890 (a message link adds the message: …/33288/40000). A bare
 * number is taken as the topic.
 */
export function parseTopicLink(input: string): { chatId: string | null; threadId: number } | null {
  const text = input.trim();
  if (/^\d+$/.test(text)) return { chatId: null, threadId: Number(text) };
  const m = text.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/c\/(\d+)\/(\d+)(?:\/\d+)?\/?(?:\?.*)?$/i);
  return m ? { chatId: `-100${m[1]}`, threadId: Number(m[2]) } : null;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly description = '',
    readonly migrateTo: string | null = null,
  ) {
    super(message);
  }
}

/**
 * Telegram, through a bot the admin makes with @BotFather: the library counts
 * and server status boards as one message each in a group or channel,
 * edited in place, like the Discord ones.
 */
export class TelegramService {
  private readonly settings: SettingsStore;
  /** A board asks to be re-published after its target changes. */
  onTargetChanged: ((board: TelegramBoard) => Promise<void>) | null = null;

  constructor(
    db: Database,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.settings = new SettingsStore(db);
  }

  private stored(): Stored {
    const s = this.settings.get<Stored>(KEY)?.value;
    return {
      token: s?.token ?? null,
      botUsername: s?.botUsername ?? null,
      chats: s?.chats ?? [],
      targets: { library: { ...emptyTarget(), ...(s?.targets?.library ?? {}) }, status: { ...emptyTarget(), ...(s?.targets?.status ?? {}) } },
    };
  }

  private save(s: Stored, by: string | null): void {
    this.settings.set(KEY, s, by);
  }

  view(): TelegramSettings {
    const s = this.stored();
    const title = (id: string | null) => s.chats.find((c) => c.id === id)?.title ?? null;
    const target = (t: Target) => ({ chatId: t.chatId, chatTitle: title(t.chatId), threadId: t.threadId, lastUpdatedAt: t.lastUpdatedAt, lastError: t.lastError });
    return {
      tokenSet: Boolean(s.token),
      botUsername: s.botUsername,
      chats: s.chats,
      targets: { library: target(s.targets.library), status: target(s.targets.status) },
    };
  }

  /** Save (or remove) the bot token. It's checked with Telegram first, and never shown again. */
  async setToken(token: string | null, by: string): Promise<TelegramSettings> {
    const s = this.stored();
    if (!token) {
      this.save({ token: null, botUsername: null, chats: [], targets: { library: emptyTarget(), status: emptyTarget() } }, by);
      return this.view();
    }
    const value = token.trim();
    if (!TOKEN_PATTERN.test(value)) throw new NotifyError('That doesn’t look like a bot token. @BotFather gives one like 123456789:AAH…');
    const me = await this.call<{ username: string }>(value, 'getMe', {}).catch((err: unknown) => {
      throw new NotifyError(err instanceof TelegramError && /unauthorized/i.test(err.description) ? 'Telegram doesn’t recognise that token. Copy it again from @BotFather.' : String((err as Error).message));
    });
    const changed = value !== s.token;
    this.save(
      {
        token: value,
        botUsername: me.username,
        chats: changed ? [] : s.chats,
        targets: changed ? { library: emptyTarget(), status: emptyTarget() } : s.targets,
      },
      by,
    );
    await this.findChats();
    return this.view();
  }

  /** Look for groups and channels the bot has been added to (Telegram keeps a day of its updates). */
  async findChats(): Promise<TelegramSettings> {
    const s = this.stored();
    if (!s.token) throw new NotifyError('Add the bot’s token first.');
    type Chat = { id: number; title?: string; type: string };
    const updates = await this.call<{ message?: { chat: Chat }; channel_post?: { chat: Chat }; my_chat_member?: { chat: Chat; new_chat_member?: { status: string } } }[]>(
      s.token,
      'getUpdates',
      { allowed_updates: ['message', 'channel_post', 'my_chat_member'] },
    );
    const chats = new Map(s.chats.map((c) => [c.id, c]));
    for (const u of updates) {
      const chat = u.my_chat_member?.chat ?? u.message?.chat ?? u.channel_post?.chat;
      if (!chat || !['group', 'supergroup', 'channel'].includes(chat.type)) continue;
      // Removed from a group: forget it.
      if (u.my_chat_member && ['left', 'kicked'].includes(u.my_chat_member.new_chat_member?.status ?? '')) {
        chats.delete(String(chat.id));
        continue;
      }
      chats.set(String(chat.id), { id: String(chat.id), title: chat.title ?? `Chat ${chat.id}`, type: chat.type as TelegramChat['type'] });
    }
    this.save({ ...this.stored(), chats: [...chats.values()] }, null);
    return this.view();
  }

  /** Choose where a board goes (null: not to Telegram), and publish it there now. */
  async setTarget(board: TelegramBoard, chatId: string | null, by: string, topic?: string | null): Promise<TelegramSettings> {
    const s = this.stored();
    if (chatId !== null && !s.chats.some((c) => c.id === chatId)) throw new NotifyError('Choose one of the groups the bot is in.');
    let threadId = topic === undefined ? s.targets[board].threadId : null;
    if (topic) {
      const parsed = parseTopicLink(topic);
      if (!parsed) throw new NotifyError('Paste the topic’s link (in Telegram: open the topic, then Copy Link), like https://t.me/c/1234567890/33288.');
      if (parsed.chatId && chatId && parsed.chatId !== chatId) throw new NotifyError('That topic is in a different group from the one chosen.');
      threadId = parsed.threadId;
    }
    if (s.targets[board].chatId !== chatId || s.targets[board].threadId !== threadId) s.targets[board] = { ...emptyTarget(), chatId, threadId };
    this.save(s, by);
    if (chatId) await this.onTargetChanged?.(board);
    return this.view();
  }

  /** Does this board go to Telegram? */
  wants(board: TelegramBoard): boolean {
    const s = this.stored();
    return Boolean(s.token && s.targets[board].chatId);
  }

  /** Post the board's message, or edit the one posted before. */
  async publish(board: TelegramBoard, embeds: DiscordEmbed[]): Promise<void> {
    const s = this.stored();
    const t = s.targets[board];
    if (!s.token || !t.chatId) return;
    const text = embedsToTelegramHtml(embeds);
    try {
      const messageId = await this.upsert(s.token, t, text);
      const now = this.stored();
      now.targets[board] = { ...now.targets[board], chatId: t.chatId, messageId, lastUpdatedAt: new Date().toISOString(), lastError: null };
      this.save(now, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const now = this.stored();
      if (message !== now.targets[board].lastError) this.log(`Telegram ${board} message not updated: ${message}`);
      now.targets[board] = { ...now.targets[board], lastError: message };
      this.save(now, null);
    }
  }

  private async upsert(token: string, t: Target, text: string): Promise<number> {
    const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
    if (t.messageId) {
      try {
        await this.call(token, 'editMessageText', { chat_id: t.chatId, message_id: t.messageId, text, ...opts });
        return t.messageId;
      } catch (err) {
        if (err instanceof TelegramError && /message is not modified/i.test(err.description)) return t.messageId;
        // Deleted, or too old to edit: post a new one.
        if (!(err instanceof TelegramError && /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(err.description))) throw err;
      }
    }
    try {
      const sent = await this.call<{ message_id: number }>(token, 'sendMessage', { chat_id: t.chatId, text, disable_notification: true, ...(t.threadId ? { message_thread_id: t.threadId } : {}), ...opts });
      return sent.message_id;
    } catch (err) {
      // A group that became a supergroup has a new ID.
      if (err instanceof TelegramError && err.migrateTo) {
        t.chatId = err.migrateTo;
        const sent = await this.call<{ message_id: number }>(token, 'sendMessage', { chat_id: t.chatId, text, disable_notification: true, ...(t.threadId ? { message_thread_id: t.threadId } : {}), ...opts });
        return sent.message_id;
      }
      throw err;
    }
  }

  private async call<T>(token: string, method: string, body: Record<string, unknown>, attempt = 0): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new TelegramError(`Couldn’t reach Telegram: ${err instanceof Error ? err.message : String(err)}`);
    }
    const json = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number; migrate_to_chat_id?: number } } | null;
    if (json?.ok) return json.result as T;
    const description = json?.description ?? `HTTP ${res.status}`;
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, Math.min(30, json?.parameters?.retry_after ?? 3) * 1000));
      return this.call<T>(token, method, body, 1);
    }
    const migrate = json?.parameters?.migrate_to_chat_id;
    const friendly = /topic_closed|TOPIC_CLOSED/i.test(description)
      ? 'That topic is closed, so only admins can post in it. Make the bot an admin of the group with “Manage topics”.'
      : /thread not found|TOPIC_DELETED|message thread not found/i.test(description)
        ? 'Telegram can’t find that topic. Copy its link again (open the topic, then Copy Link).'
        : /bot was kicked|chat not found|not a member|have no rights|not enough rights/i.test(description)
      ? `The bot can’t post there (${description}). Add it to the group again, or make it an admin of the channel.`
      : `Telegram: ${description}`;
    throw new TelegramError(friendly, description, migrate ? String(migrate) : null);
  }
}

/** Discord's embeds as Telegram HTML: bold titles, the same lines, the footer in italics. */
export function embedsToTelegramHtml(embeds: DiscordEmbed[]): string {
  const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const markdown = (text: string) =>
    html(text)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^\\*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\\([\\*_~`|[\]])/g, '$1');
  const parts = embeds.map((e) => {
    const lines: string[] = [];
    if (e.title) lines.push(`<b>${html(e.title)}</b>`);
    if (e.description) lines.push(markdown(e.description));
    for (const f of e.fields ?? []) lines.push(`<b>${html(f.name)}</b>\n${markdown(f.value)}`);
    if (e.footer?.text) lines.push(`<i>${html(e.footer.text)}</i>`);
    return lines.join('\n\n');
  });
  const text = parts.join('\n\n');
  return text.length > 4096 ? `${text.slice(0, 4090)}…` : text;
}
