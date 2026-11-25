import type { SiloCatalogItem, SiloCatalogVersion } from '../silo/types.js';
import type { EpisodeMeta, MovieMeta, ShowMeta } from './metadata.js';

/** Almanac's accent red. */
const COLOUR = 0xef4444;
const MAX_DESCRIPTION = 4096;
const MAX_EPISODE_LINES = 15;

export interface DiscordEmbed {
  author?: { name: string };
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** The webhook is gone or wrong: stop using it until someone fixes it. */
    readonly permanent = false,
  ) {
    super(message);
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Post one message, waiting out Discord's rate limit once if it asks. */
export async function postToDiscord(
  webhookUrl: string,
  embeds: DiscordEmbed[],
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const url = new URL(webhookUrl);
  url.searchParams.set('wait', 'true');
  // Titles come from file names and metadata: never let them ping anyone.
  const body = JSON.stringify({ embeds, allowed_mentions: { parse: [] } });
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Almanac (https://github.com/daskaputtja/Almanac)' },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new DiscordError(`Couldn’t reach Discord: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    if (res.ok) return;
    if (res.status === 429 && attempt === 0) {
      const info = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const wait = Math.min(60_000, Math.max(500, (Number(info.retry_after) || Number(res.headers.get('retry-after')) || 2) * 1000));
      await sleep(wait);
      continue;
    }
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new DiscordError('Discord says this webhook doesn’t exist any more. It may have been deleted; paste a new one.', res.status, true);
    }
    throw new DiscordError(`Discord answered ${res.status}${detail?.message ? `: ${detail.message}` : ''}`, res.status);
  }
  throw new DiscordError('Discord kept asking Almanac to slow down. It will try again shortly.', 429);
}

/**
 * Post a message, or edit one this webhook posted before. Returns the message's
 * ID. If the old message was deleted, a new one is posted.
 */
