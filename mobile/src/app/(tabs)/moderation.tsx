import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import type { FlagsResponse } from '../../../../shared/moderation';
import type { SuspensionsResponse } from '../../../../shared/suspensions';
import { FlagCard, RequestCard } from '../../components/flags';
import { Card, ErrorText, Muted, Screen, Segmented } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { flagText, formatWhen } from '../../lib/format';

/** Open flags, and suspension requests waiting for an admin. */
export default function Moderation() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'flags' | 'requests'>('flags');
  const [flags, setFlags] = useState<FlagsResponse | null>(null);
  const [requests, setRequests] = useState<SuspensionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [f, r] = await Promise.all([
        api<FlagsResponse>('/api/moderation/flags?status=open'),
        can('requestSuspension') ? api<SuspensionsResponse>('/api/suspensions') : Promise.resolve(null),
      ]);
      setFlags(f);
      setRequests(r);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t load moderation.');
    }
  }, [can]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const pending = requests?.requests.filter((r) => r.status === 'pending') ?? [];
  const recent = requests?.requests.filter((r) => r.status !== 'pending').slice(0, 10) ?? [];
  return (
    <Screen
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
    >
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'flags', label: `Flags${flags ? ` (${flags.counts.open})` : ''}` },
          { value: 'requests', label: `Requests${pending.length ? ` (${pending.length})` : ''}` },
        ]}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      {tab === 'flags' ? (
        <>
          {flags?.checkedAt ? <Muted small>{flagText(`Checked every 5 minutes; last ${formatWhen(flags.checkedAt)}. A flag is a reason to look, not proof.`)}</Muted> : null}
          {flags && flags.flags.length === 0 ? (
            <Card>
              <Muted>No open flags.</Muted>
            </Card>
          ) : null}
          {flags?.flags.map((f) => <FlagCard key={f.id} flag={f} onChanged={() => void load()} />)}
        </>
      ) : (
        <>
          {pending.length === 0 ? (
            <Card>
              <Muted>Nothing waiting for an admin.</Muted>
            </Card>
          ) : null}
          {pending.map((r) => (
            <RequestCard key={r.id} request={r} canReview={can('reviewSuspension')} onChanged={() => void load()} />
          ))}
          {recent.length ? <Muted small>Recent</Muted> : null}
          {recent.map((r) => (
            <RequestCard key={r.id} request={r} canReview={false} onChanged={() => void load()} />
          ))}
        </>
      )}
    </Screen>
  );
}
