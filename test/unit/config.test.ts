import { describe, it, expect } from 'vitest';
import { loadConfig, isLoopback, ConfigError } from '../../src/config.js';

describe('loadConfig', () => {
  it('defaults to loopback on FlareSolverr port with no token', () => {
    const c = loadConfig({});
    expect(c.bind).toBe('127.0.0.1');
    expect(c.port).toBe(8191);
    expect(c.token).toBeNull();
    expect(c.concurrency).toBe(2);
  });

  it('accepts a loopback bind without a token', () => {
    expect(loadConfig({ GATEHOUSE_BIND: '::1' }).token).toBeNull();
    expect(loadConfig({ GATEHOUSE_BIND: 'localhost' }).token).toBeNull();
  });

  it('refuses a non-loopback bind with no token', () => {
    expect(() => loadConfig({ GATEHOUSE_BIND: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_BIND: '0.0.0.0' })).toThrow(/token/i);
  });

  it('allows a non-loopback bind when a token is supplied', () => {
    const c = loadConfig({ GATEHOUSE_BIND: '0.0.0.0', GATEHOUSE_TOKEN: 'sekrit' });
    expect(c.bind).toBe('0.0.0.0');
    expect(c.token).toBe('sekrit');
  });

  it('rejects a blank token as if it were absent', () => {
    expect(() => loadConfig({ GATEHOUSE_BIND: '0.0.0.0', GATEHOUSE_TOKEN: '   ' })).toThrow(ConfigError);
  });

  it('treats a blank token on a loopback bind as no token at all', () => {
    expect(loadConfig({ GATEHOUSE_BIND: '127.0.0.1', GATEHOUSE_TOKEN: '   ' }).token).toBeNull();
    expect(loadConfig({ GATEHOUSE_TOKEN: '' }).token).toBeNull();
  });

  it('falls back to loopback when the bind is blank', () => {
    expect(loadConfig({ GATEHOUSE_BIND: '   ' }).bind).toBe('127.0.0.1');
    expect(loadConfig({ GATEHOUSE_BIND: '' }).bind).toBe('127.0.0.1');
  });

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => loadConfig({ GATEHOUSE_PORT: 'nope' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_PORT: '70000' })).toThrow(ConfigError);
  });

  it('accepts port 0 for ephemeral test binds', () => {
    expect(loadConfig({ GATEHOUSE_PORT: '0' }).port).toBe(0);
  });

  it('defaults the solve timeout to 70s and holds it to [1000, 600000]', () => {
    expect(loadConfig({}).solveTimeoutMs).toBe(70_000);
    expect(() => loadConfig({ GATEHOUSE_SOLVE_TIMEOUT_MS: '999' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_SOLVE_TIMEOUT_MS: '600001' })).toThrow(ConfigError);
    expect(loadConfig({ GATEHOUSE_SOLVE_TIMEOUT_MS: '1000' }).solveTimeoutMs).toBe(1_000);
    expect(loadConfig({ GATEHOUSE_SOLVE_TIMEOUT_MS: '600000' }).solveTimeoutMs).toBe(600_000);
  });

  it('defaults concurrency to 2 and holds it to [1, 16]', () => {
    expect(loadConfig({}).concurrency).toBe(2);
    expect(() => loadConfig({ GATEHOUSE_CONCURRENCY: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_CONCURRENCY: '17' })).toThrow(ConfigError);
    expect(loadConfig({ GATEHOUSE_CONCURRENCY: '1' }).concurrency).toBe(1);
    expect(loadConfig({ GATEHOUSE_CONCURRENCY: '16' }).concurrency).toBe(16);
  });

  it('defaults the download settings', () => {
    const c = loadConfig({});
    expect(c.downloadConcurrency).toBe(2);
    expect(c.downloadTtlMs).toBe(86_400_000);
    expect(c.downloadMaxBytes).toBe(50 * 1024 * 1024 * 1024);
    expect(c.downloadsDir).toBe('');
  });

  it('accepts explicit download settings', () => {
    const c = loadConfig({
      GATEHOUSE_DOWNLOADS_DIR: 'D:/gh',
      GATEHOUSE_DOWNLOAD_CONCURRENCY: '5',
      GATEHOUSE_DOWNLOAD_TTL_MS: '3600000',
      GATEHOUSE_DOWNLOAD_MAX_BYTES: '1073741824',
    });
    expect(c.downloadsDir).toBe('D:/gh');
    expect(c.downloadConcurrency).toBe(5);
    expect(c.downloadTtlMs).toBe(3_600_000);
    expect(c.downloadMaxBytes).toBe(1_073_741_824);
  });

  // Rejection alone does not catch an off-by-one in the comparison; the boundary values
  // have to be asserted ACCEPTED too.
  it('accepts the download settings at their exact boundaries', () => {
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_CONCURRENCY: '1' }).downloadConcurrency).toBe(1);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_CONCURRENCY: '16' }).downloadConcurrency).toBe(16);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_TTL_MS: '60000' }).downloadTtlMs).toBe(60_000);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_TTL_MS: '2592000000' }).downloadTtlMs).toBe(2_592_000_000);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_MAX_BYTES: '1048576' }).downloadMaxBytes).toBe(1_048_576);
  });

  it('rejects download settings just past their boundaries', () => {
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_TTL_MS: '2592000001' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_MAX_BYTES: '1048575' })).toThrow(ConfigError);
  });

  it('treats a whitespace-only downloads dir as unset', () => {
    expect(loadConfig({ GATEHOUSE_DOWNLOADS_DIR: '   ' }).downloadsDir).toBe('');
  });

  it('rejects out-of-range download settings', () => {
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_CONCURRENCY: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_CONCURRENCY: '17' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_TTL_MS: '999' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_MAX_BYTES: '0' })).toThrow(ConfigError);
  });
});

describe('isLoopback', () => {
  it('accepts only the three exact loopback spellings', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
  });

  it('rejects wildcard, uppercase, near-miss and bracketed forms', () => {
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('LOCALHOST')).toBe(false);
    expect(isLoopback('127.0.0.2')).toBe(false);
    expect(isLoopback('[::1]')).toBe(false);
  });
});
