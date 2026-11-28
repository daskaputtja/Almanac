import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { embedsToTelegramHtml, parseTopicLink, TelegramService } from '../server/notify/telegram.js';

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake1';

/** A pretend Telegram Bot API. */
function fakeTelegram() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const messages = new Map<number, string>();
  let nextId = 100;
  const state = { migrate: false };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const [, token, method] = url.match(/\/bot([^/]+)\/(\w+)$/)!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method: method!, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    const fail = (status: number, description: string, parameters?: unknown) => new Response(JSON.stringify({ ok: false, error_code: status, description, parameters }), { status });
    if (token !== TOKEN) return fail(401, 'Unauthorized');
    switch (method) {
      case 'getMe':
        return ok({ id: 1, is_bot: true, username: 'almanac_test_bot' });
      case 'getUpdates':
        return ok([
          { update_id: 1, my_chat_member: { chat: { id: -1001, title: 'Silo Status', type: 'supergroup' }, new_chat_member: { status: 'member' } } },
          { update_id: 2, message: { chat: { id: 55, type: 'private' } } },
          { update_id: 3, channel_post: { chat: { id: -1002, title: 'Silo News', type: 'channel' } } },
          { update_id: 4, my_chat_member: { chat: { id: -1003, title: 'Old group', type: 'group' }, new_chat_member: { status: 'left' } } },
        ]);
      case 'sendMessage':
        if (state.migrate && body.chat_id === '-1001') return fail(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: -1009 });
        messages.set(nextId, String(body.text));
        return ok({ message_id: nextId++ });
      case 'editMessageText': {
        const id = Number(body.message_id);
        if (!messages.has(id)) return fail(400, 'Bad Request: message to edit not found');
        if (messages.get(id) === body.text) return fail(400, 'Bad Request: message is not modified');
        messages.set(id, String(body.text));
        return ok(true);
      }
    }
    return fail(404, 'Not Found');
  };
  return { calls, messages, state, fetchImpl };
}

