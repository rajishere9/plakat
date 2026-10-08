#!/usr/bin/env node
// `npm run dev`: starts the API server (tsx watch; embedded PGlite unless
// DATABASE_URL is set) and the Vite dev server (which proxies /api and /uploads to
// the server) side by side, with prefixed output. Ctrl+C stops both.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT ?? '8787';
const bin = (name) => path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

const procs = [
  {
    name: 'server',
    color: 36,
    cmd: bin('tsx'),
    args: ['watch', '--clear-screen=false', 'src/index.ts'],
    cwd: path.join(root, 'apps/server'),
    // Keep local state in <repo>/data regardless of the cwd (unless configured).
    env: { DATA_DIR: process.env.DATA_DIR ?? path.join(root, 'data'), PORT: port },
  },
  {
    name: 'web',
    color: 35,
    cmd: bin('vite'),
    args: [],
    cwd: path.join(root, 'apps/web'),
    env: { PLAKAT_API_URL: process.env.PLAKAT_API_URL ?? `http://localhost:${port}` },
  },
];

let shuttingDown = false;
const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, {
    cwd: p.cwd,
    env: { ...process.env, ...p.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const prefix = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
    stream.on('end', () => buf && out.write(prefix + buf + '\n'));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`${prefix}exited (${signal ?? code}); stopping the others`);
    shutdown(code ?? 1);
  });
  return child;
});

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
  Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once('exit', r))))).then(() =>
    process.exit(code),
  );
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
