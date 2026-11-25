import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { LibraryService } from '../server/library/library.js';
import { CatalogSync } from '../server/library/sync.js';
import { LibraryBoard } from '../server/notify/board.js';
import { MockCatalogSource } from '../server/silo/mock.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123';

function setup() {
  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  const lib = db.prepare('INSERT INTO libraries (id, name, type, sort_order, synced_at) VALUES (?, ?, ?, ?, ?)');
  lib.run('1', 'Movies', 'movies', 0, now);
  lib.run('6', 'Movies - 4K', 'movies', 1, now);
  lib.run('13', 'Movies - Cams', 'movies', 2, now);
  lib.run('2', 'TV Shows', 'series', 3, now);
  const item = db.prepare(
    'INSERT INTO catalog_items (content_id, type, title, library_ids, added_at, synced_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  item.run('m1', 'movie', 'One', '["1","6"]', now, now); // in both: counts once in the total
  item.run('m2', 'movie', 'Two', '["1"]', '2020-01-01T00:00:00Z', now);
  item.run('m3', 'movie', 'Three', '["13"]', now, now);
  item.run('s1', 'series', 'Show', '["2"]', '2020-01-01T00:00:00Z', now);
  item.run('e1', 'episode', 'Episode 1', '["2"]', now, now);
  item.run('e2', 'episode', 'Episode 2', '["2"]', now, now);
  db.prepare("INSERT INTO sync_state (key, value) VALUES ('catalog_full_at', ?)").run(now);
  const library = new LibraryService(db, new CatalogSync(db, new MockCatalogSource(), { intervalMs: 60_000, log: () => {} }));

  const calls: { method: string; url: string; body: { embeds: { title: string; description?: string }[] } }[] = [];
  let deleted = false;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ method: String(init?.method), url, body: JSON.parse(String(init?.body)) });
    if (init?.method === 'PATCH' && deleted) return new Response(JSON.stringify({ code: 10008, message: 'Unknown Message' }), { status: 404 });
    return new Response(JSON.stringify({ id: `msg${calls.length}` }), { status: 200 });
  };
  const board = new LibraryBoard(db, library, fetchImpl, () => {});
  return { board, calls, deleteMessage: () => (deleted = true) };
}

describe('library counts board', () => {
  it('lists each library on its own line, grouped into movies and TV', async () => {
    const { board, calls } = setup();
    await board.configure({ webhookUrl: WEBHOOK, hiddenLibraryIds: ['13'] }, 'admin');
    const [movies, tv] = calls[0]!.body.embeds;
    expect(movies!.title).toBe('🎬 Movies: 2 movies'); // One and Two; Cams is hidden
    expect(movies!.description).toBe('2 libraries\n\n**Movies**: 2 · +1 this week\n**Movies - 4K**: 1 · +1 this week');
    expect(movies!.description).not.toContain('Cams');
    expect(tv!.title).toBe('📺 TV shows: 1 show');
    expect(tv!.description).toContain('**TV Shows**: 1 · +2 new episodes this week');
  });

  it('posts once, then edits the same message, and reposts if it was deleted', async () => {
    const { board, calls, deleteMessage } = setup();
    await board.configure({ webhookUrl: WEBHOOK }, 'admin');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('wait=true');

    await board.update();
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.url).toBe(`${WEBHOOK}/messages/msg1`);

    deleteMessage();
    await board.update();
    expect(calls.slice(2).map((c) => c.method)).toEqual(['PATCH', 'POST']);
    expect(board.view().lastError).toBeNull();
  });
});
