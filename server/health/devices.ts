/**
 * What a viewer is watching on, worked out from what Silo reports (the
 * platform, the app's name and the model a signed-in device gives), and
 * what usually helps on that kind of device.
 */

export type DeviceKind =
  | 'fire-tv-4k'
  | 'fire-tv-hd'
  | 'fire-tv-cube'
  | 'fire-tv'
  | 'shield'
  | 'chromecast-4k'
  | 'chromecast-hd'
  | 'google-tv-streamer'
  | 'onn'
  | 'android-tv-set'
  | 'android-tv-box'
  | 'apple-tv'
  | 'roku'
  | 'lg-tv'
  | 'samsung-tv'
  | 'xbox'
  | 'iphone'
  | 'android-phone'
  | 'browser'
  | 'computer';

export interface DeviceInfo {
  kind: DeviceKind;
  /** A friendly name, e.g. "Fire TV Stick 4K Max (2021)". */
  name: string;
}

export type TipTopic = 'drops' | 'slowStarts' | 'video' | 'hdr' | 'audio' | 'subtitles' | 'quality';

/** Amazon's model codes for Fire TV devices. */
const FIRE_TV_MODELS: Record<string, { name: string; kind: DeviceKind }> = {
  AFTMM: { name: 'Fire TV Stick 4K (2018)', kind: 'fire-tv-4k' },
  AFTKA: { name: 'Fire TV Stick 4K Max (2021)', kind: 'fire-tv-4k' },
  AFTKM: { name: 'Fire TV Stick 4K (2023)', kind: 'fire-tv-4k' },
  AFTKRT: { name: 'Fire TV Stick 4K Max (2023)', kind: 'fire-tv-4k' },
  AFTSSS: { name: 'Fire TV Stick (3rd gen)', kind: 'fire-tv-hd' },
  AFTSS: { name: 'Fire TV Stick Lite', kind: 'fire-tv-hd' },
  AFTT: { name: 'Fire TV Stick (2nd gen)', kind: 'fire-tv-hd' },
  AFTR: { name: 'Fire TV Cube (2nd gen)', kind: 'fire-tv-cube' },
  AFTGAZL: { name: 'Fire TV Cube (3rd gen)', kind: 'fire-tv-cube' },
};

/** Brands that make TVs with Android TV or Google TV built in. */
const TV_BRANDS = /\b(tcl|hisense|sony|bravia|xiaomi|mitv|philips|sharp|toshiba|panasonic|skyworth|smart ?tv|vizio|haier|tv pro)\b/i;

