import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { FlagsResponse, TagsResponse } from '../../../shared/moderation';
import { useAuth } from '../auth/AuthGate';
import { api } from './api';
import { formatWhen } from './format';

interface ModerationContextValue {
  enabled: boolean;
  tagsFor: (userId: string) => string[];
  allTags: TagsResponse['all'];
  openFlags: FlagsResponse['counts'];
  refresh: () => void;
}

const empty: ModerationContextValue = {
  enabled: false,
  tagsFor: () => [],
  allTags: [],
  openFlags: { open: 0, openHigh: 0 },
  refresh: () => {},
};

const ModerationContext = createContext<ModerationContextValue>(empty);

export function useModeration(): ModerationContextValue {
  return useContext(ModerationContext);
}

/** Loads user tags and the open flag count for accounts that can moderate. */
export function ModerationProvider({ children }: { children: React.ReactNode }) {
  const { can } = useAuth();
  const enabled = can('moderate');
  const [tags, setTags] = useState<TagsResponse>({ byUser: {}, all: [] });
  const [counts, setCounts] = useState<FlagsResponse['counts']>({ open: 0, openHigh: 0 });

  const refresh = useCallback(() => {
    if (!enabled) return;
    api<TagsResponse>('/api/moderation/tags').then(setTags).catch(() => {});
    api<FlagsResponse>('/api/moderation/flags?status=open')
      .then((r) => setCounts(r.counts))
      .catch(() => {});
  }, [enabled]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const value: ModerationContextValue = enabled
    ? { enabled, tagsFor: (id) => tags.byUser[id] ?? [], allTags: tags.all, openFlags: counts, refresh }
    : empty;
  return <ModerationContext.Provider value={value}>{children}</ModerationContext.Provider>;
}

/** Flag text from the server can contain times as `{{time:ISO}}`; show them in local time. */
export function FlagText({ text }: { text: string }) {
  const parts = text.split(/(\{\{time:[^}]+\}\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^\{\{time:([^}]+)\}\}$/);
        if (!match) return <span key={i}>{part}</span>;
        const iso = match[1]!;
        return (
          <time key={i} dateTime={iso} title={new Date(iso).toLocaleString()}>
            {formatWhen(iso)}
          </time>
        );
      })}
    </>
  );
}
