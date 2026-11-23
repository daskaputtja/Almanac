import { describe, expect, it } from 'vitest';
import { cleanClientName } from '../server/activity/map.js';
import { parseHistoryQuery } from '../server/app.js';

describe('parseHistoryQuery', () => {
  it('reads valid parameters', () => {
    expect(
      parseHistoryQuery({
        search: ' lilo ',
        user: '42',
        type: 'movie',
        method: 'transcode',
        from: '2026-01-01',
        minWatched: '30',
        completed: 'true',
        sort: 'watched',
        direction: 'asc',
        page: '3',
        pageSize: '25',
      }),
    ).toEqual({
      search: 'lilo',
      userId: '42',
      mediaType: 'movie',
      method: 'transcode',
      platform: undefined,
      from: '2026-01-01T00:00:00.000Z',
      to: undefined,
      minWatchedSeconds: 30,
      completed: true,
      sort: 'watched',
      direction: 'asc',
      page: 3,
      pageSize: 25,
    });
  });

  it('drops invalid values instead of passing them on', () => {
    const q = parseHistoryQuery({ method: 'teleport', sort: 'DROP TABLE', from: 'yesterday', page: '-2', pageSize: 'lots' });
    expect(q.method).toBeUndefined();
    expect(q.sort).toBeUndefined();
    expect(q.from).toBeUndefined();
    expect(q.page).toBeUndefined();
    expect(q.pageSize).toBeUndefined();
    expect(q.direction).toBe('desc');
  });
});

describe('cleanClientName', () => {
  it('decodes URL-encoded client names', () => {
    expect(cleanClientName('Jellyfin+for+Android+TV')).toBe('Jellyfin for Android TV');
    expect(cleanClientName('Infuse%20Pro')).toBe('Infuse Pro');
    expect(cleanClientName('Silo Android TV')).toBe('Silo Android TV');
    expect(cleanClientName('C++ Player')).toBe('C++ Player');
    expect(cleanClientName('')).toBeNull();
  });
});
