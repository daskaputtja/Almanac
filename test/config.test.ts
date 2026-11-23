import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.js';

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
