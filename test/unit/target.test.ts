import { describe, it, expect } from 'vitest';
import { validateTarget, isTargetError } from '../../src/api/target.js';

describe('validateTarget', () => {
  it('accepts an http and an https url and derives a session', () => {
    expect(validateTarget('http://example.test/a', undefined)).toEqual({ url: 'http://example.test/a', session: 'example.test' });
    expect(validateTarget('https://example.test/a', undefined)).toEqual({ url: 'https://example.test/a', session: 'example.test' });
  });
  it('honours an explicit valid session', () => {
    expect(validateTarget('http://example.test/a', 'vimm')).toEqual({ url: 'http://example.test/a', session: 'vimm' });
  });
  it('forwards the parsed href, not the raw string', () => {
    const r = validateTarget('http://example.test', undefined);
    expect(isTargetError(r) ? '' : r.url).toBe('http://example.test/');
  });
  it('rejects a non-http scheme', () => {
    for (const u of ['file:///C:/x', 'mailto:a@b.c', 'data:text/html,x', 'about:blank']) {
      const r = validateTarget(u, undefined);
      expect(isTargetError(r)).toBe(true);
    }
  });
  it('rejects an unparseable url and a non-string', () => {
    expect(isTargetError(validateTarget('not a url', undefined))).toBe(true);
    expect(isTargetError(validateTarget(42, undefined))).toBe(true);
    expect(isTargetError(validateTarget('', undefined))).toBe(true);
  });
  it('rejects a hostile session name', () => {
    for (const s of ['../../x', 'a\\b', 'a:b', '..', '.', 'x'.repeat(65)]) {
      expect(isTargetError(validateTarget('http://example.test/a', s))).toBe(true);
    }
  });
  it('sanitizes a derived session that is not a legal name', () => {
    const r = validateTarget('http://[::1]:8080/a', undefined);
    expect(isTargetError(r)).toBe(false);
    expect(isTargetError(r) ? '' : r.session).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });
});
