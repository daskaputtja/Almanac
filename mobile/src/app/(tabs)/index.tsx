import { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { ActivitySnapshot, ActivityStream } from '../../../../shared/activity';
import { Card, ErrorText, Muted, Pill, Screen, Stat } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { episodeCode, formatDuration, formatMbps } from '../../lib/format';
import { colors, methodColors, methodLabels, radius, space } from '../../lib/theme';

/** Who's watching right now. Refreshes every 10 seconds. */
export default function Activity() {
  const [data, setData] = useState<ActivitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<ActivitySnapshot>('/api/activity'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t load activity.');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  const s = data?.summary;
  return (
    <Screen
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
    >
      {error ? <ErrorText>{error}</ErrorText> : null}
      {data?.error ? <ErrorText>Silo isn’t answering: {data.error}</ErrorText> : null}
      {s ? (
        <View style={styles.stats}>
          <Stat label="Streams" value={String(s.total)} detail={`${s.playing} playing · ${s.paused} paused`} />
          <Stat label="Bandwidth" value={formatMbps(s.bandwidthKbps)} detail={`${s.local} local · ${s.remote} remote`} />
        </View>
      ) : null}
      {data && data.streams.length === 0 ? (
        <Card>
          <Muted>Nobody is watching right now.</Muted>
        </Card>
      ) : null}
      {data?.streams.map((stream) => <StreamCard key={stream.id} stream={stream} networks={data.liveNetworks?.[stream.user.id]} />)}
    </Screen>
  );
}

function StreamCard({ stream: s, networks }: { stream: ActivityStream; networks?: number }) {
  const code = episodeCode(s.media.seasonNumber, s.media.episodeNumber);
  const progress = s.media.durationSeconds ? Math.min(1, s.progress.positionSeconds / s.media.durationSeconds) : 0;
  const method = s.playback.method;
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        {s.media.posterUrl ? <Image source={{ uri: s.media.posterUrl }} style={styles.poster} /> : <View style={[styles.poster, { backgroundColor: colors.raised }]} />}
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={styles.title} numberOfLines={2}>
            {s.media.seriesTitle ?? s.media.title}
          </Text>
          {s.media.seriesTitle ? (
            <Muted small>
              {[code, s.media.title].filter(Boolean).join(' · ')}
            </Muted>
          ) : null}
          <Text style={styles.user}>{s.user.name}</Text>
          <Pill text={`${methodLabels[method] ?? method}${s.progress.paused ? ' · paused' : ''}`} color={methodColors[method] ?? colors.faint} />
          <Muted small>{[s.client.label ?? s.client.name, s.client.platform].filter(Boolean).join(' · ')}</Muted>
          {networks && networks > 1 ? <Text style={{ color: colors.warning, fontSize: 12, fontWeight: '600' }}>On {networks} networks now</Text> : null}
        </View>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${progress * 100}%` }]} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Muted small>{formatDuration(s.progress.positionSeconds)}</Muted>
        <Muted small>{formatDuration(s.media.durationSeconds)}</Muted>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: 'row', gap: space.md, flexWrap: 'wrap' },
  poster: { width: 64, height: 96, borderRadius: radius.sm },
  title: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  user: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  track: { height: 4, backgroundColor: colors.raised, borderRadius: 2, marginTop: space.sm, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.accent },
});
