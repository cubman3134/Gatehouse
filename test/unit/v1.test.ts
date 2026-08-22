import { describe, it, expect, vi } from 'vitest';
import { handleV1, SESSION_NAME, type Solution, type V1Deps } from '../../src/api/v1.js';

/** A clock that never repeats, so a swapped or mistimed timestamp pair cannot hide. */
const tickingClock = () => {
  let t = 0;
  return () => (t += 1000);
};

const solution: Solution = {
  url: 'http://example.test/',
  status: 200,
  headers: { 'content-type': 'text/html' },
  cookies: [{ name: 'cf_clearance', value: 'abc123', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: false }],
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
  response: '<html>ok</html>',
};

const deps = (over: Partial<V1Deps> = {}): V1Deps => ({
  solve: vi.fn(async () => solution),
  now: () => 1_700_000_000_000,
  version: '1.0.0',
  sessions: new Set<string>(),
  ...over,
});

describe('handleV1', () => {
  // The exact payload Allarr's CloudflareCurlHandler sends. If this stops working,
  // the whole increment is pointless.
  it('answers Allarr\'s request.get payload with the two fields it reads', async () => {
    const { httpStatus, body } = await handleV1(
      { cmd: 'request.get', url: 'http://example.test/', maxTimeout: 70000 },
      deps(),
    );

    expect(httpStatus).toBe(200);
    const r = body as any;
    expect(r.status).toBe('ok');
    expect(r.solution.userAgent).toBe(solution.userAgent);
    expect(r.solution.cookies.find((c: any) => c.name === 'cf_clearance').value).toBe('abc123');
  });

  it('emits every field FlareSolverr does', async () => {
    const { body } = await handleV1({ cmd: 'request.get', url: 'http://example.test/' }, deps());
    const r = body as any;

    expect(Object.keys(r).sort()).toEqual(
      ['endTimestamp', 'message', 'solution', 'startTimestamp', 'status', 'version'].sort(),
    );
    expect(Object.keys(r.solution).sort()).toEqual(
      ['cookies', 'headers', 'response', 'status', 'url', 'userAgent'].sort(),
    );
  });

  it('defaults maxTimeout and session when absent', async () => {
    const solve = vi.fn(async () => solution);
    await handleV1({ cmd: 'request.get', url: 'http://example.test/' }, deps({ solve }));

    expect(solve).toHaveBeenCalledWith({ cmd: 'request.get', url: 'http://example.test/', session: 'example.test', maxTimeout: 60000, postData: undefined });
  });

  it('passes an explicit session through', async () => {
    const solve = vi.fn(async () => solution);
    await handleV1({ cmd: 'request.get', url: 'http://example.test/', session: 'vimm' }, deps({ solve }));

    expect(solve).toHaveBeenCalledWith(expect.objectContaining({ session: 'vimm' }));
  });

  it('forwards postData for request.post', async () => {
    const solve = vi.fn(async () => solution);
    await handleV1({ cmd: 'request.post', url: 'http://example.test/', postData: 'a=1' }, deps({ solve }));

    expect(solve).toHaveBeenCalledWith(expect.objectContaining({ postData: 'a=1' }));
  });

  it('creates, lists and destroys sessions', async () => {
    const d = deps();
    expect((await handleV1({ cmd: 'sessions.create', session: 'vimm' }, d)).httpStatus).toBe(200);
    expect(d.sessions.has('vimm')).toBe(true);

    const listed = (await handleV1({ cmd: 'sessions.list' }, d)).body as any;
    expect(listed.sessions).toEqual(['vimm']);

    await handleV1({ cmd: 'sessions.destroy', session: 'vimm' }, d);
    expect(d.sessions.has('vimm')).toBe(false);
  });

  // Deleting the name is the cosmetic half. What the caller actually asked for is that the
  // cleared token stop working, and only the callback does that.
  it('hands sessions.destroy to the destroySession callback', async () => {
    const destroySession = vi.fn(async () => {});
    const d = deps({ destroySession, sessions: new Set(['vimm']) });

    const { httpStatus } = await handleV1({ cmd: 'sessions.destroy', session: 'vimm' }, d);

    expect(httpStatus).toBe(200);
    expect(destroySession).toHaveBeenCalledTimes(1);
    expect(destroySession).toHaveBeenCalledWith('vimm');
    expect(d.sessions.has('vimm')).toBe(false);
  });

  // The callback is optional so the pure unit path needs no Electron; a destroy without one
  // must still answer the ok shape rather than throwing on an absent dependency.
  it('answers ok for sessions.destroy when no destroySession callback is supplied', async () => {
    const d = deps({ sessions: new Set(['vimm']) });
    expect(d.destroySession).toBeUndefined();

    const { httpStatus, body } = await handleV1({ cmd: 'sessions.destroy', session: 'vimm' }, d);

    expect(httpStatus).toBe(200);
    expect((body as any).status).toBe('ok');
  });

  // `persist:` is not a partition, so there is nothing to tear down for a nameless destroy.
  it('does not invoke destroySession for an empty session name', async () => {
    const destroySession = vi.fn(async () => {});
    const { httpStatus } = await handleV1({ cmd: 'sessions.destroy' }, deps({ destroySession }));

    expect(httpStatus).toBe(200);
    expect(destroySession).not.toHaveBeenCalled();
  });

  // The command is part of a solve's identity: main.ts keys the dedupe on it, and it cannot
  // do that if /v1 never forwards it.
  it('forwards the command so a GET and a bodyless POST are distinguishable', async () => {
    const solve = vi.fn(async () => solution);
    await handleV1({ cmd: 'request.get', url: 'http://example.test/' }, deps({ solve }));
    await handleV1({ cmd: 'request.post', url: 'http://example.test/' }, deps({ solve }));

    expect((solve.mock.calls[0] as any)[0].cmd).toBe('request.get');
    expect((solve.mock.calls[1] as any)[0].cmd).toBe('request.post');
    // Same URL, same (absent) body: without `cmd` these two are indistinguishable.
    expect((solve.mock.calls[0] as any)[0].postData).toBeUndefined();
    expect((solve.mock.calls[1] as any)[0].postData).toBeUndefined();
  });

  // Allarr treats any non-2xx as "FlareSolverr is unavailable" and degrades, which is
  // exactly what we want for a request we cannot serve.
  it('returns 500 and the error shape for an unknown command', async () => {
    const { httpStatus, body } = await handleV1({ cmd: 'nonsense' }, deps());
    expect(httpStatus).toBe(500);
    expect((body as any).status).toBe('error');
    expect((body as any).message).toMatch(/nonsense/);
    // `toBeUndefined` would also pass for `{ solution: undefined }`, which serializes to a
    // present key. FlareSolverr's error shape has no `solution` key at all.
    expect('solution' in (body as any)).toBe(false);
  });

  it('returns 500 for a missing url', async () => {
    const { httpStatus, body } = await handleV1({ cmd: 'request.get' }, deps());
    expect(httpStatus).toBe(500);
    expect((body as any).message).toMatch(/url/i);
  });

  it('returns 500 for a non-object body', async () => {
    expect((await handleV1('nope', deps())).httpStatus).toBe(500);
    expect((await handleV1(null, deps())).httpStatus).toBe(500);
  });

  it('reports a solver failure as the error shape, not a crash', async () => {
    const solve = vi.fn(async () => { throw new Error('challenge never cleared'); });
    const { httpStatus, body } = await handleV1({ cmd: 'request.get', url: 'http://example.test/' }, deps({ solve }));

    expect(httpStatus).toBe(500);
    expect((body as any).message).toMatch(/challenge never cleared/);
  });

  // The handler names no field of `solution` at runtime — it forwards whatever the solver
  // returned. That pass-through is the contract, so pin it against any future reshaping.
  it('returns the solver\'s solution byte-for-byte', async () => {
    const odd = {
      url: 'https://exämple.test/path?q=%20&b=1#frag',
      status: 503,
      headers: { 'set-cookie': 'a=1, b=2', 'x-empty': '' },
      cookies: [
        { name: 'cf_clearance', value: 'a.b-c_d~e', domain: '.example.test', path: '/', expires: -1, httpOnly: true, secure: true },
        { name: '', value: '', domain: '', path: '', expires: 0, httpOnly: false, secure: false },
      ],
      userAgent: 'Mozilla/5.0 «weird» Chrome/120',
      response: '<html>\n\t<body>ünïcode &amp; \u0000 </body>\n</html>',
    } as unknown as Solution;

    const { body } = await handleV1(
      { cmd: 'request.get', url: 'http://example.test/' },
      deps({ solve: vi.fn(async () => odd) }),
    );
    const r = body as any;

    expect(r.solution).toStrictEqual(odd);
    expect(Object.keys(r)).toEqual(['status', 'message', 'startTimestamp', 'endTimestamp', 'version', 'solution']);
  });

  it('stamps a success end-timestamp after its start-timestamp', async () => {
    const { body } = await handleV1(
      { cmd: 'request.get', url: 'http://example.test/' },
      deps({ now: tickingClock() }),
    );
    const r = body as any;

    expect(r.endTimestamp).toBeGreaterThan(r.startTimestamp);
  });

  it('stamps an error end-timestamp after its start-timestamp', async () => {
    const { body } = await handleV1({ cmd: 'nonsense' }, deps({ now: tickingClock() }));
    const r = body as any;

    expect(r.endTimestamp).toBeGreaterThan(r.startTimestamp);
  });

  describe('url scheme allow-list', () => {
    // Without this, `solution.response` is the contents of the file, returned over HTTP.
    it('refuses a file: url and never reaches the solver', async () => {
      const solve = vi.fn(async () => solution);
      const { httpStatus, body } = await handleV1(
        { cmd: 'request.get', url: 'file:///C:/Users/you/.ssh/id_rsa' },
        deps({ solve }),
      );

      expect(httpStatus).toBe(500);
      expect((body as any).status).toBe('error');
      expect((body as any).message).toMatch(/file:/);
      expect('solution' in (body as any)).toBe(false);
      expect(solve).not.toHaveBeenCalled();
    });

    // A host-less URL parses fine, so this is caught by the scheme check, not by anything
    // in session derivation.
    it('refuses a mailto: url before session derivation matters', async () => {
      const solve = vi.fn(async () => solution);
      const { httpStatus, body } = await handleV1(
        { cmd: 'request.get', url: 'mailto:someone@example.test' },
        deps({ solve }),
      );

      expect(httpStatus).toBe(500);
      expect((body as any).message).toMatch(/mailto:/);
      expect(solve).not.toHaveBeenCalled();
    });

    it('refuses a url that does not parse', async () => {
      const solve = vi.fn(async () => solution);
      const { httpStatus, body } = await handleV1(
        { cmd: 'request.get', url: 'not a url at all' },
        deps({ solve }),
      );

      expect(httpStatus).toBe(500);
      expect((body as any).message).toMatch(/not a valid URL/);
      expect(solve).not.toHaveBeenCalled();
    });

    it('still accepts https', async () => {
      const solve = vi.fn(async () => solution);
      const { httpStatus } = await handleV1({ cmd: 'request.get', url: 'https://example.test/' }, deps({ solve }));

      expect(httpStatus).toBe(200);
      expect(solve).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.test/' }));
    });
  });

  describe('session names', () => {
    // `persist:<session>` becomes a directory. These are the shapes that walk out of it.
    const rejected: Array<[string, string]> = [
      ['a traversal', '../../../../etc'],
      ['a backslash', 'vimm\\..\\..\\etc'],
      ['a bare dot-dot', '..'],
      ['a single dot', '.'],
      ['a colon', 'c:evil'],
      ['65 characters', 'a'.repeat(65)],
    ];

    for (const [label, bad] of rejected) {
      it(`refuses a caller session with ${label}`, async () => {
        const solve = vi.fn(async () => solution);
        const { httpStatus, body } = await handleV1(
          { cmd: 'request.get', url: 'http://example.test/', session: bad },
          deps({ solve }),
        );

        expect(httpStatus).toBe(500);
        expect((body as any).status).toBe('error');
        expect((body as any).message).toContain(bad);
        expect('solution' in (body as any)).toBe(false);
        expect(solve).not.toHaveBeenCalled();
      });
    }

    it('accepts a 64-character session, the last legal length', async () => {
      const solve = vi.fn(async () => solution);
      const name = 'a'.repeat(64);
      const { httpStatus } = await handleV1(
        { cmd: 'request.get', url: 'http://example.test/', session: name },
        deps({ solve }),
      );

      expect(httpStatus).toBe(200);
      expect(solve).toHaveBeenCalledWith(expect.objectContaining({ session: name }));
    });

    it('refuses the same names on sessions.create and sessions.destroy', async () => {
      const d = deps();
      for (const [, bad] of rejected) {
        expect((await handleV1({ cmd: 'sessions.create', session: bad }, d)).httpStatus).toBe(500);
        expect((await handleV1({ cmd: 'sessions.destroy', session: bad }, d)).httpStatus).toBe(500);
      }
      expect([...d.sessions]).toEqual([]);
    });

    // Derived names are sanitized, not rejected — the caller never chose them. An IPv6
    // literal arrives as `[::1]`, and brackets and colons are not legal path components.
    it('sanitizes a derived session from an IPv6 host', async () => {
      const solve = vi.fn(async () => solution);
      await handleV1({ cmd: 'request.get', url: 'http://[::1]:8080/' }, deps({ solve }));

      const derived = (solve.mock.calls[0] as any)[0].session as string;
      expect(derived).toBe('---1-');
      expect(SESSION_NAME.test(derived)).toBe(true);
    });

    it('lowercases and keeps an ordinary derived host', async () => {
      const solve = vi.fn(async () => solution);
      await handleV1({ cmd: 'request.get', url: 'http://Example.TEST/' }, deps({ solve }));

      expect(solve).toHaveBeenCalledWith(expect.objectContaining({ session: 'example.test' }));
    });
  });

  it('clamps maxTimeout to five minutes', async () => {
    const solve = vi.fn(async () => solution);
    await handleV1({ cmd: 'request.get', url: 'http://example.test/', maxTimeout: 86_400_000 }, deps({ solve }));

    expect(solve).toHaveBeenCalledWith(expect.objectContaining({ maxTimeout: 300_000 }));
  });

  it('leaves a maxTimeout under the clamp alone', async () => {
    const solve = vi.fn(async () => solution);
    await handleV1({ cmd: 'request.get', url: 'http://example.test/', maxTimeout: 70_000 }, deps({ solve }));

    expect(solve).toHaveBeenCalledWith(expect.objectContaining({ maxTimeout: 70_000 }));
  });
});
