import { describe, it, expect, vi } from 'vitest';
import { handleV1, type Solution, type V1Deps } from '../../src/api/v1.js';

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

    expect(solve).toHaveBeenCalledWith({ url: 'http://example.test/', session: 'example.test', maxTimeout: 60000, postData: undefined });
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

  // Allarr treats any non-2xx as "FlareSolverr is unavailable" and degrades, which is
  // exactly what we want for a request we cannot serve.
  it('returns 500 and the error shape for an unknown command', async () => {
    const { httpStatus, body } = await handleV1({ cmd: 'nonsense' }, deps());
    expect(httpStatus).toBe(500);
    expect((body as any).status).toBe('error');
    expect((body as any).message).toMatch(/nonsense/);
    expect((body as any).solution).toBeUndefined();
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
});
