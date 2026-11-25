import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, ErrorText, Field, Muted } from '../components/ui';
import { ApiError, api, setToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { colors, space } from '../lib/theme';

/** Username and password, then the 2FA code (or a recovery code). */
export default function SignIn() {
  const { server, refresh, disconnect } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const logIn = () =>
    run(async () => {
      const result = await api<{ next: 'totp' | 'enroll'; token: string }>('/api/auth/login', { method: 'POST', body: { username: username.trim(), password }, auth: null });
      if (result.next === 'enroll') {
        setError('Set up two-factor authentication on the Almanac website first, then sign in here.');
        return;
      }
      setPending(result.token);
    });

  const verify = () =>
    run(async () => {
      const body = useRecovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, '') };
      const result = await api<{ token: string }>('/api/auth/verify', { method: 'POST', body, auth: pending });
      await setToken(result.token);
      await refresh();
    });

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.body}>
        <View style={{ gap: space.xs }}>
          <Text style={styles.title}>Sign in</Text>
          <Muted small>{server?.replace(/^https?:\/\//, '')}</Muted>
        </View>
        {!pending ? (
          <>
            <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} textContentType="username" autoComplete="username" />
            <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" autoComplete="password" returnKeyType="go" onSubmitEditing={() => void logIn()} />
            {error ? <ErrorText>{error}</ErrorText> : null}
            <Button title="Continue" onPress={() => void logIn()} busy={busy} disabled={!username.trim() || !password} />
          </>
        ) : (
          <>
            <Field
              label={useRecovery ? 'Recovery code' : 'Code from your authenticator app'}
              value={code}
              onChangeText={setCode}
              autoFocus
              autoCapitalize="none"
              keyboardType={useRecovery ? 'default' : 'number-pad'}
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              returnKeyType="go"
              onSubmitEditing={() => void verify()}
            />
            {error ? <ErrorText>{error}</ErrorText> : null}
            <Button title="Sign in" onPress={() => void verify()} busy={busy} disabled={!code.trim()} />
            <Pressable onPress={() => setUseRecovery(!useRecovery)}>
              <Text style={styles.link}>{useRecovery ? 'Use a code from my authenticator' : 'Use a recovery code instead'}</Text>
            </Pressable>
          </>
        )}
        <Pressable onPress={() => void disconnect()}>
          <Text style={styles.link}>Use a different Almanac</Text>
        </Pressable>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  body: { flex: 1, padding: space.xl, gap: space.lg, justifyContent: 'center' },
  title: { color: colors.ink, fontSize: 32, fontWeight: '800' },
  link: { color: colors.accent, fontSize: 15, textAlign: 'center', paddingVertical: space.sm },
});
