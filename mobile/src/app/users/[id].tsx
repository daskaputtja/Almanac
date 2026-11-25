import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Text, TextInput, View } from 'react-native';
import type { HistoryPage } from '../../../../shared/history';
import type { FlagsResponse, UserNote } from '../../../../shared/moderation';
import type { SuspensionsResponse } from '../../../../shared/suspensions';
import type { UserDetail } from '../../../../shared/users';
import { FlagCard, RequestCard } from '../../components/flags';
import { Button, Card, ErrorText, Label, Muted, Screen, Stat } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { episodeCode, formatBytes, formatDuration, formatWhen } from '../../lib/format';
import { colors, radius, space } from '../../lib/theme';

/** One account: flags, notes, suspension, downloads, devices and recent plays. */
export default function UserScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can } = useAuth();
  const [user, setUser] = useState<UserDetail | null>(null);
  const [flags, setFlags] = useState<FlagsResponse | null>(null);
  const [notes, setNotes] = useState<UserNote[]>([]);
  const [requests, setRequests] = useState<SuspensionsResponse | null>(null);
  const [plays, setPlays] = useState<HistoryPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const enc = encodeURIComponent(id);
      const moderate = can('moderate');
      const [u, f, n, r, h] = await Promise.all([
        api<UserDetail>(`/api/users/${enc}`),
        moderate ? api<FlagsResponse>(`/api/moderation/flags?status=all&user=${enc}`) : Promise.resolve(null),
        moderate ? api<{ notes: UserNote[] }>(`/api/moderation/users/${enc}/notes`) : Promise.resolve({ notes: [] }),
        can('requestSuspension') ? api<SuspensionsResponse>(`/api/suspensions?user=${enc}`) : Promise.resolve(null),
        api<HistoryPage>(`/api/history?user=${enc}&pageSize=10&minWatched=30`),
      ]);
      setUser(u);
      setFlags(f);
      setNotes(n.notes);
      setRequests(r);
      setPlays(h);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t load this account.');
    }
  }, [id, can]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
    >
      <Stack.Screen options={{ title: user?.name ?? '' }} />
      {error ? <ErrorText>{error}</ErrorText> : null}
      {user ? (
        <>
          <View style={{ gap: 2 }}>
            <Text style={{ color: colors.ink, fontSize: 26, fontWeight: '800' }}>{user.name}</Text>
            {user.email ? (
              <Text style={{ color: colors.muted, fontSize: 15 }} onPress={() => void Linking.openURL(`mailto:${user.email}`)}>
                {user.email}
              </Text>
            ) : null}
            <Muted small>
              {[user.role, user.enabled === false ? 'disabled in Silo' : null, user.createdAt ? `member since ${new Date(user.createdAt).toLocaleDateString()}` : null]
                .filter(Boolean)
                .join(' · ')}
            </Muted>
          </View>
          <View style={{ flexDirection: 'row', gap: space.md, flexWrap: 'wrap' }}>
            <Stat label="Plays (30 days)" value={user.plays30Days.toLocaleString()} detail={`${user.plays.toLocaleString()} ever`} />
            <Stat label="Last played" value={user.lastPlayedAt ? formatWhen(user.lastPlayedAt) : 'Never'} />
          </View>

          {can('requestSuspension') && requests ? <Suspension userId={user.id} enabled={user.enabled} requests={requests} onChanged={() => void load()} /> : null}

          {flags && flags.flags.length ? (
            <>
              <Label>Flags</Label>
              {flags.flags.map((f) => (
                <FlagCard key={f.id} flag={f} showUser={false} onChanged={() => void load()} />
              ))}
            </>
          ) : null}

          {can('moderate') ? <Notes userId={user.id} notes={notes} onChanged={() => void load()} /> : null}

          <Card>
            <Label>Offline downloads</Label>
            <Muted>
              {user.downloads.last30Days.toLocaleString()} in 30 days ({formatBytes(user.downloads.last30DaysBytes)}) · {user.downloads.onDevices.toLocaleString()} on devices now
            </Muted>
            {user.downloads.recent.slice(0, 8).map((d) => (
              <View key={d.id} style={{ paddingTop: space.sm }}>
                <Text style={{ color: colors.ink, fontWeight: '600' }}>
                  {d.title}
                  {d.episode ? <Text style={{ color: colors.muted, fontWeight: '400' }}> · {d.episode}</Text> : null}
                </Text>
                <Muted small>{[formatWhen(d.createdAt), d.deviceName, formatBytes(d.sizeBytes), d.present ? null : 'deleted'].filter(Boolean).join(' · ')}</Muted>
              </View>
            ))}
          </Card>

          <Card>
            <Label>Signed-in devices ({user.registeredDevices.length})</Label>
            {user.registeredDevices.slice(0, 12).map((d) => (
              <Muted key={d.deviceId} small>
                {d.name} · {d.platform ?? '—'} · {d.lastUsedAt ? formatWhen(d.lastUsedAt) : 'never'}
              </Muted>
            ))}
          </Card>

          <Card>
            <Label>Recent plays</Label>
            {plays?.items.map((p) => (
              <View key={p.id} style={{ paddingTop: space.sm }}>
                <Text style={{ color: colors.ink, fontWeight: '600' }}>
                  {p.media.seriesTitle ?? p.media.title}
                  {p.media.seriesTitle ? (
                    <Text style={{ color: colors.muted, fontWeight: '400' }}> · {[episodeCode(p.media.seasonNumber, p.media.episodeNumber), p.media.title].filter(Boolean).join(' · ')}</Text>
                  ) : null}
                </Text>
                <Muted small>
                  {formatWhen(p.endedAt)} · {formatDuration(p.watchedSeconds)} · {p.client.name ?? 'Unknown player'}
                </Muted>
              </View>
            ))}
            {plays && plays.items.length === 0 ? <Muted>No plays yet.</Muted> : null}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

const inputStyle = { backgroundColor: colors.canvas, borderColor: colors.line, borderWidth: 1, borderRadius: radius.md, color: colors.ink, padding: space.md, minHeight: 70, textAlignVertical: 'top' as const };

function Suspension({ userId, enabled, requests, onChanged }: { userId: string; enabled: boolean | null; requests: SuspensionsResponse; onChanged: () => void }) {
  const { can } = useAuth();
  const [action, setAction] = useState<'suspend' | 'unsuspend' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = requests.requests.find((r) => r.status === 'pending');
  const lastDone = requests.requests.find((r) => r.status === 'done');
  const suspended = lastDone?.action === 'suspend' || enabled === false;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/suspensions', { method: 'POST', body: { userId, action, reason } });
      setAction(null);
      setReason('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t send that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Label>Account access</Label>
      <Muted>{enabled === false ? 'Disabled in Silo' : 'Active in Silo'}</Muted>
      {pending ? <RequestCard request={pending} canReview={can('reviewSuspension')} onChanged={onChanged} showUser={false} /> : null}
      {!pending && !action ? (
        <View style={{ marginTop: space.sm }}>
          {suspended ? (
            <Button title="Lift the suspension" kind="secondary" onPress={() => setAction('unsuspend')} />
          ) : (
            <Button title="Suspend until they get in touch" kind="secondary" onPress={() => setAction('suspend')} />
          )}
          {!requests.portalConfigured ? <Muted small>The billing portal isn’t connected yet.</Muted> : null}
        </View>
      ) : null}
      {action ? (
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          <Muted small>{can('reviewSuspension') ? 'This goes to the billing portal straight away.' : 'An admin reviews it before anything happens.'}</Muted>
          <TextInput value={reason} onChangeText={setReason} placeholder="Reason (required)" placeholderTextColor={colors.faint} multiline style={inputStyle} />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                title={can('reviewSuspension') ? (action === 'suspend' ? 'Suspend now' : 'Lift it now') : 'Send for review'}
                kind={action === 'suspend' ? 'danger' : 'primary'}
                onPress={() => void send()}
                busy={busy}
                disabled={reason.trim().length < 10}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Cancel" kind="secondary" onPress={() => setAction(null)} />
            </View>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

function Notes({ userId, notes, onChanged }: { userId: string; notes: UserNote[]; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/moderation/users/${encodeURIComponent(userId)}/notes`, { method: 'POST', body: { body: text } });
      setText('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save the note.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Label>Notes</Label>
      {notes.map((n) => (
        <View key={n.id} style={{ paddingVertical: space.xs }}>
          <Text style={{ color: colors.ink }}>{n.body}</Text>
          <Muted small>
            {n.authorName} · {formatWhen(n.createdAt)}
          </Muted>
        </View>
      ))}
      <TextInput value={text} onChangeText={setText} placeholder="Add a note for other admins and mods" placeholderTextColor={colors.faint} multiline style={inputStyle} />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button title="Add note" kind="secondary" onPress={() => void add()} busy={busy} disabled={!text.trim()} />
    </Card>
  );
}
