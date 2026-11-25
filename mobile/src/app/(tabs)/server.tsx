import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import type { NodesResponse } from '../../../../shared/load';
import type { NotificationsResponse } from '../../../../shared/notifications';
import type { ReliabilityResponse } from '../../../../shared/reliability';
import type { ServerOverview } from '../../../../shared/server';
import { Card, ErrorText, Label, Muted, Pill, Screen, Stat } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatWhen } from '../../lib/format';
import { colors, space } from '../../lib/theme';

const DOT: Record<string, string> = { up: '🟢', down: '🔴', pending: '🟡', maintenance: '🔧', unknown: '⚪' };

/** Silo's health, its nodes, how reliably streams play, and Uptime Kuma. */
export default function Server() {
  const { can } = useAuth();
  const [overview, setOverview] = useState<ServerOverview | null>(null);
  const [nodes, setNodes] = useState<NodesResponse | null>(null);
  const [reliability, setReliability] = useState<ReliabilityResponse | null>(null);
  const [status, setStatus] = useState<NotificationsResponse['status'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, n, r, s] = await Promise.all([
        api<ServerOverview>('/api/server/overview'),
        api<NodesResponse>('/api/server/nodes'),
        api<ReliabilityResponse>('/api/server/reliability?range=24h'),
        can('manageNotifications') ? api<NotificationsResponse>('/api/notifications').then((x) => x.status ?? null) : Promise.resolve(null),
      ]);
      setOverview(o);
      setNodes(n);
      setReliability(r);
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t load the server.');
    }
  }, [can]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const uptime = overview?.startedAt ? since(overview.startedAt) : '—';
  const dropped = reliability && reliability.totals.plays ? reliability.totals.dropped / reliability.totals.plays : null;
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
      {overview ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
          <Stat label="Uptime" value={uptime} detail={overview.version ? `version ${overview.version}` : undefined} />
          <Stat label="Nodes" value={overview.nodes ? `${overview.nodes.healthy}/${overview.nodes.total}` : '—'} detail="healthy" />
          <Stat label="Postgres" value={overview.postgres?.ok ? 'OK' : overview.postgres ? 'Down' : '—'} />
          <Stat label="Redis" value={overview.redis?.ok ? 'OK' : overview.redis ? 'Down' : '—'} />
          <Stat label="Watched today" value={overview.profiles24h.toLocaleString()} detail="profiles" />
          <Stat label="Dropped streams" value={dropped == null ? '—' : `${(dropped * 100).toFixed(1)}%`} detail="last 24 hours" />
        </View>
      ) : null}

      {status && status.monitors.length ? (
        <Card>
          <Label>Server status</Label>
          {status.monitors.map((m) => (
            <Text key={`${m.group}:${m.name}`} style={{ color: colors.ink, fontSize: 15, paddingVertical: 2 }}>
              {DOT[m.state]} <Text style={{ fontWeight: '700' }}>{m.name}</Text>
              <Text style={{ color: colors.muted }}>
                {m.state === 'up' ? (m.uptimeToday == null ? '' : `: ${m.uptimeToday >= 0.99995 ? '100' : (Math.floor(m.uptimeToday * 10000) / 100).toFixed(2)}% today`) : `: ${m.state}`}
              </Text>
            </Text>
          ))}
          {status.lastUpdatedAt ? <Muted small>Checked {formatWhen(status.lastUpdatedAt)}</Muted> : null}
        </Card>
      ) : null}

      {nodes?.nodes.map((n) => (
        <Card key={n.id} accent={!n.enabled ? colors.faint : n.healthy ? colors.good : colors.critical}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
            <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '700' }}>{n.name}</Text>
            <Pill text={!n.enabled ? 'Off' : n.draining ? 'Draining' : n.healthy ? 'Healthy' : 'Unhealthy'} color={!n.enabled ? colors.faint : n.healthy ? colors.good : colors.critical} />
          </View>
          <Muted small>
            {[n.type, `${n.streams} streams`, `${n.egressMbps.toLocaleString()} Mbps`, n.cpuPercent != null ? `CPU ${Math.round(n.cpuPercent)}%` : null].filter(Boolean).join(' · ')}
          </Muted>
        </Card>
      ))}
    </Screen>
  );
}

function since(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
