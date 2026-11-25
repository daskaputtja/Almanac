/** Almanac's black and red, the same as the website. */
export const colors = {
  canvas: '#0a0a0a',
  panel: '#121212',
  raised: '#1b1b1b',
  line: '#262626',
  ink: '#ededed',
  muted: '#a3a3a3',
  faint: '#737373',
  accent: '#ef4444',
  accentDim: '#7f1d1d',
  critical: '#d03b3b',
  serious: '#ec835a',
  warning: '#fab219',
  good: '#0ca30c',
};

/** Playback method colours, as on the website. */
export const methodColors: Record<string, string> = {
  direct: '#3987e5',
  direct_stream: '#199e70',
  remux: '#9085e9',
  transcode: '#d95926',
};

export const methodLabels: Record<string, string> = {
  direct: 'Direct Play',
  direct_stream: 'Direct Stream',
  remux: 'Remux',
  transcode: 'Transcode',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 6, md: 10, lg: 14 };
