import Constants from 'expo-constants';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Switch, Text, View } from 'react-native';
import type { PushPreferences } from '../../../../shared/app';
import { Button, Card, ErrorText, Label, Muted, Screen, Segmented } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { registerForPush } from '../../lib/push';
import { colors, space } from '../../lib/theme';

/** Account, notifications and the rest. */
export default function More() {
  const { me, server, can, signOut, disconnect } = useAuth();
  const [prefs, setPrefs] = useState<PushPreferences | null>(null);
  const [pushProblem, setPushProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ preferences: PushPreferences | null }>('/api/app/push')
      .then((r) => setPrefs(r.preferences))
      .catch(() => {});
  }, []);

  const turnOn = async () => {
    setBusy(true);
    setPushProblem(null);
    try {
      const result = await registerForPush(true);
      if (result.ok) setPrefs(result.preferences);
      else setPushProblem(result.reason);
    } catch (err) {
      setPushProblem(err instanceof ApiError ? err.message : 'Couldn’t turn on notifications.');
    } finally {
      setBusy(false);
    }
  };

  const update = useCallback(async (change: Partial<PushPreferences>) => {
    try {
      setPrefs((await api<{ preferences: PushPreferences }>('/api/app/push/preferences', { method: 'POST', body: change })).preferences);
    } catch (err) {
      setPushProblem(err instanceof ApiError ? err.message : 'Couldn’t save that.');
    }
  }, []);

  return (
    <Screen>
      <Card>
        <Label>Signed in</Label>
        <Text style={{ color: colors.ink, fontSize: 18, fontWeight: '700' }}>{me?.username}</Text>
        <Muted small>
          {me?.role === 'admin' ? 'Admin' : 'Mod'} · {server?.replace(/^https?:\/\//, '')}
        </Muted>
      </Card>

      <Card>
        <Label>Notifications</Label>
        {!prefs ? (
          <>
            <Muted>Get a notification for new account flags{can('reviewSuspension') ? ', suspension requests' : ''} and server problems.</Muted>
            {pushProblem ? <ErrorText>{pushProblem}</ErrorText> : null}
            <Button title="Turn on notifications" onPress={() => void turnOn()} busy={busy} />
          </>
        ) : (
          <View style={{ gap: space.md }}>
            {can('moderate') ? (
              <View style={{ gap: space.xs }}>
                <Text style={{ color: colors.ink, fontWeight: '600' }}>Account flags</Text>
                <Segmented
                  value={prefs.flags}
                  onChange={(flags) => void update({ flags })}
                  options={[
                    { value: 'high', label: 'Serious' },
                    { value: 'medium', label: 'Worth a look+' },
                    { value: 'low', label: 'All' },
                    { value: 'off', label: 'Off' },
                  ]}
                />
              </View>
            ) : null}
            {can('requestSuspension') ? (
              <Toggle label={can('reviewSuspension') ? 'Suspension requests to review' : 'Outcomes of my suspension requests'} value={prefs.suspensions} onChange={(suspensions) => void update({ suspensions })} />
            ) : null}
            <Toggle label="Server problems" detail="Streams dropping, or a server going down or coming back" value={prefs.serverAlerts} onChange={(serverAlerts) => void update({ serverAlerts })} />
            <Toggle label="Show names in notifications" detail="Off shows only “New account flag” on your lock screen" value={prefs.details} onChange={(details) => void update({ details })} />
            {pushProblem ? <ErrorText>{pushProblem}</ErrorText> : null}
            {message ? <Muted small>{message}</Muted> : null}
            <Button
              title="Send a test notification"
              kind="secondary"
              onPress={() =>
                void api('/api/app/push/test', { method: 'POST', body: {} })
                  .then(() => setMessage('Sent. It should arrive in a few seconds.'))
                  .catch((err) => setPushProblem(err instanceof ApiError ? err.message : 'Couldn’t send it.'))
              }
            />
          </View>
        )}
      </Card>

      <Card>
        <Label>More</Label>
        <Muted>Statistics, history, recaps and settings are on the website.</Muted>
        <Button title="Open Almanac in the browser" kind="secondary" onPress={() => server && void Linking.openURL(server)} />
      </Card>

      <Button title="Sign out" kind="secondary" onPress={() => void signOut()} />
      <Button title="Use a different Almanac" kind="secondary" onPress={() => void disconnect()} />
      <Muted small>Almanac {Constants.expoConfig?.version ?? ''}</Muted>
    </Screen>
  );
}

function Toggle({ label, detail, value, onChange }: { label: string; detail?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.ink, fontWeight: '600' }}>{label}</Text>
        {detail ? <Muted small>{detail}</Muted> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent, false: colors.line }} thumbColor="#fff" />
    </View>
  );
}
