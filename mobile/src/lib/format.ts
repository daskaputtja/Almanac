/** "Just now", "5 min ago", "Today 21:04", "Mon 18:30", "12 Nov". */
export function formatWhen(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = now - t;
  if (diff >= 0 && diff < 60_000) return 'Just now';
  if (diff >= 0 && diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (diff > 0 && diff < 6 * 86_400_000) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** Flag text marks times as {{time:ISO}}; show them in the phone's own time. */
export function flagText(text: string): string {
  return text.replace(/\{\{time:([^}]+)\}\}/g, (_, iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  });
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 GB';
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

export function formatMbps(kbps: number | null | undefined): string {
  if (!kbps) return '0 Mbps';
  return `${(kbps / 1000).toFixed(kbps >= 100_000 ? 0 : 1)} Mbps`;
}

export function episodeCode(season: number | null, episode: number | null): string | null {
  if (season == null || episode == null) return null;
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/** Friendly platform names (a copy of shared/platform.ts: the app can only import types from outside its folder). */
const PLATFORM_LABELS: Record<string, string> = {
  'android-tv': 'Android TV',
  'fire-tv': 'Fire TV',
  firetv: 'Fire TV',
  'google-tv': 'Google TV',
  webos: 'webOS',
  tizen: 'Tizen',
  xbox: 'Xbox',
  playstation: 'PlayStation',
  chromecast: 'Chromecast',
  android: 'Android',
  ios: 'iOS',
  ipados: 'iPadOS',
  tvos: 'tvOS',
  macos: 'macOS',
  web: 'Web',
  roku: 'Roku',
  windows: 'Windows',
  linux: 'Linux',
};

export function platformLabel(platform: string | null): string | null {
  if (!platform) return null;
  const known = PLATFORM_LABELS[platform.toLowerCase()];
  if (known) return known;
  const words = platform.replace(/[-_]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
