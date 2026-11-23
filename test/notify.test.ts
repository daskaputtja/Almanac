import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { qualityLine } from '../server/notify/discord.js';
import { MetadataService } from '../server/notify/metadata.js';
import { FLOOD_LIMIT, GROUP_QUIET_MS, MATCH_WAIT_MS, Notifier, matchesQuality } from '../server/notify/notifier.js';
import type { CatalogPageQuery, SiloCatalogItem } from '../server/silo/types.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123';
const T0 = Date.parse('2026-11-23T12:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** A Silo that answers catalog queries the way the real one does. */
class FakeSilo {
  items: (SiloCatalogItem & { firstSeen?: Record<string, string> })[] = [];
  async listCatalogPage(q: CatalogPageQuery) {
    const items = this.items
      .filter((i) => !q.type || i.type === q.type)
      .filter((i) => !q.libraryId || (i.library_ids ?? []).includes(q.libraryId))
      .filter((i) => !q.contentIds || q.contentIds.includes(i.content_id))
      // With a library filter, added_at is when the item first appeared in that library.
      .map((i) => ({ ...i, added_at: (q.libraryId && i.firstSeen?.[q.libraryId]) || i.added_at }))
      .filter((i) => !q.addedAfter || i.added_at >= q.addedAfter);
    return { items, page: { has_more: false } };
  }
}

/** Fake TMDB, TVDB and Discord. Discord posts are recorded. */
function fakeNet() {
  const posts: { url: string; body: { embeds: Record<string, unknown>[]; allowed_mentions: unknown } }[] = [];
  const net = {
    posts,
    discordStatus: 204 as number,
    tvdbLogins: 0,
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (u.host === 'discord.com') {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        if (net.discordStatus === 204) return json({ id: '1' });
        return json({ message: 'Unknown Webhook' }, net.discordStatus);
      }
      if (u.host === 'api.themoviedb.org') {
        if (u.pathname === '/3/movie/550') {
          return json({ title: 'Fight Club', release_date: '1999-10-15', overview: 'An insomniac office worker…', tagline: 'Mischief. Mayhem. Soap.', poster_path: '/fc.jpg', runtime: 139, genres: [{ name: 'Drama' }], vote_average: 8.4, vote_count: 30000, imdb_id: 'tt0137523' });
        }
        if (u.pathname === '/3/configuration') return json({});
        return json({}, 404);
      }
      if (u.host === 'api4.thetvdb.com') {
        if (u.pathname === '/v4/login') {
          net.tvdbLogins++;
          return JSON.parse(String(init?.body)).apikey === 'good-tvdb' ? json({ data: { token: 'tok' } }) : json({}, 401);
        }
        if (u.pathname === '/v4/series/81189') {
          return json({ data: { name: 'Breaking Bad', slug: 'breaking-bad', image: 'https://artworks.thetvdb.com/bb.jpg', overview: 'A chemistry teacher…', originalLanguage: 'eng' } });
        }
        if (u.pathname === '/v4/series/81189/episodes/default') {
          return json({ data: { episodes: [1, 2, 3].map((n) => ({ seasonNumber: 2, number: n, name: `Episode name ${n}`, overview: `Overview ${n}`, aired: '2009-03-08' })) } });
        }
      }
      return json({}, 404);
    },
  };
  return net;
}

