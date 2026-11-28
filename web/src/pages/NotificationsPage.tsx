import { useCallback, useEffect, useState } from 'react';
import {
  DISCORD_WEBHOOK_PATTERN,
  type StatusBoardMonitor,
  type NotificationsResponse,
  type NotifyChannel,
  type NotifyLogEntry,
  QUALITY_FILTERS,
  type QualityFilter,
} from '../../../shared/notifications';
import { FLAG_ALERT_LEVELS } from '../../../shared/reliability';
import type { TelegramBoard, TelegramSettings } from '../../../shared/notifications';
import { ApiError, api } from '../lib/api';
import { formatFullDate, formatWhen } from '../lib/format';

const input = 'rounded-lg border border-line bg-canvas px-3 py-2 text-sm placeholder:text-ink-faint focus:border-accent-dim focus:outline-none';
const primary = 'rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-canvas hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50';
const secondary = 'rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent-dim disabled:opacity-50';

type Libraries = NotificationsResponse['libraries'];

/** Admins: recently added posts to Discord, one webhook per channel. */
export function NotificationsPage() {
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<NotificationsResponse>('/api/notifications')
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t load notifications.'));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="text-sm text-ink-muted">
          Post newly added movies and episodes to Discord. Each channel gets its own webhook and chooses which libraries it hears about.
        </p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}
      {data && (
        <>
          <ChannelsCard channels={data.channels} libraries={data.libraries} onChange={load} />
          {data.board && <BoardCard board={data.board} libraries={data.libraries} onChange={load} />}
          {data.status && <StatusCard status={data.status} onChange={load} />}
          <TelegramCard />
          <KeysCard keys={data.keys} onChange={load} />
          {data.staff && <StaffCard staff={data.staff} onChange={load} />}
          <LogCard log={data.log} />
        </>
      )}
    </div>
  );
}

// --- Telegram --------------------------------------------------------------------

const TELEGRAM_BOARDS: { board: TelegramBoard; label: string; detail: string }[] = [
  { board: 'library', label: 'Library counts', detail: 'Every library and how much is in it, edited every hour.' },
  { board: 'status', label: 'Server status', detail: 'Your Uptime Kuma servers with a coloured dot each, edited every 2 minutes.' },
];