/** Work out the device from what Silo knows. Null when there's nothing to go on. */
export function describeDevice(platform: string | null, client: string | null, model: string | null): DeviceInfo | null {
  const p = (platform ?? '').toLowerCase();
  const c = (client ?? '').toLowerCase();
  const m = (model ?? '').trim();
  const ml = m.toLowerCase();

  // A signed-in device's model is the most specific thing Silo gives.
  const fire = m.match(/\b(AFT[A-Z0-9]+)\b/);
  if (fire) {
    const known = FIRE_TV_MODELS[fire[1]!];
    return known ?? { kind: 'fire-tv', name: `Fire TV (${fire[1]})` };
  }
  if (/shield/.test(ml)) return { kind: 'shield', name: 'NVIDIA Shield' };
  if (/google tv streamer/.test(ml)) return { kind: 'google-tv-streamer', name: 'Google TV Streamer' };
  if (/chromecast hd/.test(ml)) return { kind: 'chromecast-hd', name: 'Chromecast with Google TV (HD)' };
  if (/chromecast/.test(ml)) return { kind: 'chromecast-4k', name: 'Chromecast with Google TV' };
  if (/^onn\b/.test(ml)) return { kind: 'onn', name: tidyModel(m) };
  if (/apple tv/.test(ml) || p === 'tvos' || /tvos|apple tv/.test(c)) return { kind: 'apple-tv', name: 'Apple TV' };
  if (/iphone|ipad/.test(ml) || p === 'ios' || /\b(iphone|ipad|ios)\b/.test(c)) {
    return { kind: 'iphone', name: /ipad/.test(ml) || /ipad/.test(c) ? 'iPad' : 'iPhone' };
  }
  if (/\bweb\b/.test(p) || / on (windows|macos|linux|android|ios|web)$/.test(ml) || /\bweb\b/.test(c) && !/webos/.test(c)) {
    return { kind: 'browser', name: m && / on /.test(m) ? m : 'web browser' };
  }
  if (p === 'roku' || /roku/.test(c)) return { kind: 'roku', name: 'Roku' };
  if (p === 'webos' || /webos/.test(c)) return { kind: 'lg-tv', name: 'LG TV' };
  if (p === 'tizen' || /tizen/.test(c)) return { kind: 'samsung-tv', name: 'Samsung TV' };
  if (p === 'xbox' || /xbox/.test(c)) return { kind: 'xbox', name: 'Xbox' };
  if (/fire ?tv/.test(c) || /fire/.test(p)) return { kind: 'fire-tv', name: 'Fire TV' };
  if (p === 'android-tv' || p === 'android tv' || /android\W*tv|google tv/.test(c)) {
    if (m && TV_BRANDS.test(m)) return { kind: 'android-tv-set', name: tidyModel(m) };
    return { kind: 'android-tv-box', name: m ? tidyModel(m) : 'Android TV device' };
  }
  if (p === 'android' || /android/.test(c)) return { kind: 'android-phone', name: m ? tidyModel(m) : 'Android phone' };
  if (/^(windows|macos|linux)$/.test(p) || /\b(mac|windows|silage|media player)\b/.test(c)) return { kind: 'computer', name: 'computer' };
  return null;
}

