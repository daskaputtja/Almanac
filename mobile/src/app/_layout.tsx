import * as Notifications from 'expo-notifications';
import { Stack, router, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Loading } from '../components/ui';
import { AuthProvider, useAuth } from '../lib/auth';
import { registerForPush, routeFor } from '../lib/push';
import { colors } from '../lib/theme';

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Gate />
    </AuthProvider>
  );
}

/** Sends people to the right place: the address screen, sign-in, or the app. */
function Gate() {
  const { stage } = useAuth();
  const segments = useSegments();
  const lastTap = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (stage === 'loading') return;
    const here = segments[0];
    if (stage === 'connect' && here !== 'connect') router.replace('/connect');
    else if (stage === 'signIn' && here !== 'sign-in') router.replace('/sign-in');
    else if (stage === 'ready' && (here === 'connect' || here === 'sign-in')) router.replace('/');
  }, [stage, segments]);

  // Keep this phone registered for notifications (quietly; the More tab asks for permission).
  useEffect(() => {
    if (stage === 'ready') void registerForPush(false).catch(() => {});
  }, [stage]);

  // Tapping a notification opens the account, the Moderation tab or the Server tab.
  useEffect(() => {
    if (stage !== 'ready' || !lastTap) return;
    const route = routeFor(lastTap.notification.request.content.data?.path);
    if (route) router.push(route as never);
  }, [stage, lastTap]);

  if (stage === 'loading') return <Loading />;
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.canvas },
        headerTintColor: colors.ink,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colors.canvas },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="connect" options={{ title: 'Almanac', headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ title: 'Sign in', headerShown: false }} />
      <Stack.Screen name="users/[id]" options={{ title: '' }} />
    </Stack>
  );
}
