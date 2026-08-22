import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config.js';

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

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => loadConfig({ GATEHOUSE_PORT: 'nope' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_PORT: '70000' })).toThrow(ConfigError);
  });

  it('accepts port 0 for ephemeral test binds', () => {
    expect(loadConfig({ GATEHOUSE_PORT: '0' }).port).toBe(0);
  });
});
