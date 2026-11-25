import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, ErrorText, Field, Muted } from '../components/ui';
import { ApiError, checkServer, normaliseServer } from '../lib/api';
import { useAuth } from '../lib/auth';
import { colors, space } from '../lib/theme';

/** First screen: which Almanac to connect to. Every Almanac is self-hosted. */
export default function Connect() {
  const { setServerAddress } = useAuth();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = normaliseServer(address);
      await checkServer(url);
      await setServerAddress(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That isn’t a web address.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.body}>
        <View style={{ gap: space.sm }}>
          <Text style={styles.logo}>Almanac</Text>
          <Muted>Monitoring, history and moderation for your Silo server. Enter the address of your Almanac to start.</Muted>
        </View>
        <Field
          label="Your Almanac’s address"
          value={address}
          onChangeText={setAddress}
          placeholder="almanac.example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={() => void connect()}
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <Button title="Continue" onPress={() => void connect()} busy={busy} disabled={!address.trim()} />
        <Muted small>Almanac is self-hosted: you need an account on someone’s Almanac, given to you by its admin.</Muted>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  body: { flex: 1, padding: space.xl, gap: space.lg, justifyContent: 'center' },
  logo: { color: colors.ink, fontSize: 44, fontWeight: '800', letterSpacing: -1.5 },
});
