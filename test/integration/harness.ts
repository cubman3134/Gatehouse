import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Harness {
  url: string;
  stop(): Promise<void>;
}

/** Newest mtime under a directory tree, or 0 if it does not exist. */
function newestTsMtime(dir: string): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestTsMtime(full));
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * `package.json` points `main` at `dist/main.js` and we spawn `electron .`, so the suite
 * tests whatever was last compiled. On a fresh clone that is nothing (30s of timeout and a
 * confusing failure); after an edit with no rebuild it is the *previous* code, which is far
 * worse — the suite goes green against a binary that does not contain the change under test.
 * `npm test` runs tsc first; this catches anyone running vitest directly.
 */
function assertFreshBuild(): void {
  const built = join(repoRoot, 'dist', 'main.js');
  let builtAt: number;
  try {
    builtAt = statSync(built).mtimeMs;
  } catch {
    throw new Error(
      `dist/main.js is missing — the integration suite runs the compiled app, not the sources. ` +
        `Run \`npm run build\` (or \`npm test\`, which builds first) before running vitest directly.`,
    );
  }

  const newestSource = newestTsMtime(join(repoRoot, 'src'));
  if (newestSource > builtAt) {
    throw new Error(
      `dist/main.js is older than src/ — the integration suite would test the previously ` +
        `compiled code and pass while your change is not in it. Run \`npm run build\` ` +
        `(or \`npm test\`, which builds first).`,
    );
  }
}

/**
 * Spawn the real built app and wait for its ready line. Tests then drive it over HTTP,
 * exactly the way a FlareSolverr client does — no Playwright, no Electron test API, no
 * in-process shortcut that could pass while the shipped binary is broken.
 */
export function startGatehouse(env: Record<string, string> = {}): Promise<Harness> {
  assertFreshBuild();
  const electron = require('electron') as unknown as string;

  // The developer's shell is not part of the fixture: an ambient GATEHOUSE_TOKEN or
  // GATEHOUSE_BIND would quietly change what these tests exercise. Blank every GATEHOUSE_*
  // key inherited from the environment, then apply the test's own overrides on top.
  const blanked: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(blanked)) if (key.startsWith('GATEHOUSE_')) delete blanked[key];

  return new Promise((resolvePromise, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      electron,
      [repoRoot],
      { env: { ...blanked, GATEHOUSE_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;

    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`gatehouse did not report ready within 30s. stdout:\n${out}`));
    }, 30_000);

    // `exit` fires once and is not replayed, so a child that already died would leave a
    // listener waiting forever and hang the afterAll hook rather than failing it. Check the
    // recorded exit first. Killing the Electron main process takes its GPU/renderer/utility
    // children with it — they live in its job object — so this really does reap the tree.
    // A child that ignores the polite kill is escalated rather than hanging the suite.
    const stop = () =>
      new Promise<void>((r) => {
        if (child.exitCode !== null || child.signalCode !== null) { r(); return; }
        const hard = setTimeout(() => { child.kill('SIGKILL'); }, 5_000);
        child.once('exit', () => { clearTimeout(hard); r(); });
        child.kill();
      });

    // Both pipes stay drained for the child's whole life — a full pipe buffer would block it
    // — but only the pre-ready output is retained, since that is the only part any failure
    // message quotes.
    child.stdout.on('data', (b: Buffer) => {
      if (settled) return;
      out += b.toString();
      // The line terminator is part of the pattern: a chunk that splits mid-URL would
      // otherwise match and hand back a truncated base URL.
      const m = /GATEHOUSE_READY (\S+)\r?\n/.exec(out);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ url: m[1]!, stop });
      }
    });
    child.stderr.on('data', (b: Buffer) => { if (!settled) out += b.toString(); });
    // A spawn failure (ENOENT, EACCES) emits 'error' and nothing else. Without this the
    // error is rethrown out of the child process machinery and kills the vitest worker
    // instead of failing the test that asked for the harness.
    child.once('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn electron: ${e.message}`));
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`gatehouse exited with ${code} before reporting ready. output:\n${out}`));
    });
  });
}