/** "Google Google TV Streamer" → "Google TV Streamer", "onn onn. 4K Plus Streaming" → "onn 4K Plus Streaming". */
function tidyModel(model: string): string {
  const words = model.replace(/\s+/g, ' ').trim().split(' ');
  if (words.length > 1 && words[1]!.replace(/\W/g, '').toLowerCase().startsWith(words[0]!.toLowerCase())) words.shift();
  const out = words.join(' ').replace(/^onn\./i, 'onn');
  return out.charAt(0) === out.charAt(0).toLowerCase() && !/^onn\b/i.test(out) ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

// --- What helps ------------------------------------------------------------------

const FIRE_RESTART = 'Restart it: hold Select and Play/Pause on the remote together for about 5 seconds.';
const FIRE_CACHE = 'Clear the app’s cache: Settings → Applications → Manage Installed Applications → the app → Clear cache.';
const FIRE_WIFI =
  'Sticks sit behind the TV, where Wi-Fi is often weak. The HDMI extender that comes in the box moves it out into the open, and Amazon’s Ethernet Adapter for Fire TV makes it wired.';
const FIRE_MEMORY = 'Fire TV sticks have little memory: uninstalling apps they don’t use and not leaving others running helps.';
const FIRE_AUDIO = 'With a soundbar or AV receiver, Settings → Display & Sounds → Audio → Surround Sound → Best Available lets it pass surround sound through.';
const GTV_CACHE = 'Clear the app’s cache (Settings → Apps → the app → Clear cache). These have little storage, and a nearly full device slows everything down.';
const TV_WIRED =
  'TVs’ built-in Wi-Fi is often weak. A cable helps, though many TVs’ Ethernet ports are limited to 100 Mbps, too slow for some 4K files. A 4K streaming stick or box often plays better than the TV’s own apps.';
const TV_POWER = 'Switch the TV off at the wall for a minute: the remote’s power button usually only puts it to sleep, so it never really restarts.';
const TV_AUDIO = 'Many TVs can’t play DTS or TrueHD. With a soundbar on HDMI ARC or eARC, set the TV’s digital audio output to Passthrough or Auto.';
const PHONE_DROPS = 'On phones and tablets, locking the screen or switching to another app ends the stream, so some drops are normal.';
const PHONE_NETWORK = 'Moving between Wi-Fi and mobile data (leaving the house, say) drops the stream.';
const PHONE_QUALITY = 'On mobile data, apps often pick a lower quality to save data. On Wi-Fi, setting the quality to Auto or Original lets files play directly.';
const BOX_WIRED = 'If it has an Ethernet port, a cable is far steadier than Wi-Fi.';
const UPGRADE_4K = 'It’s a 1080p model, so 4K files are converted. A 4K stick or box would play them directly.';

const TIPS: Record<DeviceKind, Partial<Record<TipTopic, string[]>>> = {
  'fire-tv-4k': { drops: [FIRE_WIFI, FIRE_RESTART, FIRE_CACHE], slowStarts: [FIRE_RESTART, FIRE_CACHE, FIRE_MEMORY], audio: [FIRE_AUDIO] },
  'fire-tv-hd': {
    drops: [FIRE_WIFI, FIRE_RESTART, FIRE_MEMORY],
    slowStarts: [FIRE_MEMORY, FIRE_CACHE],
    video: [UPGRADE_4K],
    hdr: [UPGRADE_4K],
    audio: [FIRE_AUDIO],
  },
  'fire-tv-cube': {
    drops: ['The Fire TV Cube can be wired with Ethernet, which is the most reliable fix.', FIRE_RESTART],
    slowStarts: [FIRE_RESTART, FIRE_CACHE],
    audio: [FIRE_AUDIO],
  },
  'fire-tv': { drops: [FIRE_WIFI, FIRE_RESTART, FIRE_CACHE], slowStarts: [FIRE_RESTART, FIRE_CACHE, FIRE_MEMORY], audio: [FIRE_AUDIO] },
  shield: {
    drops: [
      'The Shield is one of the most capable players, so drops on it usually point to the network rather than the device.',
      'It has an Ethernet port: a cable is the most reliable fix.',
    ],
    audio: ['The Shield can pass almost any audio format to a receiver: in its Advanced sound settings, choose the formats their receiver or soundbar supports.'],
  },
  'chromecast-4k': {
    drops: ['It’s Wi-Fi only out of the box. A USB-C hub with Ethernet and power makes it much steadier.', GTV_CACHE],
    slowStarts: [GTV_CACHE],
  },
  'chromecast-hd': {
    drops: ['It’s Wi-Fi only out of the box. A USB-C hub with Ethernet and power makes it much steadier.', GTV_CACHE],
    slowStarts: [GTV_CACHE],
    video: [UPGRADE_4K],
    hdr: [UPGRADE_4K],
  },
  'google-tv-streamer': {
    drops: ['The Google TV Streamer has an Ethernet port: a cable is the most reliable fix.', GTV_CACHE],
    slowStarts: [GTV_CACHE],
  },
  onn: {
    drops: ['onn devices are budget players with modest Wi-Fi. The onn 4K Pro has an Ethernet port; on the others, a stronger Wi-Fi signal near the TV helps most.', GTV_CACHE],
    slowStarts: ['Budget players are slow to start converted streams.', GTV_CACHE],
  },
  'android-tv-set': { drops: [TV_WIRED, TV_POWER], slowStarts: [TV_POWER], audio: [TV_AUDIO] },
  'android-tv-box': { drops: [BOX_WIRED, GTV_CACHE], slowStarts: [GTV_CACHE] },
  'apple-tv': {
    drops: ['Apple TV 4K models with an Ethernet port are steadiest on a cable.', 'Restart it from Settings → System → Restart.'],
    hdr: ['If their TV supports HDR, turn on Settings → Video and Audio → Match Content → Match Dynamic Range.'],
  },
  roku: {
    drops: ['Rokus with an Ethernet port (the Ultra, and Roku TVs) are steadier on a cable than on Wi-Fi.', 'Restart it from Settings → System → Power → System restart.'],
    slowStarts: ['Restart it from Settings → System → Power → System restart.'],
    video: ['Cheaper and older Rokus can’t play HEVC or 4K HDR, so those are converted. A 4K Roku plays them directly.'],
    hdr: ['Cheaper and older Rokus can’t show HDR, so HDR files are converted.'],
    audio: ['Rokus don’t play DTS or TrueHD themselves, so those tracks are converted. A Dolby (AC3 or EAC3) track, where the file has one, plays directly.'],
    subtitles: ['Rokus can’t show image subtitles (PGS), so they’re burned in. Text subtitles (SRT) avoid that.'],
  },
  'lg-tv': {
    drops: [TV_WIRED, TV_POWER],
    audio: ['Many LG TVs don’t play DTS, so it’s converted. A Dolby audio track, or a soundbar on eARC set to passthrough, avoids it.'],
  },
  'samsung-tv': {
    drops: [TV_WIRED, TV_POWER],
    audio: ['Samsung TVs from recent years don’t play DTS, so it’s converted. A Dolby audio track, or a soundbar on eARC set to passthrough, avoids it.'],
  },
  xbox: { drops: ['Consoles are best on a cable: the Xbox has an Ethernet port.'] },
  iphone: { drops: [PHONE_DROPS, PHONE_NETWORK, 'Low Power Mode can cut playback short.'], quality: [PHONE_QUALITY] },
  'android-phone': {
    drops: [PHONE_DROPS, PHONE_NETWORK, 'Battery saving can stop playback: setting the app’s battery use to Unrestricted helps.'],
    quality: [PHONE_QUALITY],
  },
  browser: {
    drops: ['A browser tab in the background, or the computer going to sleep, ends the stream.'],
    video: ['Browsers can’t play some video formats (HEVC in many), so they convert more than apps do. The Silo app on their TV or phone usually plays these directly.'],
    audio: ['Browsers can’t play DTS or TrueHD, so those tracks are always converted. An app on their TV or phone usually plays them.'],
    subtitles: ['Browsers can’t show image subtitles (PGS), so they’re burned in.'],
  },
  computer: { drops: ['A computer going to sleep ends the stream; a cable is steadier than Wi-Fi.'] },
};

/** Silo's reasons for converting a stream, grouped into what can be done about them. */
const REASON_TOPIC: Record<string, TipTopic> = {
  video_codec_unsupported: 'video',
  video_capability_unconfirmed: 'video',
  resolution_limit: 'video',
  dynamic_range_unsupported: 'hdr',
  audio_codec_unsupported: 'audio',
  audio_channels_unsupported: 'audio',
  subtitle_burn_in: 'subtitles',
  subtitle_unsupported: 'subtitles',
  bandwidth_limit: 'quality',
  bandwidth_cap: 'quality',
  quality_selected: 'quality',
  buffering: 'quality',
};

/** Tips for this device on this topic (for transcoding, pass Silo's reasons, most common first). */
export function deviceTips(device: DeviceInfo, topic: 'drops' | 'slowStarts' | 'transcoding', reasons: string[] = []): string[] {
  const tips = TIPS[device.kind];
  if (topic !== 'transcoding') return tips[topic] ?? (topic === 'slowStarts' ? (tips.drops ?? []).slice(0, 2) : []);
  const out: string[] = [];
  for (const r of reasons) {
    const t = REASON_TOPIC[r];
    for (const tip of (t && tips[t]) || []) if (!out.includes(tip)) out.push(tip);
  }
  return out.slice(0, 3);
}

/** The official app exists here, so suggesting it makes sense. */
const HAS_SILO_APP = new Set<DeviceKind>([
  'fire-tv-4k',
  'fire-tv-hd',
  'fire-tv-cube',
  'fire-tv',
  'shield',
  'chromecast-4k',
  'chromecast-hd',
  'google-tv-streamer',
  'onn',
  'android-tv-set',
  'android-tv-box',
  'apple-tv',
  'iphone',
  'android-phone',
]);

/** A third-party app (not one of Silo's own)? Then trying Silo's own app is a fair suggestion. */
export function thirdPartyNote(device: DeviceInfo, client: string | null): string | null {
  if (!client || /^silo\b/i.test(client.trim())) return null;
  if (!HAS_SILO_APP.has(device.kind)) return null;
  return `They use ${client}, a third-party app. If the trouble is mostly in it, Silo’s own app is worth trying on the ${device.name}.`;
}
