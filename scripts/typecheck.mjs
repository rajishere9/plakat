#!/usr/bin/env node
// Typechecks every TypeScript project in the repo (each has its own tsconfig.json
// extending tsconfig.base.json; sources are consumed as .ts, so nothing is emitted).
// Runs the checks in parallel and exits non-zero if any fails.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projects = ['packages/schema', 'packages/renderer', 'apps/server', 'apps/web', 'templates', 'e2e'];
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const results = await Promise.all(
  projects.map(
    (p) =>
      new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [tsc, '-p', path.join(p, 'tsconfig.json'), '--noEmit', '--pretty'], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (code) => resolve({ p, code, out, ms: Date.now() - started }));
      }),
  ),
);

let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.p} (${(r.ms / 1000).toFixed(1)}s)`);
  if (!ok) console.log(r.out);
}
console.log(failed ? `\n${failed} of ${results.length} projects have type errors` : `\nAll ${results.length} projects typecheck`);
process.exit(failed ? 1 : 0);
