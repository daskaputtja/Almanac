import { describe, expect, it } from 'vitest';
import { loadConfig, unquote } from '../server/config.js';

describe('loadConfig', () => {
  it('requires a Silo URL and key unless mocking', () => {
    expect(() => loadConfig({})).toThrow(/SILO_URL[\s\S]*SILO_API_KEY/);
    expect(loadConfig({ SILO_MOCK: 'true' }).mock).toBe(true);
  });

  it('reads defaults', () => {
    const config = loadConfig({ SILO_URL: 'https://silo.example.com', SILO_API_KEY: 'sa_test' });
    expect(config.port).toBe(8191);
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.bootstrapUser).toBeNull();
    expect(config.trustProxy).toBe(false);
    expect(config.secureCookies).toBe('auto');
  });

  it('rejects a URL without a scheme', () => {
    expect(() => loadConfig({ SILO_URL: 'silo.example.com', SILO_API_KEY: 'sa_test' })).toThrow(/http/);
  });

  it('needs both login settings together', () => {
    expect(() => loadConfig({ SILO_MOCK: '1', ALMANAC_USERNAME: 'admin' })).toThrow(/ALMANAC_PASSWORD/);
    expect(loadConfig({ SILO_MOCK: '1', ALMANAC_USERNAME: 'admin', ALMANAC_PASSWORD: 'pw' }).bootstrapUser).toEqual({
      username: 'admin',
      password: 'pw',
    });
  });
});

describe('unquote', () => {
  it('strips matching quotes and spaces pasted around a value', () => {
    expect(unquote('"sa_abc"')).toBe('sa_abc');
    expect(unquote("'sa_abc'")).toBe('sa_abc');
    expect(unquote('  sa_abc  ')).toBe('sa_abc');
    expect(unquote(' " sa_abc " ')).toBe('sa_abc');
  });

  it('leaves unmatched or inner quotes alone', () => {
    expect(unquote('"sa_abc')).toBe('"sa_abc');
    expect(unquote('sa_"abc"')).toBe('sa_"abc"');
    expect(unquote('"')).toBe('"');
  });
});

describe('artwork paths from Silo', () => {
  it('puts Silo’s address in front of paths, anywhere in the reply', async () => {
    const { withAbsoluteUrls } = await import('../server/silo/client.js');
    const reply = {
      items: [
        { title: 'A', poster_url: '/api/v2/item-posters/42?exp=1&sig=abc', backdrop_url: 'https://cdn.example.com/b.jpg' },
        { title: 'B', poster_url: null, media: { thumb_url: '/api/v2/artwork/k1' } },
      ],
      next_url_hint: 'not/a/path',
      other_url: '/api/v2/something/else',
      path: '/api/v2/admin/sessions',
      protocol_url: '//cdn.example.com/x',
    };
    expect(withAbsoluteUrls(reply, 'https://silo.example.com')).toEqual({
      items: [
        { title: 'A', poster_url: '/api/artwork/item-posters/42?exp=1&sig=abc', backdrop_url: 'https://cdn.example.com/b.jpg' },
        { title: 'B', poster_url: null, media: { thumb_url: '/api/artwork/artwork/k1' } },
      ],
      next_url_hint: 'not/a/path',
      other_url: 'https://silo.example.com/api/v2/something/else',
      path: '/api/v2/admin/sessions', // not a *_url field
      protocol_url: '//cdn.example.com/x',
    });
  });
});
