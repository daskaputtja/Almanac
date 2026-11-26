import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { postToDiscord } from '../server/notify/discord.js';
import { SuspensionService } from '../server/suspensions/suspensions.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123';

describe('link buttons on staff posts', () => {
  it('sends link buttons, and the post without them if Discord refuses them', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    let refuse = false;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sent.push({ url, body });
      return refuse && body.components ? new Response('{"message":"Invalid Form Body"}', { status: 400 }) : new Response('{}', { status: 200 });
    };
    await postToDiscord(WEBHOOK, [{ title: 'Hi' }], fetchImpl, undefined, [
      { label: 'Review in Almanac', url: 'https://almanac.example/moderation?request=3#request-3' },
      { label: 'Not a link', url: 'javascript:alert(1)' },
    ]);
    expect(sent[0]!.url).toContain('with_components=true');
    expect(sent[0]!.body.components).toEqual([
      { type: 1, components: [{ type: 2, style: 5, label: 'Review in Almanac', url: 'https://almanac.example/moderation?request=3#request-3' }] },
    ]);

    refuse = true;
    sent.length = 0;
    await postToDiscord(WEBHOOK, [{ title: 'Hi' }], fetchImpl, undefined, [{ label: 'Open', url: 'https://almanac.example/x' }]);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.components).toBeUndefined();
    expect(sent[1]!.url).not.toContain('with_components');
  });

  it('puts Review and Case file buttons on a request waiting for an admin', async () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO silo_users (id, username, email, enabled, synced_at) VALUES ('42', 'pike', 'pike@example.com', 1, ?)").run(new Date().toISOString());
    const posts: { buttons: { label: string; url: string }[] }[] = [];
    const service = new SuspensionService(db, {
      note: () => {},
      tellStaff: async (_embed, buttons) => {
        posts.push({ buttons: buttons ?? [] });
      },
      baseUrl: () => 'https://almanac.example',
    });
    const r = await service.request('42', 'suspend', 'Sharing with another household', { id: 2, name: 'morgan', role: 'mod' });
    expect(posts[0]!.buttons).toEqual([
      { label: 'Review in Almanac', url: `https://almanac.example/moderation?request=${r.id}#request-${r.id}` },
      { label: 'Case file', url: 'https://almanac.example/users/42/case' },
    ]);
  });
});
