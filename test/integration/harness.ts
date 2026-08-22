import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Harness {
  url: string;
  stop(): Promise<void>;
}

/**
 * Spawn the real built app and wait for its ready line. Tests then drive it over HTTP,
 * exactly the way a FlareSolverr client does — no Playwright, no Electron test API, no
 * in-process shortcut that could pass while the shipped binary is broken.
 */
export function startGatehouse(env: Record<string, string> = {}): Promise<Harness> {
  const electron = require('electron') as unknown as string;

  return new Promise((resolvePromise, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      electron,
      [repoRoot],
      { env: { ...process.env, GATEHOUSE_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
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
    const stop = () =>
      new Promise<void>((r) => {
        if (child.exitCode !== null || child.signalCode !== null) { r(); return; }
        child.once('exit', () => r());
        child.kill();
      });

    // Both pipes stay drained for the child's whole life — a full pipe buffer would block it
    // — but only the pre-ready output is retained, since that is the only part any failure
    // message quotes.
    child.stdout.on('data', (b: Buffer) => {
      if (settled) return;
      out += b.toString();
      const m = /GATEHOUSE_READY (\S+)/.exec(out);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ url: m[1]!, stop });
      }
    });
    child.stderr.on('data', (b: Buffer) => { if (!settled) out += b.toString(); });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`gatehouse exited with ${code} before reporting ready. output:\n${out}`));
    });
  });
}
