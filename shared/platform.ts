/** Friendly names for the device platforms Silo reports. */
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