function setup() {
  const db = openDatabase(':memory:');
  const insert = db.prepare('INSERT INTO libraries (id, name, type, sort_order, synced_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('1', 'Movies', 'movies', 0, at(0));
  insert.run('6', 'Movies - 4K', 'movies', 1, at(0));
  insert.run('2', 'TV Shows', 'series', 2, at(0));
  const silo = new FakeSilo();
  const net = fakeNet();
  const metadata = new MetadataService(db, net.fetch, () => {});
  const notifier = new Notifier(db, silo, metadata, { fetchImpl: net.fetch, log: () => {}, sleep: async () => {}, gapMs: 0 });
  return { db, silo, net, metadata, notifier };
}

const movie = (id: string, extra: Partial<SiloCatalogItem> = {}): SiloCatalogItem => ({
  content_id: id,
  type: 'movie',
  title: `Movie ${id}`,
  year: 2024,
  status: 'matched',
  library_ids: ['1'],
  added_at: at(1),
  versions: [{ library_id: '1', resolution: '1080p', dynamic_range: 'sdr', codec_audio: 'eac3', audio_channels: 6 }],
  ...extra,
});

const episode = (n: number, extra: Partial<SiloCatalogItem> = {}): SiloCatalogItem => ({
  content_id: `bb-s2e${n}`,
  type: 'episode',
  title: `Episode ${n}`,
  series_id: 'bb',
  series_title: 'Breaking Bad',
  season_number: 2,
  episode_number: n,
  library_ids: ['2'],
  added_at: at(1),
  versions: [{ library_id: '2', resolution: '1080p' }],
  ...extra,
});

describe('Discord notifications', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  const addChannel = (libraryIds: string[], quality: 'any' | 'dolby_vision' = 'any') => {
    const channel = env.notifier.create({ name: '#movies', webhookUrl: WEBHOOK, libraryIds, quality }, 'admin');
    // Pretend it was set up before the test's items arrived.
    env.db.prepare('UPDATE notify_channels SET active_since = ? WHERE id = ?').run(at(-60), channel.id);
    return channel;
  };

  it('posts a new movie with TMDB details, and never pings anyone', async () => {
    await env.metadata.setKeys({ tmdb: 'short-v3-key' }, 'admin');
    addChannel(['1']);
    env.silo.items.push(movie('m1', { tmdb_id: '550', imdb_id: 'tt0137523', title: '@everyone Fight Club' }));
    await env.notifier.runOnce(T0 + 2 * 60_000);

    expect(env.net.posts).toHaveLength(1);
    const { body } = env.net.posts[0]!;
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const embed = body.embeds[0]!;
    expect(embed).toMatchObject({
      author: { name: 'New in Movies' },
      title: 'Fight Club (1999)',
      url: 'https://www.themoviedb.org/movie/550',
      thumbnail: { url: 'https://image.tmdb.org/t/p/w500/fc.jpg' },
    });
    expect(embed.description).toContain('Mischief. Mayhem. Soap.');
    expect(JSON.stringify(embed.fields)).toContain('2h 19m');
    expect(JSON.stringify(embed.fields)).toContain('1080p · DD+ 5.1');
    expect(JSON.stringify(embed.fields)).toContain('[IMDb](https://www.imdb.com/title/tt0137523/)');

    // Already posted: not again.
    await env.notifier.runOnce(T0 + 4 * 60_000);
    expect(env.net.posts).toHaveLength(1);
  });

  it('only posts items added after the channel was set up', async () => {
    const channel = env.notifier.create({ name: '#movies', webhookUrl: WEBHOOK, libraryIds: ['1'] }, 'admin');
    const createdAt = Date.parse(env.notifier.channels().find((c) => c.id === channel.id)!.createdAt);
    env.silo.items.push(movie('old', { added_at: new Date(createdAt - 60_000).toISOString() }));
    env.silo.items.push(movie('new', { added_at: new Date(createdAt + 60_000).toISOString() }));
    await env.notifier.runOnce(createdAt + 3 * 60_000);
    expect(env.net.posts.map((p) => p.body.embeds[0]!.title)).toEqual(['Movie new (2024)']);
  });

  it('counts a 4K copy of an old movie as new in the 4K library, filtered by Dolby Vision', async () => {
    addChannel(['6'], 'dolby_vision');
    env.silo.items.push(
      movie('old-dv', {
        added_at: at(-10_000), // in Movies for ages
        firstSeen: { '6': at(1) }, // but only just added to the 4K library
        library_ids: ['1', '6'],
        versions: [
          { library_id: '1', resolution: '1080p', dynamic_range: 'sdr' },
          { library_id: '6', resolution: '2160p', dynamic_range: 'dolby_vision', codec_audio: 'truehd', atmos: true, audio_channels: 8, edition: 'IMAX' },
        ],
      } as Partial<SiloCatalogItem>),
      movie('hdr10', { library_ids: ['6'], versions: [{ library_id: '6', resolution: '2160p', dynamic_range: 'hdr10' }] }),
    );
    await env.notifier.runOnce(T0 + 2 * 60_000);
    expect(env.net.posts).toHaveLength(1);
    const embed = env.net.posts[0]!.body.embeds[0]!;
    expect(embed.author).toEqual({ name: 'New in Movies - 4K' });
    expect(JSON.stringify(embed.fields)).toContain('IMAX · 4K · Dolby Vision · TrueHD Atmos 7.1');
  });

  it('waits for Silo to match a new movie, but not forever', async () => {
    addChannel(['1']);
    env.silo.items.push(movie('raw', { status: 'unmatched', title: 'raw.file.2024.1080p' }));
    await env.notifier.runOnce(T0 + 2 * 60_000);
    expect(env.net.posts).toHaveLength(0);

    // Matched on the next check: posted with the new title.
    env.silo.items[0] = { ...env.silo.items[0]!, status: 'matched', tmdb_id: '999', title: 'Proper Title' };
    await env.notifier.runOnce(T0 + 4 * 60_000);
    expect(env.net.posts.map((p) => p.body.embeds[0]!.title)).toEqual(['Proper Title (2024)']);

    env.silo.items.push(movie('never', { status: 'unmatched', title: 'Never Matched', added_at: at(5) }));
    await env.notifier.runOnce(T0 + 6 * 60_000);
    expect(env.net.posts).toHaveLength(1);
    await env.notifier.runOnce(T0 + 6 * 60_000 + MATCH_WAIT_MS + 60_000);
    expect(env.net.posts.map((p) => p.body.embeds[0]!.title)).toEqual(['Proper Title (2024)', 'Never Matched (2024)']);
  });

  it('groups a show’s new episodes into one post once they stop arriving, with TVDB names', async () => {
    await env.metadata.setKeys({ tvdb: 'good-tvdb' }, 'admin');
    addChannel(['2']);
    env.silo.items.push({ content_id: 'bb', type: 'series', title: 'Breaking Bad', tvdb_id: '81189', genres: ['Drama'], library_ids: ['2'], added_at: at(-9999), versions: [] });
    env.silo.items.push(episode(1), episode(2));
    await env.notifier.runOnce(T0 + 2 * 60_000);
    expect(env.net.posts).toHaveLength(0); // still arriving

    env.silo.items.push(episode(3, { added_at: at(3) }));
    await env.notifier.runOnce(T0 + 4 * 60_000);
    expect(env.net.posts).toHaveLength(0);

    await env.notifier.runOnce(T0 + 4 * 60_000 + GROUP_QUIET_MS + 1000);
    expect(env.net.posts).toHaveLength(1);
    const embed = env.net.posts[0]!.body.embeds[0]!;
    expect(embed).toMatchObject({
      author: { name: 'New episodes in TV Shows' },
      title: 'Breaking Bad',
      url: 'https://www.thetvdb.com/series/breaking-bad',
      thumbnail: { url: 'https://artworks.thetvdb.com/bb.jpg' },
    });
    expect(embed.description).toContain('**3 new episodes** · Season 2');
    expect(embed.description).toContain('S02E02 · Episode name 2');
    expect(env.net.tvdbLogins).toBe(1);
  });

  it('sends one summary instead of flooding the channel', async () => {
    addChannel(['1']);
    for (let i = 0; i < FLOOD_LIMIT + 5; i++) env.silo.items.push(movie(`bulk${i}`));
    await env.notifier.runOnce(T0 + 2 * 60_000);
    expect(env.net.posts).toHaveLength(1);
    expect(env.net.posts[0]!.body.embeds[0]!.title).toBe(`${FLOOD_LIMIT + 5} new movies`);
    expect(env.notifier.overview().log.every((e) => e.status === 'sent')).toBe(true);
  });

  it('turns a channel off when Discord says the webhook is gone', async () => {
    addChannel(['1']);
    env.net.discordStatus = 404;
    env.silo.items.push(movie('a'), movie('b'));
    await env.notifier.runOnce(T0 + 2 * 60_000);
    expect(env.net.posts).toHaveLength(1); // stopped after the first failure
    const [channel] = env.notifier.channels();
    expect(channel!.enabled).toBe(false);
    expect(channel!.lastError).toMatch(/doesn’t exist any more/);
  });

  it('keeps trying through a Discord outage, then gives up on an item', async () => {
    addChannel(['1']);
    env.net.discordStatus = 502;
    env.silo.items.push(movie('a'));
    for (let i = 1; i <= 3; i++) await env.notifier.runOnce(T0 + i * 2 * 60_000);
    expect(env.net.posts).toHaveLength(3);
    expect(env.notifier.overview().log[0]!.status).toBe('failed');
    expect(env.notifier.channels()[0]!.enabled).toBe(true);
  });

  it('rejects keys the services don’t accept, and stores ones they do', async () => {
    await expect(env.metadata.setKeys({ tvdb: 'bad' }, 'admin')).rejects.toThrow(/didn’t accept/);
    expect(env.metadata.status()).toEqual({ tmdb: false, tvdb: false, tvdbPin: false });
    await env.metadata.setKeys({ tvdb: 'good-tvdb' }, 'admin');
    expect(env.metadata.status().tvdb).toBe(true);
    await env.metadata.setKeys({ tvdb: '' }, 'admin');
    expect(env.metadata.status().tvdb).toBe(false);
  });
});

describe('quality', () => {
  it('describes the best copy in the library', () => {
    expect(qualityLine([{ resolution: '2160p', dynamic_range: 'hdr10_plus', codec_audio: 'eac3', atmos: true, audio_channels: 6 }])).toBe('4K · HDR10+ · DD+ Atmos 5.1');
    expect(qualityLine([])).toBeNull();
  });

  it('filters by the copy in the watched library only', () => {
    const item = movie('x', {
      library_ids: ['1', '6'],
      versions: [
        { library_id: '1', resolution: '1080p', dynamic_range: 'dolby_vision' },
        { library_id: '6', resolution: '2160p', dynamic_range: 'sdr' },
      ],
    });
    expect(matchesQuality(item, '6', 'dolby_vision')).toBe(false);
    expect(matchesQuality(item, '6', '4k')).toBe(true);
    expect(matchesQuality(item, '1', 'hdr')).toBe(true);
  });
});
