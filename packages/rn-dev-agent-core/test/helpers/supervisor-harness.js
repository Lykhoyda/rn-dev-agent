// Line-delimited JSON-RPC harness around a spawned dist/supervisor.js.
// Extracted from gh-264-supervisor-respawn.test.js (GH #432) so the
// packaged-artifact smoke test and scripts/update-tool-registry.mjs share it.
// Hardened over the original (Codex plan review): stderr is captured, and
// nextLine() rejects early with the stderr tail when the supervisor dies
// before answering — a packaged boot crash must surface its diagnostic, not
// a generic timeout.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SUPERVISOR = resolve(__dirname, '../../dist/supervisor.js');

export function startSupervisor({
  supervisorPath = DEFAULT_SUPERVISOR,
  workerPath,
  env = {},
  cwd,
  args = [],
  lineTimeoutMs = 15_000,
} = {}) {
  const child = spawn(process.execPath, [supervisorPath, '--no-lock', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: {
      ...process.env,
      ...(workerPath ? { RN_BRIDGE_WORKER_PATH: workerPath } : {}),
      ...env,
    },
  });
  const stderrChunks = [];
  child.stderr.on('data', (c) => stderrChunks.push(c.toString('utf8')));
  const stderrText = () => stderrChunks.join('');
  // A dead supervisor's stdin raises EPIPE on write; without a handler that
  // crashes the test file instead of surfacing deathError via nextLine().
  child.stdin.on('error', () => {});
  let buf = '';
  let exited = null;
  const pendingLines = [];
  const waiters = []; // { resolve, reject, timer }
  const deathError = () =>
    new Error(
      `supervisor exited (code=${exited.code} signal=${exited.signal}) before answering; stderr tail:\n${stderrText().slice(-2000)}`,
    );
  // setEncoding makes Node's StringDecoder hold partial UTF-8 sequences — a
  // multi-byte codepoint split across 'data' chunks must not corrupt the JSON
  // (same rationale as the supervisor's own stdin handling).
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      if (!p.length) continue;
      const w = waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(p);
      } else pendingLines.push(p);
    }
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    while (waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.reject(deathError());
    }
  });
  const nextLine = () =>
    new Promise((resolveLine, reject) => {
      const queued = pendingLines.shift();
      if (queued !== undefined) return resolveLine(queued);
      if (exited) return reject(deathError());
      const entry = { resolve: resolveLine, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i !== -1) waiters.splice(i, 1);
        reject(
          new Error(
            `timeout (${lineTimeoutMs}ms) waiting for supervisor stdout line; stderr tail:\n${stderrText().slice(-2000)}`,
          ),
        );
      }, lineTimeoutMs);
      waiters.push(entry);
    });
  let id = 0;
  const send = (method, params = {}) => {
    id += 1;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  };
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { child, nextLine, send, notify, stderrText };
}
