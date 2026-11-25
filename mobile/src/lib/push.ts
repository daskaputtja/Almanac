import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { PushPreferences } from '../../../shared/app';
import { api } from './api';

// Show notifications even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushResult = { ok: true; preferences: PushPreferences } | { ok: false; reason: string };

/**
 * Ask for permission, get this phone's Expo push token, and register it with
 * Almanac. Safe to call on every start: it just refreshes the registration.
 */
export async function registerForPush(askIfNeeded: boolean): Promise<PushResult> {
  if (!Device.isDevice) return { ok: false, reason: 'Notifications only work on a real phone, not a simulator.' };
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Almanac',
      importance: Notifications.AndroidImportance.HIGH,
      lightColor: '#ef4444',
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted' && askIfNeeded) status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { ok: false, reason: 'Notifications are turned off for Almanac in your phone’s settings.' };

  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return { ok: false, reason: 'This build of the app isn’t set up for notifications yet.' };
  const { data: pushToken } = await Notifications.getExpoPushTokenAsync({ projectId });
  const { preferences } = await api<{ preferences: PushPreferences }>('/api/app/push', {
    method: 'POST',
    body: { pushToken, platform: Platform.OS, deviceName: Device.deviceName ?? Device.modelName ?? null },
  });
  return { ok: true, preferences };
}

/** Where a tapped notification should open, from the website path Almanac sends. */
export function routeFor(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const user = path.match(/^\/users\/([^/?#]+)/);
  if (user) return `/users/${user[1]}`;
  if (path.startsWith('/moderation')) return '/moderation';
  if (path.startsWith('/server')) return '/server';
  return '/';
}