function TelegramCard() {
  const [settings, setSettings] = useState<TelegramSettings | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<TelegramSettings>('/api/notifications/telegram').then(setSettings).catch(() => {});
  }, []);

  const act = async (fn: () => Promise<TelegramSettings>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      setSettings(await fn());
      if (done) setMessage({ ok: true, text: done });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return null;
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-semibold">Telegram</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Post the library counts and server status to a Telegram group or channel too, as one message each, edited in place like the Discord ones.
      </p>
      {!settings.tokenSet ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api<TelegramSettings>('/api/notifications/telegram', { method: 'POST', body: { token } }), 'Connected.').then(() => setToken(''));
          }}
        >
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-muted">
            <li>
              In Telegram, message <strong className="font-medium text-ink">@BotFather</strong>, send <code>/newbot</code> and give it a name. It gives you a token.
            </li>
            <li>Add the bot to your group (for a channel, make it an admin so it can post), and send any message there so the bot sees the group.</li>
            <li>Paste the token here. Almanac never shows it again.</li>
          </ol>
          <label className="block text-sm">
            <span className="font-medium">Bot token</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder="123456789:AAH…" className={`${input} mt-1 w-full font-mono`} />
          </label>
          <button type="submit" disabled={busy || !token.trim()} className={primary}>
            Connect
          </button>
        </form>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm">
            Connected as <strong className="font-medium">@{settings.botUsername}</strong>.{' '}
            {settings.chats.length
              ? `It’s in ${settings.chats.length} ${settings.chats.length === 1 ? 'group or channel' : 'groups and channels'}.`
              : 'It hasn’t seen any groups yet: add it to one, send a message there, then look again.'}
          </p>
          {TELEGRAM_BOARDS.map(({ board, label, detail }) => (
            <TelegramTargetRow key={board} board={board} label={label} detail={detail} settings={settings} busy={busy} act={act} />
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} className={secondary} onClick={() => void act(() => api<TelegramSettings>('/api/notifications/telegram/chats', { method: 'POST' }))}>
              Look for groups again
            </button>
            <button
              type="button"
              disabled={busy}
              className={secondary}
              onClick={() => {
                if (window.confirm('Disconnect the Telegram bot? The boards stop updating there.')) void act(() => api<TelegramSettings>('/api/notifications/telegram', { method: 'POST', body: { token: null } }));
              }}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
      {message && <p className={`mt-2 text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
    </section>
  );
}

function TelegramTargetRow({
  board,
  label,
  detail,
  settings,
  busy,
  act,
}: {
  board: TelegramBoard;
  label: string;
  detail: string;
  settings: TelegramSettings;
  busy: boolean;
  act: (fn: () => Promise<TelegramSettings>, done?: string) => Promise<void>;
}) {
  const t = settings.targets[board];
  const [chat, setChat] = useState(t.chatId ?? '');
  const [topic, setTopic] = useState(t.threadId ? String(t.threadId) : '');
  const save = (chatId: string | null, topicValue: string) =>
    act(() => api<TelegramSettings>('/api/notifications/telegram/target', { method: 'POST', body: { board, chatId, topic: topicValue.trim() || null } }), chatId ? 'Posted.' : 'Saved.');
  // A pasted topic link says which group it's in: choose that group too.
  const onTopic = (value: string) => {
    setTopic(value);
    const id = value.match(/t\.me\/c\/(\d+)\//)?.[1];
    const match = id ? settings.chats.find((c) => c.id === `-100${id}`) : undefined;
    if (match) setChat(match.id);
  };
  const unchanged = chat === (t.chatId ?? '') && topic.trim() === (t.threadId ? String(t.threadId) : '');
  return (
    <div className="space-y-2 text-sm">
      <div>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-ink-faint">{detail}</span>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save(chat || null, chat ? topic : '');
        }}
      >
        <label className="min-w-0 flex-1 basis-48">
          <span className="text-xs text-ink-muted">Group or channel</span>
          <select
            value={chat}
            disabled={busy}
            onChange={(e) => {
              setChat(e.target.value);
              // Turning it off happens straight away; choosing a group waits for the button.
              if (!e.target.value && t.chatId) void save(null, '');
            }}
            className={`${input} mt-1 w-full`}
          >
            <option value="">Not on Telegram</option>
            {settings.chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} ({c.type === 'channel' ? 'channel' : 'group'})
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1 basis-64">
          <span className="text-xs text-ink-muted">Topic link (optional; empty posts in the main chat)</span>
          <input value={topic} onChange={(e) => onTopic(e.target.value)} placeholder="https://t.me/c/1234567890/33288" className={`${input} mt-1 w-full`} />
        </label>
        <button type="submit" disabled={busy || !chat || (unchanged && Boolean(t.chatId))} className={secondary}>
          {t.chatId ? 'Save and post' : 'Post here'}
        </button>
      </form>
      {t.lastError ? (
        <p className="text-xs text-red-200">{t.lastError}</p>
      ) : t.lastUpdatedAt ? (
        <p className="text-xs text-ink-faint">
          Last updated {formatWhen(t.lastUpdatedAt)}
          {t.threadId ? ` in topic ${t.threadId}` : ''}
        </p>
      ) : null}
    </div>
  );
}

// --- Channels --------------------------------------------------------------------

function ChannelsCard({ channels, libraries, onChange }: { channels: NotifyChannel[]; libraries: Libraries; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Recently added → Discord</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Almanac checks Silo every 2 minutes. A show’s new episodes are grouped into one post once they stop arriving for 5 minutes.
          </p>
        </div>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className={primary}>
            Add channel
          </button>
        )}
      </div>

      {adding && (
        <div className="mt-4">
          <ChannelForm
            libraries={libraries}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              onChange();
            }}
          />
        </div>
      )}

      {channels.length === 0 && !adding ? (
        <p className="mt-6 rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-ink-muted">
          No channels yet. Add one for each Discord channel you want posts in, such as #movies or #4k-tv-shows.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {channels.map((c) => (
            <ChannelRow key={c.id} channel={c} libraries={libraries} onChange={onChange} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChannelRow({ channel, libraries, onChange }: { channel: NotifyChannel; libraries: Libraries; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const names = new Map(libraries.map((l) => [l.id, l.name]));

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage({ ok: true, text: done });
      onChange();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li>
        <ChannelForm
          channel={channel}
          libraries={libraries}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChange();
          }}
        />
      </li>
    );
  }

  return (
    <li className={`rounded-lg border border-line bg-canvas/40 p-4 ${channel.enabled ? '' : 'opacity-70'}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="font-semibold">{channel.name}</h3>
        <span className="text-xs text-ink-faint">{channel.webhookHint}</span>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={channel.enabled}
            disabled={busy}
            onChange={(e) => act(() => api(`/api/notifications/channels/${channel.id}`, { method: 'POST', body: { enabled: e.target.checked } }))}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          {channel.enabled ? 'On' : 'Off'}
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {channel.libraryIds.map((id) => (
          <span key={id} className="rounded-md bg-panel-raised px-2 py-0.5 text-xs">
            {names.get(id) ?? `Library ${id}`}
          </span>
        ))}
        {channel.quality !== 'any' && (
          <span className="rounded-md border border-accent-dim px-2 py-0.5 text-xs">{QUALITY_FILTERS.find((q) => q.value === channel.quality)?.label}</span>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        {channel.lastSentAt ? (
          <span title={formatFullDate(channel.lastSentAt)}>Last posted {formatWhen(channel.lastSentAt)}</span>
        ) : (
          'Nothing posted yet'
        )}
        {channel.waiting > 0 && ` · ${channel.waiting} waiting to be posted`}
      </p>
      {channel.lastError && (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-red-200">
          <StatusIcon status="failed" />
          <span>
            {channel.lastError}
            {channel.lastErrorAt && <span className="text-ink-faint"> ({formatWhen(channel.lastErrorAt)})</span>}
          </span>
        </p>
      )}
      {message && <p className={`mt-2 text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className={secondary}
          onClick={() =>
            act(async () => {
              const r = await api<{ title: string }>(`/api/notifications/channels/${channel.id}/test`, { method: 'POST' });
              setMessage({ ok: true, text: `Sent a test post for ${r.title}. Check the channel in Discord.` });
            })
          }
        >
          {busy ? 'Working…' : 'Send test'}
        </button>
        <button type="button" disabled={busy} className={secondary} onClick={() => setEditing(true)}>
          Edit
        </button>
        {confirmDelete ? (
          <>
            <button
              type="button"
              disabled={busy}
              className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-600"
              onClick={() => act(() => api(`/api/notifications/channels/${channel.id}/delete`, { method: 'POST' }))}
            >
              Delete {channel.name}
            </button>
            <button type="button" className={secondary} onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} className={`${secondary} hover:border-red-800 hover:text-red-200`} onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

function ChannelForm({
  channel,
  libraries,
  onCancel,
  onSaved,
}: {
  channel?: NotifyChannel;
  libraries: Libraries;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(channel?.name ?? '');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(channel?.libraryIds ?? []));
  const [quality, setQuality] = useState<QualityFilter>(channel?.quality ?? 'any');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const webhookProblem = webhookUrl.trim() && !DISCORD_WEBHOOK_PATTERN.test(webhookUrl.trim()) ? 'That doesn’t look like a Discord webhook address.' : null;
  const movies = libraries.filter((l) => (l.type ?? '').startsWith('movie'));
  const shows = libraries.filter((l) => !(l.type ?? '').startsWith('movie'));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (webhookProblem) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name, webhookUrl: webhookUrl.trim() || undefined, libraryIds: [...selected], quality };
      if (channel) await api(`/api/notifications/channels/${channel.id}`, { method: 'POST', body });
      else await api('/api/notifications/channels', { method: 'POST', body });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-accent-dim bg-canvas/40 p-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
        <label className="block text-sm">
          <span className="font-medium">Name</span>
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="#4k-movies" className={`${input} mt-1 w-full`} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Webhook address</span>
          <input
            required={!channel}
            type="password"
            autoComplete="off"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder={channel ? 'Leave empty to keep the current one' : 'https://discord.com/api/webhooks/…'}
            className={`${input} mt-1 w-full`}
          />
          {webhookProblem ? (
            <span className="mt-1 block text-xs text-red-200">{webhookProblem}</span>
          ) : (
            <span className="mt-1 block text-xs text-ink-faint">
              In Discord: the channel’s settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
            </span>
          )}
        </label>
      </div>

      <fieldset>
        <legend className="text-sm font-medium">Libraries</legend>
        {libraries.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted">Almanac hasn’t got Silo’s library list yet (it needs the libraries:read scope). Try again in a few minutes.</p>
        ) : (
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            {[
              ['Movies', movies],
              ['TV', shows],
            ].map(([label, list]) =>
              (list as Libraries).length ? (
                <div key={label as string}>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">{label as string}</p>
                  <div className="space-y-1">
                    {(list as Libraries).map((l) => (
                      <label key={l.id} className="flex cursor-pointer items-center gap-2 text-sm">
                        <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} className="h-4 w-4 accent-[var(--color-accent)]" />
                        {l.name}
                      </label>
                    ))}
                  </div>
                </div>
              ) : null,
            )}
          </div>
        )}
      </fieldset>

      <label className="block text-sm">
        <span className="font-medium">Only post</span>
        <select value={quality} onChange={(e) => setQuality(e.target.value as QualityFilter)} className={`${input} mt-1 block`}>
          {QUALITY_FILTERS.map((q) => (
            <option key={q.value} value={q.value}>
              {q.label}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-ink-faint">Judged by the copy in the libraries above, so a Dolby Vision channel can watch your 4K libraries.</span>
      </label>

      {!channel && <p className="text-xs text-ink-muted">Only things added from now on are posted, so a new channel won’t flood Discord with your whole library.</p>}
      {error && <p className="text-sm text-red-200">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || selected.size === 0 || Boolean(webhookProblem)} className={primary}>
          {busy ? 'Saving…' : channel ? 'Save' : 'Add channel'}
        </button>
        <button type="button" onClick={onCancel} className={secondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- Metadata keys ---------------------------------------------------------------

function KeysCard({ keys, onChange }: { keys: NotificationsResponse['keys']; onChange: () => void }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-semibold">Posters and summaries</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Movies get their details from TMDB and shows from TVDB. Without keys, posts still go out using Silo’s details, just without plot
        summaries. Keys are checked before saving and are never shown again.
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <KeyForm
          title="TMDB (movies)"
          set={keys.tmdb}
          field="tmdb"
          help="Free from themoviedb.org → Settings → API. The API key or the read access token both work."
          onChange={onChange}
        />
        <KeyForm
          title="TVDB (shows)"
          set={keys.tvdb}
          field="tvdb"
          withPin
          pinSet={keys.tvdbPin}
          help="From thetvdb.com → Dashboard → API keys. Add your subscriber PIN if your key needs one. Without a TVDB key, shows use TMDB."
          onChange={onChange}
        />
      </div>
    </section>
  );
}

function KeyForm({
  title,
  set,
  field,
  help,
  withPin,
  pinSet,
  onChange,
}: {
  title: string;
  set: boolean;
  field: 'tmdb' | 'tvdb';
  help: string;
  withPin?: boolean;
  pinSet?: boolean;
  onChange: () => void;
}) {
  const [key, setKey] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (remove = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const body: Record<string, string> = { [field]: remove ? '' : key.trim() };
      if (withPin && (pin.trim() || remove)) body.tvdbPin = remove ? '' : pin.trim();
      await api('/api/notifications/keys', { method: 'POST', body });
      setKey('');
      setPin('');
      setMessage({ ok: true, text: remove ? 'Removed.' : 'Checked and saved.' });
      onChange();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Couldn’t save.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="rounded-lg border border-line bg-canvas/40 p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className={`flex items-center gap-1.5 text-xs ${set ? 'text-ink' : 'text-ink-faint'}`}>
          <StatusIcon status={set ? 'sent' : 'skipped'} />
          {set ? `Key saved${withPin && pinSet ? ' with PIN' : ''}` : 'No key'}
        </span>
      </div>
      <input
        type="password"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={set ? 'Paste a new key to replace it' : 'Paste your key'}
        className={`${input} mt-3 w-full`}
      />
      {withPin && (
        <input
          type="password"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="Subscriber PIN (optional)"
          className={`${input} mt-2 w-full`}
        />
      )}
      <p className="mt-2 text-xs text-ink-faint">{help}</p>
      {message && <p className={`mt-2 text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={busy || !key.trim()} className={primary}>
          {busy ? 'Checking…' : 'Check and save'}
        </button>
        {set && (
          <button type="button" disabled={busy} onClick={() => void save(true)} className={secondary}>
            Remove
          </button>
        )}
      </div>
    </form>
  );
}

// --- Library board -----------------------------------------------------------------

function BoardCard({ board, libraries, onChange }: { board: NonNullable<NotificationsResponse['board']>; libraries: Libraries; onChange: () => void }) {
  const [webhookUrl, setWebhookUrl] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set(board.hiddenLibraryIds));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const problem = webhookUrl.trim() && !DISCORD_WEBHOOK_PATTERN.test(webhookUrl.trim()) ? 'That doesn’t look like a Discord webhook address.' : null;
  const changedLibraries = JSON.stringify([...hidden].sort()) !== JSON.stringify([...board.hiddenLibraryIds].sort());

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: done });
      setWebhookUrl('');
      onChange();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setHidden(next);
  };
  const movies = libraries.filter((l) => (l.type ?? '').startsWith('movie'));
  const shows = libraries.filter((l) => !(l.type ?? '').startsWith('movie'));

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Library counts → Discord</h2>
        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
          <StatusIcon status={board.lastError ? 'failed' : board.lastUpdatedAt ? 'sent' : 'skipped'} />
          {board.lastError ? 'Not updating' : board.lastUpdatedAt ? `Updated ${formatWhen(board.lastUpdatedAt)}` : board.webhookHint ? 'Waiting to post' : 'Not set up'}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        One message listing each library and how much is in it, for your members to see. Almanac posts it once and edits it every hour, so the channel
        doesn’t fill up. Pin it in Discord if you like.
      </p>
      {board.lastError && <p className="mt-2 text-sm text-red-200">{board.lastError}</p>}
      <form
        className="mt-4 flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) void act(() => api('/api/notifications/board', { method: 'POST', body: { webhookUrl: webhookUrl.trim(), hiddenLibraryIds: [...hidden] } }), 'Saved and posted.');
        }}
      >
        <input
          type="password"
          autoComplete="off"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder={board.webhookHint ? `Posting to ${board.webhookHint}. Paste a new webhook to move it` : 'https://discord.com/api/webhooks/…'}
          className={`${input} min-w-0 flex-1 basis-72`}
          aria-label="Library counts webhook address"
        />
        <button type="submit" disabled={busy || !webhookUrl.trim() || Boolean(problem)} className={primary}>
          Save
        </button>
      </form>
      {problem && <p className="mt-1 text-xs text-red-200">{problem}</p>}

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Show these libraries</legend>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          {[
            ['Movies', movies],
            ['TV', shows],
          ].map(([label, list]) =>
            (list as Libraries).length ? (
              <div key={label as string}>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">{label as string}</p>
                <div className="space-y-1">
                  {(list as Libraries).map((l) => (
                    <label key={l.id} className="flex cursor-pointer items-center gap-2 text-sm">
                      <input type="checkbox" checked={!hidden.has(l.id)} onChange={() => toggle(l.id)} className="h-4 w-4 accent-[var(--color-accent)]" />
                      {l.name}
                    </label>
                  ))}
                </div>
              </div>
            ) : null,
          )}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap gap-2">
        {changedLibraries && (
          <button
            type="button"
            disabled={busy}
            className={primary}
            onClick={() => void act(() => api('/api/notifications/board', { method: 'POST', body: { hiddenLibraryIds: [...hidden] } }), board.webhookHint ? 'Saved and updated.' : 'Saved.')}
          >
            Save libraries
          </button>
        )}
        {board.webhookHint && (
          <>
            <button type="button" disabled={busy} className={secondary} onClick={() => void act(() => api('/api/notifications/board/refresh', { method: 'POST' }), 'Updated.')}>
              Update now
            </button>
            <button type="button" disabled={busy} className={secondary} onClick={() => void act(() => api('/api/notifications/board', { method: 'POST', body: { webhookUrl: null } }), 'Removed. Delete the old message in Discord if you like.')}>
              Remove
            </button>
          </>
        )}
      </div>
      {message && <p className={`mt-2 text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
    </section>
  );
}

// --- Server status (Uptime Kuma) ------------------------------------------------------

const STATE_DOT: Record<StatusBoardMonitor['state'], string> = { up: '🟢', down: '🔴', pending: '🟡', maintenance: '🔧', unknown: '⚪' };

function StatusCard({ status, onChange }: { status: NonNullable<NotificationsResponse['status']>; onChange: () => void }) {
  const [pageUrl, setPageUrl] = useState(status.pageUrl ?? '');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showToken, setShowToken] = useState(status.accessTokenSet);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const problem = webhookUrl.trim() && !DISCORD_WEBHOOK_PATTERN.test(webhookUrl.trim()) ? 'That doesn’t look like a Discord webhook address.' : null;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: done });
      setWebhookUrl('');
      setClientId('');
      setClientSecret('');
      onChange();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Something went wrong.' });
      onChange();
    } finally {
      setBusy(false);
    }
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) return;
    const body: Record<string, string> = { pageUrl: pageUrl.trim() };
    if (webhookUrl.trim()) body.webhookUrl = webhookUrl.trim();
    if (clientId.trim()) body.accessClientId = clientId.trim();
    if (clientSecret.trim()) body.accessClientSecret = clientSecret.trim();
    void act(() => api('/api/notifications/status', { method: 'POST', body }), status.webhookHint || webhookUrl.trim() ? 'Saved and posted.' : 'Saved. Add a webhook to post it to Discord.');
  };

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Server status → Discord</h2>
        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
          <StatusIcon status={status.lastError ? 'failed' : status.lastUpdatedAt ? 'sent' : 'skipped'} />
          {status.lastError ? 'Not updating' : status.lastUpdatedAt ? `Checked ${formatWhen(status.lastUpdatedAt)}` : 'Not set up'}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        Shows each server on your Uptime Kuma status page with a coloured dot and its uptime today, in one Discord message that Almanac edits every
        2 minutes.
      </p>
      {status.lastError && <p className="mt-2 text-sm text-red-200">{status.lastError}</p>}

      <form onSubmit={save} className="mt-4 space-y-3">
        <label className="block text-sm">
          <span className="font-medium">Status page address</span>
          <input type="url" value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} placeholder="https://uptime.example.com/status/main" className={`${input} mt-1 w-full`} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Discord webhook</span>
          <input
            type="password"
            autoComplete="off"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder={status.webhookHint ? `Posting to ${status.webhookHint}. Paste a new webhook to move it` : 'https://discord.com/api/webhooks/…'}
            className={`${input} mt-1 w-full`}
          />
          {problem && <span className="mt-1 block text-xs text-red-200">{problem}</span>}
        </label>
        {showToken ? (
          <div className="space-y-2 rounded-lg border border-line bg-canvas/40 p-3 text-sm">
            <p className="font-medium">
              Cloudflare Access service token <span className="font-normal text-ink-muted">{status.accessTokenSet ? '(saved; fill both to replace it)' : ''}</span>
            </p>
            <p className="text-xs text-ink-faint">Only needed if the status page is behind a Cloudflare Access login.</p>
            <input autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID (ends in .access)" className={`${input} w-full font-mono`} />
            <input type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client secret" className={`${input} w-full font-mono`} />
          </div>
        ) : (
          <button type="button" className="text-sm text-accent hover:underline" onClick={() => setShowToken(true)}>
            Behind Cloudflare Access? Add a service token
          </button>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy || !pageUrl.trim() || Boolean(problem)} className={primary}>
            {busy ? 'Checking…' : 'Save'}
          </button>
          {status.pageUrl && (
            <button type="button" disabled={busy} className={secondary} onClick={() => void act(() => api('/api/notifications/status/refresh', { method: 'POST' }), 'Updated.')}>
              Check now
            </button>
          )}
          {status.webhookHint && (
            <button type="button" disabled={busy} className={secondary} onClick={() => void act(() => api('/api/notifications/status', { method: 'POST', body: { webhookUrl: null } }), 'Removed. Delete the old message in Discord if you like.')}>
              Remove from Discord
            </button>
          )}
        </div>
        {message && <p className={`text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
      </form>

      {status.monitors.length > 0 && (
        <ul className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {status.monitors.map((m) => (
            <li key={`${m.group}:${m.name}`} className="flex items-center gap-2">
              <span aria-hidden="true">{STATE_DOT[m.state]}</span>
              <span className="font-medium">{m.name}</span>
              <span className="text-ink-muted">
                {m.state === 'up' ? (m.uptimeToday == null ? 'up' : `${m.uptimeToday >= 0.99995 ? '100' : (Math.floor(m.uptimeToday * 10000) / 100).toFixed(2)}% today`) : m.state}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- Staff alerts ------------------------------------------------------------------

function StaffCard({ staff, onChange }: { staff: NonNullable<NotificationsResponse['staff']>; onChange: () => void }) {
  const [webhookUrl, setWebhookUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const problem = webhookUrl.trim() && !DISCORD_WEBHOOK_PATTERN.test(webhookUrl.trim()) ? 'That doesn’t look like a Discord webhook address.' : null;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: done });
      setWebhookUrl('');
      onChange();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Staff alerts → Discord</h2>
        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
          <StatusIcon status={staff.alerting ? 'failed' : staff.webhookHint ? 'sent' : 'skipped'} />
          {staff.alerting ? 'Alerting now' : staff.webhookHint ? `Posting to ${staff.webhookHint}` : 'No staff channel yet'}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        A private channel for you and your mods. Almanac posts new account flags here (with the account’s email and a link to it, never IP addresses), and
        tells you when streams start dropping much more than usual for the time of day, and when things are back to normal.
      </p>
      <form
        className="mt-4 flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) void act(() => api('/api/notifications/staff', { method: 'POST', body: { webhookUrl: webhookUrl.trim() } }), 'Saved.');
        }}
      >
        <input
          type="password"
          autoComplete="off"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder={staff.webhookHint ? 'Paste a new webhook to replace it' : 'https://discord.com/api/webhooks/…'}
          className={`${input} min-w-0 flex-1 basis-72`}
          aria-label="Staff webhook address"
        />
        <button type="submit" disabled={busy || !webhookUrl.trim() || Boolean(problem)} className={primary}>
          Save
        </button>
      </form>
      {problem && <p className="mt-1 text-xs text-red-200">{problem}</p>}
      {staff.webhookHint && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            Post
            <select
              value={staff.flagLevel}
              disabled={busy}
              onChange={(e) => void act(() => api('/api/notifications/staff', { method: 'POST', body: { flagLevel: e.target.value } }), 'Saved.')}
              className={`${input} py-1.5`}
            >
              {FLAG_ALERT_LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={staff.reliability}
              disabled={busy}
              onChange={(e) => void act(() => api('/api/notifications/staff', { method: 'POST', body: { reliability: e.target.checked } }), 'Saved.')}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Alert when streams drop much more than usual
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={staff.capacity}
              disabled={busy}
              onChange={(e) => void act(() => api('/api/notifications/staff', { method: 'POST', body: { capacity: e.target.checked } }), 'Saved.')}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Alert when the server is running out of room
          </label>
          <button type="button" disabled={busy} className={secondary} onClick={() => void act(() => api('/api/notifications/staff/test', { method: 'POST' }), 'Sent a test alert. Check the channel in Discord.')}>
            Send test
          </button>
          <button type="button" disabled={busy} className={secondary} onClick={() => void act(() => api('/api/notifications/staff', { method: 'POST', body: { webhookUrl: null } }), 'Removed.')}>
            Remove
          </button>
          {staff.lastAlertAt && <span className="text-xs text-ink-faint">Last alert {formatWhen(staff.lastAlertAt)}</span>}
        </div>
      )}
      {message && <p className={`mt-2 text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
    </section>
  );
}

// --- Log -----------------------------------------------------------------------

const STATUS: Record<NotifyLogEntry['status'], { label: string; color: string; icon: string }> = {
  sent: { label: 'Posted', color: '#0ca30c', icon: 'M3.5 8.5 6.5 11.5 12.5 4.5' },
  pending: { label: 'Waiting', color: '#fab219', icon: 'M8 4v4l2.5 2' },
  failed: { label: 'Failed', color: '#d03b3b', icon: 'M5 5l6 6M11 5l-6 6' },
  skipped: { label: 'Skipped', color: '#737373', icon: 'M4 8h8' },
};

function StatusIcon({ status }: { status: NotifyLogEntry['status'] }) {
  const s = STATUS[status];
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {status === 'pending' && <circle cx="8" cy="8" r="6" strokeWidth="1.6" />}
      <path d={s.icon} />
    </svg>
  );
}

function LogCard({ log }: { log: NotifyLogEntry[] }) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <h2 className="px-5 pt-5 font-semibold">Recent posts</h2>
      {log.length === 0 ? (
        <p className="px-5 pb-6 pt-3 text-sm text-ink-faint">Nothing yet. New movies and episodes in your channels’ libraries will show up here.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/60">
          {log.map((e, i) => (
            <li key={`${e.channelId}:${e.title}:${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-sm">
              <span className="flex w-24 shrink-0 items-center gap-1.5 text-xs" style={{ color: e.status === 'skipped' ? undefined : STATUS[e.status].color }}>
                <StatusIcon status={e.status} />
                <span className={e.status === 'skipped' ? 'text-ink-faint' : 'text-ink'}>{STATUS[e.status].label}</span>
              </span>
              <span className="min-w-0 flex-1 truncate font-medium" title={e.error ?? undefined}>
                {e.title}
                {e.error && e.status !== 'sent' && <span className="ml-2 font-normal text-ink-faint">{e.error}</span>}
              </span>
              <span className="text-ink-muted">{e.channelName}</span>
              <span className="w-28 text-right text-xs text-ink-faint" title={formatFullDate(e.sentAt ?? e.detectedAt)}>
                {formatWhen(e.sentAt ?? e.detectedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
