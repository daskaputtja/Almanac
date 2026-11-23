import type { MetadataKeyStatus } from '../../shared/notifications.js';
import type { Database } from '../db/database.js';

/** Details for a Discord post, from TMDB (movies) or TVDB (shows), with TMDB as the fallback for shows. */
export interface MovieMeta {
  title: string;
  year: number | null;
  overview: string | null;
  tagline: string | null;
  posterUrl: string | null;
  runtimeMinutes: number | null;
  genres: string[];
  rating: number | null;
  link: string;
  imdbId: string | null;
}

export interface ShowMeta {
  source: 'TVDB' | 'TMDB';
  title: string;
  overview: string | null;
  posterUrl: string | null;
  link: string;
  network: string | null;
}

export interface EpisodeMeta {
  season: number;
  number: number;
  name: string | null;
  overview: string | null;
  imageUrl: string | null;
  aired: string | null;
}

const KEYS = { tmdb: 'tmdb_api_key', tvdb: 'tvdb_api_key', tvdbPin: 'tvdb_pin' } as const;
const TMDB = 'https://api.themoviedb.org/3';
const TMDB_IMAGES = 'https://image.tmdb.org/t/p';
const TVDB = 'https://api4.thetvdb.com/v4';
const CACHE_MS = 6 * 3_600_000;
const TVDB_TOKEN_MS = 25 * 86_400_000; // tokens last a month

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class MetadataError extends Error {}

/**
 * Looks up posters, summaries and links for new titles. Keys are stored in
 * Almanac's database and never sent back to the browser. Every lookup is
 * optional: without keys (or if a service is down) posts use Silo's details.
 */
export class MetadataService {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private tvdbToken: { token: string; at: number } | null = null;

  constructor(
    private readonly db: Database,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: (message: string) => void = console.log,
  ) {}

  status(): MetadataKeyStatus {
    return { tmdb: Boolean(this.key('tmdb')), tvdb: Boolean(this.key('tvdb')), tvdbPin: Boolean(this.key('tvdbPin')) };
  }

  /** Check a key works, then store it. An empty value removes it. */
  async setKeys(input: { tmdb?: string | null; tvdb?: string | null; tvdbPin?: string | null }, by: string): Promise<MetadataKeyStatus> {
    const tmdb = input.tmdb === undefined ? undefined : (input.tmdb ?? '').trim();
    const tvdb = input.tvdb === undefined ? undefined : (input.tvdb ?? '').trim();
    const pin = input.tvdbPin === undefined ? undefined : (input.tvdbPin ?? '').trim();
    if (tmdb) await this.checkTmdb(tmdb);
    const token = tvdb ? await this.tvdbLogin(tvdb, pin ?? this.key('tvdbPin') ?? '') : null;
    if (tmdb !== undefined) this.store('tmdb', tmdb, by);
    if (pin !== undefined) this.store('tvdbPin', pin, by);
    if (tvdb !== undefined) {
      this.store('tvdb', tvdb, by);
      this.tvdbToken = token ? { token, at: Date.now() } : null;
    }
    this.cache.clear();
    return this.status();
  }

  async movie(tmdbId: string): Promise<MovieMeta | null> {
    const key = this.key('tmdb');
    if (!key || !/^\d+$/.test(tmdbId)) return null;
    return this.cached(`movie:${tmdbId}`, async () => {
      const m = await this.tmdbGet<TmdbMovie>(key, `/movie/${tmdbId}`);
      return {
        title: m.title,
        year: m.release_date ? Number(m.release_date.slice(0, 4)) || null : null,
        overview: m.overview || null,
        tagline: m.tagline || null,
        posterUrl: m.poster_path ? `${TMDB_IMAGES}/w500${m.poster_path}` : null,
        runtimeMinutes: m.runtime || null,
        genres: (m.genres ?? []).map((g) => g.name),
        rating: m.vote_count && m.vote_count >= 5 && m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
        link: `https://www.themoviedb.org/movie/${tmdbId}`,
        imdbId: m.imdb_id || null,
      };
    });
  }

  /** A show's details from TVDB, or from TMDB if there's no TVDB key or ID. */
  async show(ids: { tvdbId?: string; tmdbId?: string }): Promise<ShowMeta | null> {
    if (ids.tvdbId && this.key('tvdb') && /^\d+$/.test(ids.tvdbId)) {
      const id = ids.tvdbId;
      const show = await this.cached(`tvdb-show:${id}`, async () => {
        const s = (await this.tvdbGet<TvdbSeries>(`/series/${id}`)).data;
        let overview = s.overview ?? null;
        if (s.overviewTranslations?.includes('eng') && s.originalLanguage !== 'eng') {
          overview = (await this.tvdbGet<{ data: { overview?: string } }>(`/series/${id}/translations/eng`).catch(() => null))?.data.overview ?? overview;
        }
        return {
          source: 'TVDB' as const,
          title: s.name,
          overview: overview || null,
          posterUrl: s.image || null,
          link: s.slug ? `https://www.thetvdb.com/series/${s.slug}` : `https://www.thetvdb.com/dereferrer/series/${id}`,
          network: null,
        };
      });
      if (show) return show;
    }
    const key = this.key('tmdb');
    if (ids.tmdbId && key && /^\d+$/.test(ids.tmdbId)) {
      const id = ids.tmdbId;
      return this.cached(`tmdb-show:${id}`, async () => {
        const s = await this.tmdbGet<TmdbShow>(key, `/tv/${id}`);
        return {
          source: 'TMDB' as const,
          title: s.name,
          overview: s.overview || null,
          posterUrl: s.poster_path ? `${TMDB_IMAGES}/w500${s.poster_path}` : null,
          link: `https://www.themoviedb.org/tv/${id}`,
          network: s.networks?.[0]?.name ?? null,
        };
      });
    }
    return null;
  }

