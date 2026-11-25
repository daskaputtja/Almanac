import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { colors, radius, space } from '../lib/theme';

/** A scrolling screen with pull-to-refresh. */
export function Screen({ children, onRefresh, refreshing = false }: { children: React.ReactNode; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.canvas }}
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 }}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} /> : undefined}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style, accent }: { children: React.ReactNode; style?: ViewStyle; accent?: string }) {
  return <View style={[styles.card, accent ? { borderLeftWidth: 3, borderLeftColor: accent } : null, style]}>{children}</View>;
}

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Muted({ children, small }: { children: React.ReactNode; small?: boolean }) {
  return <Text style={[styles.muted, small && { fontSize: 12 }]}>{children}</Text>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  busy,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
}) {
  const bg = kind === 'primary' ? colors.accent : kind === 'danger' ? '#b91c1c' : 'transparent';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: kind === 'secondary' ? colors.line : bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color={kind === 'secondary' ? colors.ink : colors.canvas} /> : <Text style={[styles.buttonText, { color: kind === 'primary' ? colors.canvas : kind === 'danger' ? '#fff' : colors.ink }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: space.xs }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput placeholderTextColor={colors.faint} style={[styles.input, style]} {...rest} />
    </View>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  return <Text style={{ color: '#fca5a5', fontSize: 14 }}>{children}</Text>;
}

export function Loading() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas, padding: space.xl }}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

/** A small coloured pill, always with words (colour is never the only signal). */
export function Pill({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.pillText}>{text}</Text>
    </View>
  );
}

export function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Card style={{ flex: 1, minWidth: 140 }}>
      <Label>{label}</Label>
      <Text style={styles.statValue}>{value}</Text>
      {detail ? <Muted small>{detail}</Muted> : null}
    </Card>
  );
}

/** Choose one of a few options. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          accessibilityRole="button"
          accessibilityState={{ selected: o.value === value }}
          style={[styles.segment, o.value === value && { backgroundColor: colors.raised }]}
        >
          <Text style={{ color: o.value === value ? colors.ink : colors.muted, fontWeight: o.value === value ? '600' : '400', fontSize: 14 }}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Re-render every so often so "5 min ago" stays true. */
export function useTick(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: space.xs },
  title: { color: colors.ink, fontSize: 22, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  label: { color: colors.faint, fontSize: 11, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase' },
  button: { borderWidth: 1, borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: space.lg, alignItems: 'center', justifyContent: 'center', minHeight: 46 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  fieldLabel: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  input: { backgroundColor: colors.canvas, borderColor: colors.line, borderWidth: 1, borderRadius: radius.md, color: colors.ink, fontSize: 16, paddingHorizontal: space.md, paddingVertical: 12 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  statValue: { color: colors.ink, fontSize: 24, fontWeight: '700' },
  segmented: { flexDirection: 'row', backgroundColor: colors.panel, borderColor: colors.line, borderWidth: 1, borderRadius: radius.md, padding: 3 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radius.sm },
});
