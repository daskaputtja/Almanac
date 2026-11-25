import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { StatusBoard, parsePageUrl, statusLine, toMonitors } from '../server/notify/status.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123';
const NOW = Date.parse('2026-11-25T12:00:00Z');

const page = {
  publicGroupList: [
    { name: 'Servers', monitorList: [{ id: 1, name: 'Emby 1' }, { id: 6, name: 'Emby 6' }, { id: 9, name: 'Emby 9' }, { id: 12, name: 'Silo' }] },
  ],
};
const beats = {
  heartbeatList: {
    '1': [{ status: 1, time: '2026-11-25 11:58:00.000' }],
    '6': [{ status: 1, time: '2026-11-25 11:58:00.000' }],
    '9': [
      { status: 1, time: '2026-11-25 11:50:00.000' },
      { status: 0, time: '2026-11-25 11:52:00.000' },
      { status: 0, time: '2026-11-25 11:56:00.000' },
    ],
    '12': [{ status: 3, time: '2026-11-25 11:58:00.000' }],
  },
  uptimeList: { '1_24': 1, '6_24': 0.9972, '9_24': 0.9986, '12_24': 1 },
};

describe('server status from Uptime Kuma', () => {
  it('works out the data addresses from the status page address', () => {
    expect(parsePageUrl('https://uptime.example.com/status/pixel-fusion')).toEqual({ base: 'https://uptime.example.com', slug: 'pixel-fusion' });
    expect(() => parsePageUrl('https://uptime.example.com/dashboard')).toThrow(/Uptime Kuma status page/);
  });

  it('shows a dot, the name and uptime today, or how long it has been down', () => {
    const monitors = toMonitors(page, beats, NOW);
    expect(monitors.map((m) => statusLine(m, NOW))).toEqual([
      '🟢 **Emby 1**: 100% today',
      '🟢 **Emby 6**: 99.72% today',
      '🔴 **Emby 9**: down for 8 min',
      '🔧 **Silo**: maintenance',
    ]);
  });

  it('reads the page with a Cloudflare service token and keeps one Discord message updated', async () => {
    const db = openDatabase(':memory:');
    const seen: { url: string; headers: Record<string, string>; method?: string }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, headers, method: init?.method });
      if (url.startsWith('https://uptime.example.com')) {
        if (headers['CF-Access-Client-Secret'] !== 'secret') {
          return new Response('', { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' } });
        }
        const body = url.includes('/heartbeat/') ? beats : page;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'msg1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const board = new StatusBoard(db, fetchImpl, () => {});

    await expect(board.configure({ pageUrl: 'https://uptime.example.com/status/main', webhookUrl: WEBHOOK }, 'admin')).rejects.toThrow(/Cloudflare Access login/);

    await board.configure({ accessClientId: 'id.access', accessClientSecret: 'secret' }, 'admin');
    const view = board.view();
    expect(view.lastError).toBeNull();
    expect(view.accessTokenSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain('secret'); // the token is never sent back
    expect(view.monitors).toHaveLength(4);
    expect(seen.some((r) => r.url === 'https://uptime.example.com/api/status-page/heartbeat/main' && r.headers['CF-Access-Client-Id'] === 'id.access')).toBe(true);

    await board.update();
    const discord = seen.filter((r) => r.url.startsWith('https://discord.com'));
    expect(discord.map((r) => r.method)).toEqual(['POST', 'PATCH']); // posted once, then edited
  });
});
