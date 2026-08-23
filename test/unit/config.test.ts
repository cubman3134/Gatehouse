import { describe, it, expect } from 'vitest';
import { loadConfig, isLoopback, ConfigError } from '../../src/config.js';

/**
 * An absolute path that is absolute on THIS platform. `D:/gh` is absolute on Windows and
 * relative on POSIX, so hard-coding either spelling makes the downloads-dir tests assert the
 * opposite of what they mean on the other one.
 */
const ABS = process.platform === 'win32' ? 'D:\\gh' : '/srv/gh';

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
    expect(c.downloadStallMs).toBe(120_000);
    expect(c.downloadNoStartMs).toBe(60_000);
    expect(c.downloadTtlMs).toBe(86_400_000);
    expect(c.downloadMaxBytes).toBe(50 * 1024 * 1024 * 1024);
    expect(c.downloadsDir).toBe('');
  });

  it('accepts explicit download settings', () => {
    const c = loadConfig({
      GATEHOUSE_DOWNLOADS_DIR: ABS,
      GATEHOUSE_DOWNLOAD_CONCURRENCY: '5',
      GATEHOUSE_DOWNLOAD_TTL_MS: '3600000',
      GATEHOUSE_DOWNLOAD_MAX_BYTES: '1073741824',
      GATEHOUSE_DOWNLOAD_STALL_MS: '30000',
      GATEHOUSE_DOWNLOAD_NO_START_MS: '15000',
    });
    expect(c.downloadsDir).toBe(ABS);
    expect(c.downloadConcurrency).toBe(5);
    expect(c.downloadTtlMs).toBe(3_600_000);
    expect(c.downloadMaxBytes).toBe(1_073_741_824);
    expect(c.downloadStallMs).toBe(30_000);
    expect(c.downloadNoStartMs).toBe(15_000);
  });

  // A relative value would be resolved against whatever directory `electron .` was launched
  // from -- a different one after a restart from another shell -- and `result.path`, which is
  // documented as a path a consumer hands to another process, would be a meaningless relative
  // string. Refusing is better than silently picking one of two plausible readings of it.
  it('refuses a relative downloads dir, naming the setting', () => {
    for (const bad of ['downloads', './downloads', '../shared/dl', 'a/b/c']) {
      expect(() => loadConfig({ GATEHOUSE_DOWNLOADS_DIR: bad })).toThrow(ConfigError);
      expect(() => loadConfig({ GATEHOUSE_DOWNLOADS_DIR: bad })).toThrow(/GATEHOUSE_DOWNLOADS_DIR/);
      expect(() => loadConfig({ GATEHOUSE_DOWNLOADS_DIR: bad })).toThrow(/absolute/i);
    }
  });

  it('still accepts an absolute downloads dir, and blank still means derive it', () => {
    expect(loadConfig({ GATEHOUSE_DOWNLOADS_DIR: ABS }).downloadsDir).toBe(ABS);
    // Blank is not "relative", it is "unset" -- the derived default needs Electron and so
    // cannot be computed by a pure function over the environment.
    expect(loadConfig({ GATEHOUSE_DOWNLOADS_DIR: '   ' }).downloadsDir).toBe('');
    expect(loadConfig({}).downloadsDir).toBe('');
  });

  // Surrounding whitespace is trimmed before the check, so a value that is absolute once
  // trimmed must be accepted -- and one that is not must still be refused after trimming.
  it('applies the absolute check to the trimmed value', () => {
    expect(loadConfig({ GATEHOUSE_DOWNLOADS_DIR: `  ${ABS}  ` }).downloadsDir).toBe(ABS);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOADS_DIR: '  downloads  ' })).toThrow(ConfigError);
  });

  it('defaults the stall window to 120s and holds it to [5000, 3600000]', () => {
    expect(loadConfig({}).downloadStallMs).toBe(120_000);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_STALL_MS: '4999' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_STALL_MS: '3600001' })).toThrow(ConfigError);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_STALL_MS: '5000' }).downloadStallMs).toBe(5_000);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_STALL_MS: '3600000' }).downloadStallMs).toBe(3_600_000);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_STALL_MS: 'soon' })).toThrow(ConfigError);
  });

  // A different fault from a stall and a much tighter bound: nothing has been received yet, so
  // this window is not competing with the 4MB progress throttle the stall window has to clear.
  it('defaults the no-start window to 60s and holds it to [5000, 600000]', () => {
    expect(loadConfig({}).downloadNoStartMs).toBe(60_000);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_NO_START_MS: '4999' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_NO_START_MS: '600001' })).toThrow(ConfigError);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_NO_START_MS: '5000' }).downloadNoStartMs).toBe(5_000);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_NO_START_MS: '600000' }).downloadNoStartMs).toBe(600_000);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_NO_START_MS: 'never' })).toThrow(ConfigError);
  });

  // Rejection alone does not catch an off-by-one in the comparison; the boundary values
  // have to be asserted ACCEPTED too.
  it('accepts the download settings at their exact boundaries', () => {
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_CONCURRENCY: '1' }).downloadConcurrency).toBe(1);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_CONCURRENCY: '16' }).downloadConcurrency).toBe(16);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_TTL_MS: '60000' }).downloadTtlMs).toBe(60_000);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_TTL_MS: '2592000000' }).downloadTtlMs).toBe(2_592_000_000);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_MAX_BYTES: '1048576' }).downloadMaxBytes).toBe(1_048_576);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_NO_START_MS: '5000' }).downloadNoStartMs).toBe(5_000);
    expect(loadConfig({ GATEHOUSE_DOWNLOAD_NO_START_MS: '600000' }).downloadNoStartMs).toBe(600_000);
  });

  it('rejects download settings just past their boundaries', () => {
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_TTL_MS: '2592000001' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_MAX_BYTES: '1048575' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_NO_START_MS: '4999' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_NO_START_MS: '600001' })).toThrow(ConfigError);
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