  /** Every episode of one season, by episode number. */
  async season(show: ShowMeta, ids: { tvdbId?: string; tmdbId?: string }, season: number): Promise<Map<number, EpisodeMeta>> {
    const empty = new Map<number, EpisodeMeta>();
    if (show.source === 'TVDB' && ids.tvdbId) {
      const id = ids.tvdbId;
      const list = await this.cached(`tvdb-season:${id}:${season}`, async () => {
        const res = await this.tvdbGet<TvdbEpisodes>(`/series/${id}/episodes/default?season=${season}&page=0`);
        return (res.data.episodes ?? []).map(
          (e): EpisodeMeta => ({
            season: e.seasonNumber ?? season,
            number: e.number ?? 0,
            name: e.name || null,
            overview: e.overview || null,
            imageUrl: e.image || null,
            aired: e.aired || null,
          }),
        );
      });
      return list ? new Map(list.filter((e) => e.season === season).map((e) => [e.number, e])) : empty;
    }
    const key = this.key('tmdb');
    if (show.source === 'TMDB' && ids.tmdbId && key) {
      const id = ids.tmdbId;
      const list = await this.cached(`tmdb-season:${id}:${season}`, async () => {
        const res = await this.tmdbGet<TmdbSeason>(key, `/tv/${id}/season/${season}`);
        return (res.episodes ?? []).map(
          (e): EpisodeMeta => ({
            season,
            number: e.episode_number,
            name: e.name || null,
            overview: e.overview || null,
            imageUrl: e.still_path ? `${TMDB_IMAGES}/w780${e.still_path}` : null,
            aired: e.air_date || null,
          }),
        );
      });
      return list ? new Map(list.map((e) => [e.number, e])) : empty;
    }
    return empty;
  }

  // --- Internals -------------------------------------------------------------

  private key(name: keyof typeof KEYS): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEYS[name]) as { value: string } | undefined;
    return row?.value || null;
  }

  private store(name: keyof typeof KEYS, value: string, by: string): void {
    if (!value) {
      this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(KEYS[name]);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(KEYS[name], value, by, new Date().toISOString());
  }

  /** Remember results (including "not found") for a few hours; lookup failures give null and aren't remembered. */
  private async cached<T>(key: string, load: () => Promise<T>): Promise<T | null> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T | null;
    try {
      const value = await load();
      this.cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      if (err instanceof NotFound) {
        this.cache.set(key, { at: Date.now(), value: null });
      } else {
        this.log(`Metadata lookup failed (${key}): ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }

  private async checkTmdb(key: string): Promise<void> {
    try {
      await this.tmdbGet(key, '/configuration');
    } catch (err) {
      throw new MetadataError(
        err instanceof HttpError && err.status === 401
          ? 'TMDB didn’t accept that key. Use the API key or the API read access token from TMDB’s API settings.'
          : `Couldn’t check the key with TMDB: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async tmdbGet<T>(key: string, path: string): Promise<T> {
    const url = new URL(TMDB + path);
    url.searchParams.set('language', 'en-US');
    const headers: Record<string, string> = { Accept: 'application/json' };
    // The longer "read access token" goes in a header; the short v3 API key in the address.
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
    else url.searchParams.set('api_key', key);
    return this.getJson<T>(url.toString(), headers);
  }

  private async tvdbLogin(apikey: string, pin: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${TVDB}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(pin ? { apikey, pin } : { apikey }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new MetadataError(`Couldn’t reach TVDB: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 401) throw new MetadataError('TVDB didn’t accept that key (or the subscriber PIN, if your key needs one).');
    if (!res.ok) throw new MetadataError(`TVDB answered ${res.status} when signing in.`);
    const token = ((await res.json()) as { data?: { token?: string } }).data?.token;
    if (!token) throw new MetadataError('TVDB signed in but sent no token.');
    return token;
  }

  private async tvdbGet<T>(path: string, retried = false): Promise<T> {
    const key = this.key('tvdb');
    if (!key) throw new Error('No TVDB key');
    if (!this.tvdbToken || Date.now() - this.tvdbToken.at > TVDB_TOKEN_MS) {
      this.tvdbToken = { token: await this.tvdbLogin(key, this.key('tvdbPin') ?? ''), at: Date.now() };
    }
    try {
      return await this.getJson<T>(TVDB + path, { Authorization: `Bearer ${this.tvdbToken.token}`, Accept: 'application/json' });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401 && !retried) {
        this.tvdbToken = null;
        return this.tvdbGet<T>(path, true);
      }
      throw err;
    }
  }

  private async getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
    const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) throw new NotFound();
    if (!res.ok) throw new HttpError(res.status, `${new URL(url).host} answered ${res.status}`);
    return (await res.json()) as T;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
class NotFound extends Error {}

interface TmdbMovie {
  title: string;
  release_date?: string;
  overview?: string;
  tagline?: string;
  poster_path?: string | null;
  runtime?: number;
  genres?: { name: string }[];
  vote_average?: number;
  vote_count?: number;
  imdb_id?: string | null;
}
interface TmdbShow {
  name: string;
  overview?: string;
  poster_path?: string | null;
  networks?: { name: string }[];
}
interface TmdbSeason {
  episodes?: { episode_number: number; name?: string; overview?: string; still_path?: string | null; air_date?: string }[];
}
interface TvdbSeries {
  data: {
    name: string;
    slug?: string;
    image?: string | null;
    overview?: string | null;
    originalLanguage?: string;
    overviewTranslations?: string[];
  };
}
interface TvdbEpisodes {
  data: {
    episodes?: { seasonNumber?: number; number?: number; name?: string | null; overview?: string | null; image?: string | null; aired?: string | null }[];
  };
}
