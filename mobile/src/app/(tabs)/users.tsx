import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import type { UserSummary } from '../../../../shared/users';
import { ErrorText, Muted } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { formatWhen } from '../../lib/format';
import { colors, radius, space } from '../../lib/theme';

/** Every account, searchable by name or email. */
export default function Users() {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers((await api<{ users: UserSummary[] }>('/api/users')).users);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t load users.');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!users) void load();
    }, [load, users]),
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = users ?? [];
    return q ? list.filter((u) => u.name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)) : list;
  }, [users, query]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <View style={{ padding: space.lg, paddingBottom: space.sm }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search by name or email"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          style={styles.search}
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
        {users ? <Muted small>{shown.length.toLocaleString()} of {users.length.toLocaleString()} accounts</Muted> : null}
      </View>
      <FlatList
        data={shown}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.accent}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        renderItem={({ item: u }) => (
          <Pressable onPress={() => router.push(`/users/${encodeURIComponent(u.id)}` as never)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.panel }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {u.name}
                {u.enabled === false ? <Text style={{ color: colors.faint, fontWeight: '400' }}> · disabled</Text> : null}
              </Text>
              {u.email ? <Muted small>{u.email}</Muted> : null}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Muted small>{u.lastPlayedAt ? formatWhen(u.lastPlayedAt) : 'Never'}</Muted>
              <Muted small>{u.plays30Days.toLocaleString()} plays / 30 days</Muted>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  search: { backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1, borderRadius: radius.md, color: colors.ink, fontSize: 16, paddingHorizontal: space.md, paddingVertical: 10, marginBottom: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, gap: space.md },
  name: { color: colors.ink, fontSize: 16, fontWeight: '600' },
});