export async function upsertWebhookMessage(
  webhookUrl: string,
  messageId: string | null,
  embeds: DiscordEmbed[],
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const base = new URL(webhookUrl);
  const body = JSON.stringify({ embeds, allowed_mentions: { parse: [] } });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Almanac (https://github.com/daskaputtja/Almanac)' };
  if (messageId) {
    const edit = new URL(base);
    edit.pathname = `${base.pathname.replace(/\/$/, '')}/messages/${messageId}`;
    let res: Response;
    try {
      res = await fetchImpl(edit.toString(), { method: 'PATCH', headers, body, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new DiscordError(`Couldn’t reach Discord: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    if (res.ok) return messageId;
    // 404 for the message means someone deleted it: post a new one below.
    const detail = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
    if (res.status !== 404 || detail?.code === 10015) {
      if (res.status === 401 || res.status === 403 || detail?.code === 10015) {
        throw new DiscordError('Discord says this webhook doesn’t exist any more. It may have been deleted; paste a new one.', res.status, true);
      }
      throw new DiscordError(`Discord answered ${res.status}${detail?.message ? `: ${detail.message}` : ''}`, res.status);
    }
  }
  const post = new URL(base);
  post.searchParams.set('wait', 'true');
  let res: Response;
  try {
    res = await fetchImpl(post.toString(), { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new DiscordError(`Couldn’t reach Discord: ${err instanceof Error ? err.message : String(err)}`, null);
  }
  const reply = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new DiscordError('Discord says this webhook doesn’t exist any more. It may have been deleted; paste a new one.', res.status, true);
  }
  if (!res.ok || !reply?.id) throw new DiscordError(`Discord answered ${res.status}${reply?.message ? `: ${reply.message}` : ''}`, res.status);
  return reply.id;
}

// --- Messages ------------------------------------------------------------------

/** One new movie. */
export function movieEmbed(item: SiloCatalogItem, libraryId: string, libraryName: string, meta: MovieMeta | null, test = false): DiscordEmbed {
  const year = meta?.year ?? item.year ?? null;
  const title = meta?.title ?? item.title;
  const genres = meta?.genres.length ? meta.genres : (item.genres ?? []);
  const rating = meta?.rating ?? item.rating_tmdb ?? item.rating_imdb ?? null;
  const fields: DiscordEmbed['fields'] = [];
  if (rating) fields.push({ name: 'Rating', value: `★ ${rating.toFixed(1)}`, inline: true });
  if (meta?.runtimeMinutes) fields.push({ name: 'Runtime', value: runtime(meta.runtimeMinutes), inline: true });
  if (item.content_rating) fields.push({ name: 'Rated', value: item.content_rating, inline: true });
  if (genres.length) fields.push({ name: 'Genres', value: genres.slice(0, 4).join(', '), inline: true });
  const quality = qualityLine(versionsIn(item, libraryId));
  if (quality) fields.push({ name: 'Quality', value: quality, inline: false });
  const links = linkLine([
    meta ? ['TMDB', meta.link] : item.tmdb_id ? ['TMDB', `https://www.themoviedb.org/movie/${item.tmdb_id}`] : null,
    (meta?.imdbId ?? item.imdb_id) ? ['IMDb', `https://www.imdb.com/title/${meta?.imdbId ?? item.imdb_id}/`] : null,
  ]);
  if (links) fields.push({ name: 'Links', value: links, inline: false });

  const description = [meta?.tagline ? `*${escape(meta.tagline)}*` : null, meta?.overview ? clip(escape(meta.overview), 600) : null]
    .filter(Boolean)
    .join('\n\n');
  return finish({
    author: { name: `New in ${libraryName}` },
    title: clip(`${title}${year ? ` (${year})` : ''}`, 256),
    url: meta?.link ?? (item.tmdb_id ? `https://www.themoviedb.org/movie/${item.tmdb_id}` : undefined),
    description: description || undefined,
    color: COLOUR,
    fields,
    thumbnail: poster(meta?.posterUrl ?? item.poster_url),
    footer: { text: test ? 'Almanac · test message' : 'Almanac' },
    timestamp: item.added_at,
  });
}

/** New episodes of one show, grouped into one message. */
export function episodesEmbed(
  series: SiloCatalogItem | null,
  episodes: SiloCatalogItem[],
  libraryId: string,
  libraryName: string,
  show: ShowMeta | null,
  episodeMeta: Map<string, EpisodeMeta>,
  test = false,
): DiscordEmbed {
  const sorted = [...episodes].sort((a, b) => (a.season_number ?? 0) - (b.season_number ?? 0) || (a.episode_number ?? 0) - (b.episode_number ?? 0));
  const first = sorted[0]!;
  const showTitle = show?.title ?? series?.title ?? first.series_title ?? 'Unknown show';
  const isNewShow = sorted.some((e) => e.season_number === 1 && e.episode_number === 1);
  const metaFor = (e: SiloCatalogItem) => episodeMeta.get(`${e.season_number}:${e.episode_number}`);
  const nameOf = (e: SiloCatalogItem) => metaFor(e)?.name ?? (isPlaceholderTitle(e.title) ? null : e.title);
  const fields: DiscordEmbed['fields'] = [];
  let title: string;
  let description: string;
  let image: DiscordEmbed['image'];

  if (sorted.length === 1) {
    const meta = metaFor(first);
    const name = nameOf(first);
    title = `${showTitle} · ${episodeCode(first)}`;
    description = [name ? `**${escape(name)}**` : null, meta?.overview ? clip(escape(meta.overview), 500) : null].filter(Boolean).join('\n');
    const aired = meta?.aired ?? first.air_date;
    if (aired) fields.push({ name: 'Aired', value: formatDate(aired), inline: true });
    if (meta?.imageUrl) image = { url: absoluteTvdb(meta.imageUrl) };
  } else {
    const seasons = [...new Set(sorted.map((e) => e.season_number))];
    title = showTitle;
    const heading = `**${sorted.length} new episodes**${seasons.length === 1 && seasons[0] != null ? ` · Season ${seasons[0]}` : ''}`;
    const lines = sorted.slice(0, MAX_EPISODE_LINES).map((e) => {
      const name = nameOf(e);
      return `${episodeCode(e)}${name ? ` · ${escape(name)}` : ''}`;
    });
    if (sorted.length > MAX_EPISODE_LINES) lines.push(`…and ${sorted.length - MAX_EPISODE_LINES} more`);
    description = [heading, lines.join('\n')].join('\n');
    if (isNewShow && show?.overview) description = `${clip(escape(show.overview), 400)}\n\n${description}`;
  }

  const genres = series?.genres ?? [];
  if (genres.length) fields.push({ name: 'Genres', value: genres.slice(0, 4).join(', '), inline: true });
  if (show?.network) fields.push({ name: 'Network', value: show.network, inline: true });
  const quality = qualityLine(versionsIn(first, libraryId));
  if (quality) fields.push({ name: 'Quality', value: quality, inline: false });
  const link = show?.link ?? (series?.tvdb_id ? `https://www.thetvdb.com/dereferrer/series/${series.tvdb_id}` : null);
  const links = linkLine([
    link ? [show?.source ?? 'TVDB', link] : null,
    series?.imdb_id ? ['IMDb', `https://www.imdb.com/title/${series.imdb_id}/`] : null,
  ]);
  if (links) fields.push({ name: 'Links', value: links, inline: false });

  return finish({
    author: { name: `${isNewShow ? 'New show' : 'New episodes'} in ${libraryName}` },
    title: clip(title, 256),
    url: link ?? undefined,
    description: description || undefined,
    color: COLOUR,
    fields,
    thumbnail: poster(show?.posterUrl ? absoluteTvdb(show.posterUrl) : (series?.poster_url ?? first.poster_url)),
    image,
    footer: { text: test ? 'Almanac · test message' : 'Almanac' },
    timestamp: sorted[sorted.length - 1]!.added_at,
  });
}

/** When a lot arrives at once (a big import), one message listing it instead of dozens. */
export function summaryEmbed(lines: string[], libraryNames: string[], kinds: { movies: number; shows: number }): DiscordEmbed {
  const shown = lines.slice(0, 30).map((l) => `• ${escape(l)}`);
  if (lines.length > 30) shown.push(`…and ${lines.length - 30} more`);
  return finish({
    author: { name: `New in ${libraryNames.join(', ')}` },
    title: !kinds.shows
      ? `${kinds.movies} new ${kinds.movies === 1 ? 'movie' : 'movies'}`
      : !kinds.movies
        ? `New episodes of ${kinds.shows} shows`
        : `${kinds.movies} new movies and new episodes of ${kinds.shows} shows`,
    description: shown.join('\n'),
    color: COLOUR,
    footer: { text: 'Almanac' },
    timestamp: new Date().toISOString(),
  });
}

// --- Helpers -------------------------------------------------------------------

/** The files of an item that are in one library (Silo lists every library's copies). */
export function versionsIn(item: SiloCatalogItem, libraryId: string): SiloCatalogVersion[] {
  const all = item.versions ?? [];
  const here = all.filter((v) => v.library_id === libraryId);
  return here.length ? here : all.filter((v) => !v.library_id);
}

const RESOLUTION_RANK: Record<string, number> = { '4320p': 5, '2160p': 4, '1440p': 3, '1080p': 2, '720p': 1 };

export function bestVersion(versions: SiloCatalogVersion[]): SiloCatalogVersion | undefined {
  return [...versions].sort((a, b) => (RESOLUTION_RANK[b.resolution ?? ''] ?? 0) - (RESOLUTION_RANK[a.resolution ?? ''] ?? 0))[0];
}

/** "IMAX · 4K · Dolby Vision": the picture only, not the sound. */
export function qualityLine(versions: SiloCatalogVersion[]): string | null {
  const v = bestVersion(versions);
  if (!v) return null;
  const parts = [
    v.edition ?? null,
    resolutionLabel(v.resolution),
    DYNAMIC_RANGE[(v.dynamic_range ?? '').toLowerCase()] ?? null,
  ].filter(Boolean);
  if (versions.length > 1) parts.push(`${versions.length} versions`);
  return parts.length ? parts.join(' · ') : null;
}

const DYNAMIC_RANGE: Record<string, string> = {
  dolby_vision: 'Dolby Vision',
  hdr10_plus: 'HDR10+',
  hdr10: 'HDR10',
  hdr: 'HDR',
  hlg: 'HLG',
};

function resolutionLabel(resolution?: string): string | null {
  if (!resolution) return null;
  if (resolution === '2160p') return '4K';
  if (resolution === '4320p') return '8K';
  return resolution;
}

export function episodeCode(e: SiloCatalogItem): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  if (e.season_number == null || e.episode_number == null) return e.title;
  return `S${pad(e.season_number)}E${pad(e.episode_number)}`;
}

function isPlaceholderTitle(title: string): boolean {
  return /^episode\s*\d+$/i.test(title.trim());
}

function runtime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

function formatDate(date: string): string {
  const d = new Date(date.length === 10 ? `${date}T12:00:00Z` : date);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function linkLine(links: ([string, string] | null)[]): string | null {
  const parts = links.filter((l): l is [string, string] => Boolean(l)).map(([label, url]) => `[${label}](${url})`);
  return parts.length ? parts.join(' · ') : null;
}

function poster(url?: string | null): DiscordEmbed['thumbnail'] {
  return url && /^https:\/\//.test(url) ? { url } : undefined;
}

function absoluteTvdb(url: string): string {
  return url.startsWith('/') ? `https://artworks.thetvdb.com${url}` : url;
}

/** Stop titles and summaries from being read as Discord formatting or links. */
function escape(text: string): string {
  return text
    .replace(/([\\*_~`|[\]])/g, '\\$1')
    .replace(/^([>#-])/gm, '\\$1')
    .replace(/@/g, '@\u200b');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function finish(embed: DiscordEmbed): DiscordEmbed {
  if (embed.description) embed.description = clip(embed.description, MAX_DESCRIPTION);
  if (embed.fields && !embed.fields.length) delete embed.fields;
  return embed;
}
