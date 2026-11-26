import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { type FlagsResponse, SUGGESTED_TAGS, type UserNote } from '../../../shared/moderation';
import { ApiError, api } from '../lib/api';
import { formatFullDate, formatWhen } from '../lib/format';
import { useModeration } from '../lib/moderation';
import { UserExceptions } from './Exceptions';
import { FlagCard } from './FlagCard';
import { Link } from '../lib/router';

/** On a user's page, for admins and mods: tags, open flags and shared notes. */
export function NotesAndTags({ userId, username }: { userId: string; username: string }) {
  const [flags, setFlags] = useState<FlagsResponse['flags']>([]);
  const [version, setVersion] = useState(0);
  const { refresh } = useModeration();

  const loadFlags = useCallback(() => {
    api<FlagsResponse>(`/api/moderation/flags?status=all&user=${encodeURIComponent(userId)}`)
      .then((d) => setFlags(d.flags))
      .catch(() => {});
  }, [userId]);
  useEffect(loadFlags, [loadFlags]);

  return (
    <section className="space-y-4 rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Moderation</h2>
        <p className="text-xs text-ink-faint">
          Only admins and mods see this ·{' '}
          <Link to={`/users/${encodeURIComponent(userId)}/case`} className="text-accent hover:underline">
            Open the case file
          </Link>
        </p>
      </div>
      <TagEditor userId={userId} />
      <UserExceptions
        userId={userId}
        username={username}
        onChange={() => {
          loadFlags();
          refresh();
          setVersion((v) => v + 1);
        }}
      />
      {flags.length > 0 && (
        <div className="space-y-2">
          {flags.map((f) => (
            <FlagCard
              key={f.id}
              flag={f}
              showUser={false}
              onChange={() => {
                loadFlags();
                refresh();
                setVersion((v) => v + 1);
              }}
            />
          ))}
        </div>
      )}
      <Notes userId={userId} username={username} key={`${version}-${flags.map((f) => f.status).join()}`} />
    </section>
  );
}

function TagEditor({ userId }: { userId: string }) {
  const { tagsFor, allTags, refresh } = useModeration();
  const tags = tagsFor(userId);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = async (next: string[]) => {
    setError(null);
    try {
      await api(`/api/moderation/users/${encodeURIComponent(userId)}/tags`, { method: 'POST', body: { tags: next } });
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save tags.');
    }
  };
  const add = (tag: string) => {
    const t = tag.trim();
    if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    setInput('');
    void save([...tags, t]);
  };

  const suggestions = [...new Set([...allTags.map((t) => t.tag), ...SUGGESTED_TAGS])]
    .filter((t) => !tags.some((x) => x.toLowerCase() === t.toLowerCase()))
    .slice(0, 8);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm text-ink-muted">Tags</span>
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full border border-accent-dim/60 bg-accent/10 py-0.5 pl-2 pr-1 text-xs text-ink">
            {t}
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              onClick={() => void save(tags.filter((x) => x !== t))}
              className="rounded-full px-1 text-ink-muted hover:text-ink"
            >
              ×
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={32}
            placeholder="Add a tag"
            aria-label="Add a tag"
            list={`tag-suggestions-${userId}`}
            className="w-32 rounded-full border border-line bg-canvas px-2.5 py-0.5 text-xs placeholder:text-ink-faint focus:border-accent-dim focus:outline-none"
          />
          <datalist id={`tag-suggestions-${userId}`}>
            {suggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </form>
      </div>
      {tags.length === 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {suggestions.slice(0, 6).map((t) => (
            <button key={t} type="button" onClick={() => add(t)} className="rounded-full border border-dashed border-line px-2 py-0.5 text-[11px] text-ink-muted hover:border-accent-dim hover:text-ink">
              + {t}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
    </div>
  );
}

function Notes({ userId, username }: { userId: string; username: string }) {
  const [notes, setNotes] = useState<UserNote[] | null>(null);
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ notes: UserNote[] }>(`/api/moderation/users/${encodeURIComponent(userId)}/notes`)
      .then((d) => setNotes(d.notes))
      .catch(() => setError('Couldn’t load notes.'));
  }, [userId]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api(`/api/moderation/users/${encodeURIComponent(userId)}/notes`, { method: 'POST', body: { body } }))) setBody('');
  };

  return (
    <div>
      <h3 className="text-sm font-medium">Notes</h3>
      <form onSubmit={add} className="mt-2 space-y-2">
        <textarea
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
          placeholder={`Add a note about ${username} for other admins and mods`}
          aria-label="New note"
          className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm placeholder:text-ink-faint focus:border-accent-dim focus:outline-none"
        />
        {body.trim() && (
          <button type="submit" disabled={busy} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-canvas hover:brightness-110 disabled:opacity-60">
            Add note
          </button>
        )}
      </form>
      {error && <p className="mt-1 text-sm text-red-300">{error}</p>}
      <ul className="mt-3 space-y-2">
        {notes?.map((n) => (
          <li key={n.id} className="rounded-lg border border-line/70 bg-canvas/50 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-faint">
              <span className="font-medium text-ink-muted">{n.authorName}</span>
              <time dateTime={n.createdAt} title={formatFullDate(n.createdAt)}>
                {formatWhen(n.createdAt)}
              </time>
              {n.updatedAt !== n.createdAt && <span>(edited)</span>}
              {n.canEdit && editing?.id !== n.id && (
                <span className="ml-auto flex gap-2">
                  <button type="button" onClick={() => setEditing({ id: n.id, body: n.body })} className="hover:text-ink">
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm('Delete this note?')) void run(() => api(`/api/moderation/notes/${n.id}/delete`, { method: 'POST' }));
                    }}
                    className="hover:text-red-200"
                  >
                    Delete
                  </button>
                </span>
              )}
            </div>
            {editing?.id === n.id ? (
              <form
                className="mt-1 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api(`/api/moderation/notes/${n.id}`, { method: 'POST', body: { body: editing.body } })).then((ok) => ok && setEditing(null));
                }}
              >
                <textarea
                  rows={2}
                  autoFocus
                  value={editing.body}
                  onChange={(e) => setEditing({ id: n.id, body: e.target.value })}
                  aria-label="Edit note"
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm focus:border-accent-dim focus:outline-none"
                />
                <div className="flex gap-2 text-sm">
                  <button type="submit" disabled={busy} className="rounded-lg bg-accent px-3 py-1 font-semibold text-canvas">
                    Save
                  </button>
                  <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-line px-3 py-1">
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <p className="mt-0.5 whitespace-pre-wrap text-sm">{n.body}</p>
            )}
          </li>
        ))}
        {notes && notes.length === 0 && <li className="text-sm text-ink-faint">No notes yet.</li>}
      </ul>
    </div>
  );
}
