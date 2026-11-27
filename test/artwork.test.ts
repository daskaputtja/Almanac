import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { ArtworkService } from '../server/library/artwork.js';
import type { CatalogSource } from '../server/silo/client.js';

function setup(opts: { busy?: boolean } = {}) {
  const db = openDatabase(':memory:');
  const insert = db.prepare("INSERT INTO catalog_items (content_id, type, title, poster_url, library_ids, added_at, synced_at) VALUES (?, ?, ?, ?, '[]', '2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z')");
  insert.run('s1', 'series', 'Yellowjackets', '/api/artwork/item-posters/s1?exp=1&sig=old');
  insert.run('e1', 'episode', 'Episode 1', '/api/artwork/item-posters/s1?exp=1&sig=old');
  const calls: string[] = [];
  let busy = opts.busy ?? false;
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (busy) return new Response('', { status: 429, headers: { 'Retry-After': '7' } });
    // Old signatures have expired; the fresh one works.
    if (url.includes('sig=old')) return new Response('Link invalid or expired', { status: 404 });
    return new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { 'Content-Type': 'image/webp' } });
  };
  const catalog = {
    listCatalogPage: async (q: { contentIds?: string[] }) => ({ items: q.contentIds?.[0] === 's1' ? [{ content_id: 's1', poster_url: '/api/artwork/item-posters/s1?exp=2&sig=fresh' }] : [] }),
  } as unknown as CatalogSource;
  const art = new ArtworkService(db, mkdtempSync(`${tmpdir()}/art-`), 'https://silo.example.com', catalog, fetchImpl as typeof fetch, () => {});
  return { db, art, calls, setBusy: (b: boolean) => (busy = b) };
}

describe('artwork', () => {
  it('gets a fresh link when a stored one has expired, and saves it for everything using it', async () => {
    const { db, art, calls } = setup();
    const r = await art.get('item-posters/s1', '?exp=1&sig=old');
    expect(r).toMatchObject({ status: 200, type: 'image/webp' });
    expect([...r.body!]).toEqual([9, 9, 9]);
    expect(calls).toEqual(['https://silo.example.com/api/v2/item-posters/s1?exp=1&sig=old', 'https://silo.example.com/api/v2/item-posters/s1?exp=2&sig=fresh']);
    const links = db.prepare('SELECT DISTINCT poster_url AS u FROM catalog_items').all() as { u: string }[];
    expect(links).toEqual([{ u: '/api/artwork/item-posters/s1?exp=2&sig=fresh' }]);
  });

  it('serves its copy afterwards without asking Silo, and answers “not modified”', async () => {
    const { art, calls } = setup();
    const first = await art.get('item-posters/s1', '?exp=2&sig=fresh');
    calls.length = 0;
    const again = await art.get('item-posters/s1', '?exp=1&sig=old');
    expect(again.status).toBe(200);
    expect(calls).toEqual([]);
    expect((await art.get('item-posters/s1', '', first.etag)).status).toBe(304);
  });

  it('says “busy, try again” when Silo is rate limiting, but serves an old copy if it has one', async () => {
    const { art, setBusy } = setup({ busy: true });
    expect(await art.get('item-posters/s2', '?exp=2&sig=fresh')).toMatchObject({ status: 503, retryAfter: 7 });
    setBusy(false);
    expect((await art.get('item-posters/s2', '?exp=2&sig=fresh')).status).toBe(200);
  });

  it('asks Silo once for many requests for the same poster at the same time', async () => {
    const { art, calls } = setup();
    const results = await Promise.all(Array.from({ length: 10 }, () => art.get('item-posters/s3', '?exp=2&sig=fresh')));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('refuses anything that isn’t Silo artwork', async () => {
    const { art, calls } = setup();
    for (const rest of ['admin/users', 'item-posters/../admin', 'artwork/a b']) expect((await art.get(rest, '')).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
