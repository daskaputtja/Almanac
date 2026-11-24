import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { SuspensionService } from '../server/suspensions/suspensions.js';

const SECRET = 'a-long-shared-secret-for-the-billing-portal';
const MOD = { id: 2, name: 'morgan', role: 'mod' as const };
const ADMIN = { id: 1, name: 'sam', role: 'admin' as const };

/** What the billing portal does with a request: check the signature and the time, then act. */
function portalAccepts(headers: Record<string, string>, body: string, now = Date.now()): boolean {
  const timestamp = headers['X-Almanac-Timestamp']!;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false; // older than 5 minutes: a replay
  const expected = `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
  const given = headers['X-Almanac-Signature'] ?? '';
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function setup(portalStatus = 200) {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO silo_users (id, username, email, enabled, synced_at) VALUES ('7', 'pike', 'pike@example.com', 1, ?)").run(new Date().toISOString());
  const calls: { body: Record<string, unknown>; valid: boolean }[] = [];
  const notes: string[] = [];
  const staff: string[] = [];
  const service = new SuspensionService(
    db,
    {
      note: (_userId, actor, text) => notes.push(`${actor.name}: ${text}`),
      tellStaff: async (embed) => void staff.push(embed.title ?? ''),
      baseUrl: () => 'https://almanac.example',
    },
    async (_url, init) => {
      const body = String(init?.body);
      calls.push({ body: JSON.parse(body), valid: portalAccepts(init?.headers as Record<string, string>, body) });
      return new Response(JSON.stringify(portalStatus === 200 ? { message: 'Account disabled; customer told to contact support.' } : { error: 'No customer with that email' }), {
        status: portalStatus,
      });
    },
  );
  service.configure({ url: 'https://billing.example/almanac', secret: SECRET }, 'sam');
  return { db, service, calls, notes, staff };
}

describe('suspensions through the billing portal', () => {
  it('holds a mod’s request for an admin, then sends a signed request when approved', async () => {
    const { service, calls, notes, staff } = setup();
    const request = await service.request('7', 'suspend', '123 downloads (270 GB) in a week, all original quality.', MOD);
    expect(request.status).toBe('pending');
    expect(calls).toHaveLength(0); // nothing happens until an admin says so
    expect(notes[0]).toMatch(/^morgan: Asked for this account to be suspended: 123 downloads/);
    await new Promise((r) => setTimeout(r, 0));
    expect(staff[0]).toBe('morgan asks to suspend pike');
    expect(service.pendingCount()).toBe(1);

    const done = await service.review(request.id, 'approve', '', ADMIN);
    expect(done).toMatchObject({ status: 'done', reviewedBy: 'sam', portalMessage: 'Account disabled; customer told to contact support.' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.valid).toBe(true);
    expect(calls[0]!.body).toMatchObject({
      event: 'suspend',
      request_id: request.id,
      user: { silo_id: '7', username: 'pike', email: 'pike@example.com' },
      reason: '123 downloads (270 GB) in a week, all original quality.',
      requested_by: 'morgan',
      approved_by: 'sam',
    });
    expect(notes.at(-1)).toMatch(/^sam: Suspended this account through the billing portal\. Asked for by morgan\./);
  });

  it('lets admins act straight away, and requires reasons', async () => {
    const { service, calls } = setup();
    await expect(service.request('7', 'suspend', 'too short', ADMIN)).rejects.toThrow(/at least 10 characters/);
    const done = await service.request('7', 'unsuspend', 'Spoke to them; it was a family member.', ADMIN);
    expect(done.status).toBe('done');
    expect(calls[0]!.body.event).toBe('unsuspend');
  });

  it('needs a reason to reject, and only admins can review', async () => {
    const { service, calls } = setup();
    const request = await service.request('7', 'suspend', 'Four networks at once, twelve times this week.', MOD);
    await expect(service.review(request.id, 'approve', '', MOD)).rejects.toThrow(/Only admins/);
    await expect(service.review(request.id, 'reject', '', ADMIN)).rejects.toThrow(/Say why/);
    const rejected = await service.review(request.id, 'reject', 'It’s their family; they pay for 4 streams.', ADMIN);
    expect(rejected.status).toBe('rejected');
    expect(calls).toHaveLength(0);
  });

  it('allows one waiting request per account', async () => {
    const { service } = setup();
    await service.request('7', 'suspend', 'Four networks at once, twelve times this week.', MOD);
    await expect(service.request('7', 'suspend', 'Another reason that is long enough.', MOD)).rejects.toThrow(/already a request/);
  });

  it('records what the portal said when it fails, and can try again', async () => {
    const { service } = setup(404);
    const failed = await service.request('7', 'suspend', 'Four networks at once, twelve times this week.', ADMIN);
    expect(failed.status).toBe('failed');
    expect(failed.portalMessage).toBe('The billing portal doesn’t know this customer: No customer with that email');
    expect((await service.retry(failed.id, ADMIN)).status).toBe('failed');
  });

  it('won’t send anything until the portal is set up', async () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO silo_users (id, username, synced_at) VALUES ('7', 'pike', ?)").run(new Date().toISOString());
    const service = new SuspensionService(db, { note: () => {} }, async () => new Response('{}'));
    const r = await service.request('7', 'suspend', 'Four networks at once, twelve times this week.', ADMIN);
    expect(r.status).toBe('failed');
    expect(r.portalMessage).toMatch(/isn’t set up yet/);
    expect(service.list().portalConfigured).toBe(false);
    expect(() => service.configure({ secret: 'short' }, 'sam')).toThrow(/at least 24 characters/);
  });
});
