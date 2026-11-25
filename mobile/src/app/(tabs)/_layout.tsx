import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useAuth } from '../../lib/auth';
import { colors } from '../../lib/theme';

type Icon = React.ComponentProps<typeof Ionicons>['name'];
const icon = (name: Icon) => ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={typeof color === 'string' ? color : colors.faint} size={size} />;

export default function TabsLayout() {
  const { can } = useAuth();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.canvas },
        headerTintColor: colors.ink,
        headerTitleStyle: { fontWeight: '700' },
        tabBarStyle: { backgroundColor: colors.canvas, borderTopColor: colors.line },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.faint,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Activity', tabBarIcon: icon('pulse') }} />
      <Tabs.Screen name="moderation" options={{ title: 'Moderation', tabBarIcon: icon('shield-checkmark-outline'), href: can('moderate') ? undefined : null }} />
      <Tabs.Screen name="users" options={{ title: 'Users', tabBarIcon: icon('people-outline') }} />
      <Tabs.Screen name="server" options={{ title: 'Server', tabBarIcon: icon('server-outline') }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: icon('ellipsis-horizontal') }} />
    </Tabs>
  );
}
