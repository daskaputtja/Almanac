import { describe, expect, it } from 'vitest';
import { ActivityMonitor } from '../server/activity/monitor.js';
import type { SessionSource } from '../server/silo/client.js';
import { MockSessionSource } from '../server/silo/mock.js';

const quiet = () => {};

describe('ActivityMonitor', () => {
  it('publishes a snapshot after polling', async () => {
    const monitor = new ActivityMonitor(new MockSessionSource(), 1000, quiet);
    const seen: number[] = [];
    monitor.subscribe((s) => seen.push(s.streams.length));
    await monitor.poll();
    expect(monitor.current().fetchedAt).not.toBeNull();
    expect(monitor.current().error).toBeNull();
    expect(seen).toEqual([monitor.current().streams.length]);
  });

  it('keeps the last good streams when Silo fails', async () => {
    let fail = false;
    const mock = new MockSessionSource();
    const source: SessionSource = {
      listSessions: () => (fail ? Promise.reject(new Error('Silo is down')) : mock.listSessions()),
    };
    const monitor = new ActivityMonitor(source, 1000, quiet);
    await monitor.poll();
    const count = monitor.current().streams.length;

    fail = true;
    await monitor.poll();
    expect(monitor.current().error).toBe('Silo is down');
    expect(monitor.current().streams).toHaveLength(count);

    fail = false;
    await monitor.poll();
    expect(monitor.current().error).toBeNull();
  });
});
