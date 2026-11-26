import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { SuspensionService } from '../server/suspensions/suspensions.js';
import { WhmcsClient } from '../server/suspensions/whmcs.js';

/** A pretend WHMCS: two clients, Silo services in product 7, a domain in product 3. */
function fakeWhmcs(options: { deny?: 'credentials' | 'ip' } = {}) {
  const calls: Record<string, string>[] = [];
  const services = [
    { id: 101, clientid: 1, pid: 7, name: 'Silo 2 Streams', status: 'Active', username: 'pike' },
    { id: 102, clientid: 1, pid: 3, name: 'Domain', status: 'Active', username: '' },
    { id: 201, clientid: 2, pid: 7, name: 'Silo 4 Streams', status: 'Suspended', username: 'svc-201' },
  ];
  const clients = [
    { id: 1, email: 'pike@example.com' },
    { id: 2, email: 'robin@example.com' },
  ];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    expect(url).toBe('https://billing.example.com/includes/api.php');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
    const p = Object.fromEntries(new URLSearchParams(String(init?.body)));
    calls.push(p);
    if (options.deny === 'ip') return new Response('Access Denied', { status: 403 });
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (options.deny === 'credentials' || p.identifier !== 'ID' || p.secret !== 'SECRET') return reply({ result: 'error', message: 'Authentication Failed' });
    expect(p.responsetype).toBe('json');
    switch (p.action) {
      case 'GetClientsProducts': {
        const list = services.filter((s) => (!p.username2 || s.username === p.username2) && (!p.clientid || String(s.clientid) === p.clientid));
        return reply({ result: 'success', totalresults: list.length, products: list.length ? { product: list.map((s) => ({ ...s, id: String(s.id), pid: String(s.pid) })) } : '' });
      }
      case 'GetClientsDetails': {
        const c = clients.find((x) => x.email === p.email);
        return reply(c ? { result: 'success', userid: c.id, client: { id: c.id, email: c.email } } : { result: 'error', message: 'Client Not Found' });
      }
      case 'ModuleSuspend':
      case 'ModuleUnsuspend': {
        const s = services.find((x) => String(x.id) === p.serviceid)!;
        s.status = p.action === 'ModuleSuspend' ? 'Suspended' : 'Active';
        return reply({ result: 'success' });
      }
    }
    return reply({ result: 'error', message: 'Unknown action' });
  };
  return { calls, services, fetchImpl };
}

const settings = { url: 'https://billing.example.com/', identifier: 'ID', secret: 'SECRET', accessKey: null, match: 'username_or_email' as const, productIds: [7] };

describe('WHMCS', () => {
  it('suspends the Silo service found by service username, and only that one', async () => {
    const w = fakeWhmcs();
    const client = new WhmcsClient(settings, w.fetchImpl);
    expect(await client.suspend({ username: 'pike', email: 'pike@example.com' }, 'Opened 244 titles in a day')).toBe('WHMCS suspended service #101 (Silo 2 Streams).');
    const suspend = w.calls.find((c) => c.action === 'ModuleSuspend')!;
    expect(suspend).toMatchObject({ serviceid: '101', suspendreason: 'Almanac: Opened 244 titles in a day', identifier: 'ID' });
    expect(w.services.find((s) => s.id === 102)!.status).toBe('Active'); // the domain is left alone
    // Doing it again is harmless.
    expect(await client.suspend({ username: 'pike', email: null }, 'again')).toMatch(/^Nothing to do: service #101 .* is already suspended/);
  });

  it('falls back to the client’s email, and unsuspends', async () => {
    const w = fakeWhmcs();
    const client = new WhmcsClient(settings, w.fetchImpl);
    expect(await client.unsuspend({ username: 'robin', email: 'robin@example.com' })).toBe('WHMCS unsuspended service #201 (Silo 4 Streams).');
    expect(w.calls.map((c) => c.action)).toEqual(['GetClientsProducts', 'GetClientsDetails', 'GetClientsProducts', 'ModuleUnsuspend']);
  });

  it('says clearly when it can’t find the customer, or WHMCS refuses', async () => {
    const w = fakeWhmcs();
    await expect(new WhmcsClient({ ...settings, match: 'username' }, w.fetchImpl).suspend({ username: 'robin', email: 'robin@example.com' }, 'x')).rejects.toThrow(
      /no Silo service for this customer \(looked for service username “robin” in products 7\)/,
    );
    await expect(new WhmcsClient(settings, w.fetchImpl).suspend({ username: 'nobody', email: 'nobody@example.com' }, 'x')).rejects.toThrow(/no Silo service/);
    await expect(new WhmcsClient(settings, fakeWhmcs({ deny: 'credentials' }).fetchImpl).test()).rejects.toThrow(/refused the credentials: Authentication Failed/);
    await expect(new WhmcsClient(settings, fakeWhmcs({ deny: 'ip' }).fetchImpl).test()).rejects.toThrow(/Allow this server’s IP/);
    expect(await new WhmcsClient(settings, w.fetchImpl).test()).toBe('Connected to WHMCS (3 services).');
  });

  it('runs approved suspension requests through WHMCS, and notes what happened', async () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO silo_users (id, username, email, enabled, synced_at) VALUES ('42', 'pike', 'pike@example.com', 1, ?)").run(new Date().toISOString());
    const w = fakeWhmcs();
    const notes: string[] = [];
    const service = new SuspensionService(db, { note: (_u, _a, t) => notes.push(t) }, w.fetchImpl);
    expect(() => service.configure({ kind: 'whmcs', whmcs: { productIds: '7, x' } }, 'admin')).toThrow(/whole numbers/);
    service.configure({ kind: 'whmcs', whmcs: { url: 'https://billing.example.com/includes/api.php', identifier: 'ID', secret: 'SECRET', productIds: '7' } }, 'admin');
    const view = service.portal();
    expect(view).toMatchObject({ kind: 'whmcs', ready: true, whmcs: { url: 'https://billing.example.com', identifier: 'ID', secretSet: true, productIds: [7], match: 'username_or_email' } });
    expect(JSON.stringify(view)).not.toContain('SECRET');
    // A secret isn't wiped by saving other fields.
    service.configure({ whmcs: { match: 'username' } }, 'admin');
    expect(service.portal().whmcs.secretSet).toBe(true);

    const done = await service.request('42', 'suspend', 'Sharing with another household', { id: 1, name: 'sam', role: 'admin' });
    expect(done).toMatchObject({ status: 'done', portalMessage: 'WHMCS suspended service #101 (Silo 2 Streams).' });
    expect(notes.at(-1)).toMatch(/Suspended this account through the billing portal.*Portal: WHMCS suspended service #101/s);
    await expect(service.sendEvent({ event: 'flag' })).rejects.toThrow(/can’t receive/);
  });
});