describe('Telegram', () => {
  it('checks the token, finds the groups the bot is in, and never shows the token', async () => {
    const t = fakeTelegram();
    const tg = new TelegramService(openDatabase(':memory:'), t.fetchImpl as typeof fetch, () => {});
    await expect(tg.setToken('nonsense', 'admin')).rejects.toThrow(/doesn’t look like a bot token/);
    await expect(tg.setToken('123456789:AAHwrongwrongwrongwrongwrongwrongwro', 'admin')).rejects.toThrow(/doesn’t recognise that token/);
    const view = await tg.setToken(TOKEN, 'admin');
    expect(view).toMatchObject({ tokenSet: true, botUsername: 'almanac_test_bot' });
    expect(view.chats).toEqual([
      { id: '-1001', title: 'Silo Status', type: 'supergroup' },
      { id: '-1002', title: 'Silo News', type: 'channel' },
    ]);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it('posts a board once, then edits it in place', async () => {
    const t = fakeTelegram();
    const tg = new TelegramService(openDatabase(':memory:'), t.fetchImpl as typeof fetch, () => {});
    await tg.setToken(TOKEN, 'admin');
    await expect(tg.setTarget('status', '-999', 'admin')).rejects.toThrow(/groups the bot is in/);
    await tg.setTarget('status', '-1001', 'admin');
    expect(tg.wants('status')).toBe(true);
    expect(tg.wants('library')).toBe(false);

    await tg.publish('status', [{ title: '🖥️ Server status', description: '🟢 **Emby 1**: 100% today', footer: { text: 'Checked every 2 minutes by Almanac' } }]);
    await tg.publish('status', [{ title: '🖥️ Server status', description: '🔴 **Emby 1**: down for 4 min', footer: { text: 'Checked every 2 minutes by Almanac' } }]);
    await tg.publish('status', [{ title: '🖥️ Server status', description: '🔴 **Emby 1**: down for 4 min', footer: { text: 'Checked every 2 minutes by Almanac' } }]); // unchanged
    expect(t.calls.filter((c) => c.method !== 'getMe' && c.method !== 'getUpdates').map((c) => c.method)).toEqual(['sendMessage', 'editMessageText', 'editMessageText']);
    expect(t.messages.get(100)).toBe('<b>🖥️ Server status</b>\n\n🔴 <b>Emby 1</b>: down for 4 min\n\n<i>Checked every 2 minutes by Almanac</i>');
    expect(t.calls.find((c) => c.method === 'sendMessage')!.body).toMatchObject({ chat_id: '-1001', parse_mode: 'HTML', disable_notification: true });
    expect(tg.view().targets.status).toMatchObject({ chatId: '-1001', chatTitle: 'Silo Status', lastError: null });

    // Someone deleted the message: a new one is posted.
    t.messages.clear();
    await tg.publish('status', [{ title: 'Server status', description: 'all good' }]);
    expect(t.calls.at(-1)!.method).toBe('sendMessage');
  });

  it('follows a group that became a supergroup, and records errors without throwing', async () => {
    const t = fakeTelegram();
    const tg = new TelegramService(openDatabase(':memory:'), t.fetchImpl as typeof fetch, () => {});
    await tg.setToken(TOKEN, 'admin');
    await tg.setTarget('library', '-1001', 'admin');
    t.state.migrate = true;
    await tg.publish('library', [{ title: 'Movies', description: 'x' }]);
    expect(t.calls.at(-1)!.body.chat_id).toBe('-1009');
    expect(tg.view().targets.library.lastError).toBeNull();
  });

  it('turns Discord formatting into Telegram’s, safely', () => {
    expect(
      embedsToTelegramHtml([
        { title: '🎬 Movies: 96,367 movies', description: '12 libraries\n\n**Movies - 4K**: 6,895 · +26 this week\n**Tom \\& Jerry <3**: 5\n[Open](https://almanac.example/x)' },
        { title: '📺 TV', fields: [{ name: 'Most drops', value: 'Fire TV: 3' }], footer: { text: 'Updated every hour by Almanac' } },
      ]),
    ).toBe(
      '<b>🎬 Movies: 96,367 movies</b>\n\n12 libraries\n\n<b>Movies - 4K</b>: 6,895 · +26 this week\n<b>Tom \\&amp; Jerry &lt;3</b>: 5\n<a href="https://almanac.example/x">Open</a>\n\n<b>📺 TV</b>\n\n<b>Most drops</b>\nFire TV: 3\n\n<i>Updated every hour by Almanac</i>',
    );
  });
});

describe('Telegram topics', () => {
  it('reads topic links', () => {
    expect(parseTopicLink('https://t.me/c/1234567890/33288')).toEqual({ chatId: '-1001234567890', threadId: 33288 });
    expect(parseTopicLink('t.me/c/1234567890/33288/40001')).toEqual({ chatId: '-1001234567890', threadId: 33288 });
    expect(parseTopicLink('33288')).toEqual({ chatId: null, threadId: 33288 });
    expect(parseTopicLink('https://t.me/somegroup')).toBeNull();
  });

  it('posts into the chosen topic, and explains a closed one', async () => {
    const t = fakeTelegram();
    const tg = new TelegramService(openDatabase(':memory:'), t.fetchImpl as typeof fetch, () => {});
    await tg.setToken(TOKEN, 'admin');
    await expect(tg.setTarget('status', '-1001', 'admin', 'https://t.me/c/999/5')).rejects.toThrow(/different group/);
    await expect(tg.setTarget('status', '-1001', 'admin', 'nope')).rejects.toThrow(/Copy Link/);
    await tg.setTarget('status', '-1001', 'admin', '33288');
    await tg.publish('status', [{ title: 'Server status' }]);
    expect(t.calls.filter((c) => c.method === 'sendMessage').at(-1)!.body).toMatchObject({ chat_id: '-1001', message_thread_id: 33288 });
    expect(tg.view().targets.status).toMatchObject({ threadId: 33288 });
  });
});
