import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Recorder } from './recorder.js';
import { isPostAllowed } from './e2e-csrf.js';

const HOST = '127.0.0.1';

export interface E2eServerDeps {
  token: string;
  triggerRun: (pattern?: string) => Promise<unknown>;
  listRuns: () => Promise<unknown[]>;
  loadRun: (id: string) => Promise<unknown | null>;
}
const __dir = dirname(fileURLToPath(import.meta.url));

export class ObservabilityServer {
  private server: Server | null = null;
  private port = 0;
  private streams = new Set<ServerResponse>();
  constructor(
    private readonly recorder: Recorder,
    private readonly e2e?: E2eServerDeps,
  ) {}

  async start(preferredPort?: number): Promise<{ url: string; port: number }> {
    if (this.server) return { url: this.url(), port: this.port };
    const server = createServer((req, res) => this.handle(req, res));
    // SSE responses are long-lived, so disable the body timeout. But keep a
    // small headersTimeout so a connection that stalls mid-request-headers
    // (slow-loris) is closed instead of held open forever — SSE clients send
    // their headers immediately, so 5s is ample.
    server.requestTimeout = 0;
    server.headersTimeout = 5_000;
    try {
      this.port = await listen(server, preferredPort ?? 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && preferredPort) {
        this.port = await listen(server, 0);
      } else {
        throw e;
      }
    }
    this.server = server;
    return { url: this.url(), port: this.port };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    // Tell live SSE clients we're shutting down BEFORE yanking the sockets, so
    // the browser's EventSource closes instead of entering its auto-reconnect
    // loop (which would otherwise hammer the dead port, or silently reattach to
    // a different session started later on the same port).
    for (const res of this.streams) {
      try {
        res.write('data: {"type":"shutdown"}\n\n');
        res.end();
      } catch {
        /* already closed */
      }
    }
    this.streams.clear();
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  private url(): string {
    return `http://${HOST}:${this.port}`;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (!this.guard(req, res)) return;
    const url = req.url ?? '/';
    if (url === '/api/stream') return this.stream(res);
    const shot = /^\/api\/screenshot\/(\d+)$/.exec(url);
    if (shot) return this.screenshot(Number(shot[1]), res);
    if (/^\/api\/live-screenshot\/\d+$/.test(url)) return this.liveScreenshot(res);
    if (url === '/api/e2e/run') return void this.e2eRun(req, res);
    if (url === '/api/e2e/runs') return void this.e2eListRuns(res);
    const runById = /^\/api\/e2e\/runs\/([^/]+)$/.exec(url);
    if (runById) return void this.e2eLoadRun(runById[1], res);
    if (url === '/') return this.index(res);
    res.writeHead(404);
    res.end();
  }

  private stream(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    res.socket?.setTimeout(0);
    const write = (ev: unknown): boolean => {
      try {
        return res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        return false;
      }
    };
    this.streams.add(res);
    const { snapshot, detach } = this.recorder.attach((ev) => {
      // Recorder.clear() emits a terminal sentinel — end the stream cleanly.
      if ((ev as { type?: string }).type === 'cleared') {
        detach();
        res.end();
        return;
      }
      if (!write(ev)) {
        detach();
        res.end();
      }
    });
    write({ type: 'snapshot', events: snapshot });
    const hb = setInterval(() => {
      try {
        res.write(': hb\n\n');
      } catch {
        /* closed */
      }
    }, 15_000);
    hb.unref?.();
    res.on('close', () => {
      clearInterval(hb);
      detach();
      this.streams.delete(res);
    });
  }

  private guard(req: IncomingMessage, res: ServerResponse): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    const okHost =
      host === `127.0.0.1:${this.port}` ||
      host === `localhost:${this.port}` ||
      host === '127.0.0.1' ||
      host === 'localhost';
    const site = req.headers['sec-fetch-site'];
    const okSite = site === undefined || site === 'same-origin' || site === 'none';
    if (!okHost || !okSite) {
      res.writeHead(403);
      res.end('forbidden');
      return false;
    }
    return true;
  }

  private screenshot(seq: number, res: ServerResponse): void {
    const shot = this.recorder.getScreenshot(seq);
    if (!shot) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': shot.contentType, 'Cache-Control': 'no-store' });
    res.end(shot.buf);
  }

  private liveScreenshot(res: ServerResponse): void {
    // The <seq> in the path is a cache-busting key only — always serve the
    // current live frame; 404 only when none has been captured this session.
    const shot = this.recorder.getLiveScreenshot();
    if (!shot) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': shot.contentType, 'Cache-Control': 'no-store' });
    res.end(shot.buf);
  }

  private index(res: ServerResponse): void {
    try {
      // __dir is dist/observability/; the SPA bundle ships at
      // dist/observability/web-dist/index.html (vite outDir).
      let html = readFileSync(join(__dir, 'web-dist', 'index.html'), 'utf8');
      if (this.e2e) {
        html = html.replace('</head>', `<script>window.__E2E_CSRF__='${this.e2e.token}'</script></head>`);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(503);
      res.end('SPA bundle not built — run npm run build:web');
    }
  }

  private json(res: ServerResponse, status: number, obj: unknown): void {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  }

  private async e2eRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.e2e) {
      this.json(res, 501, { error: 'e2e not configured' });
      return;
    }
    if (req.method?.toUpperCase() === 'GET') {
      this.json(res, 405, { error: 'method not allowed' });
      return;
    }
    const check = isPostAllowed(
      { method: req.method, headers: req.headers as Record<string, string | string[] | undefined> },
      this.e2e.token,
    );
    if (!check.ok) {
      this.json(res, check.status, { error: check.reason });
      return;
    }
    let body = '';
    await new Promise<void>((resolve, reject) => {
      let bytes = 0;
      req.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) {
          req.destroy();
          reject(new Error('body too large'));
          return;
        }
        body += chunk.toString();
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
    let parsed: { pattern?: string } = {};
    try {
      parsed = JSON.parse(body) as { pattern?: string };
    } catch {
      this.json(res, 400, { error: 'invalid json body' });
      return;
    }
    try {
      const result = await this.e2e.triggerRun(parsed.pattern);
      this.json(res, 200, result);
    } catch (err) {
      this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async e2eListRuns(res: ServerResponse): Promise<void> {
    if (!this.e2e) {
      this.json(res, 501, { error: 'e2e not configured' });
      return;
    }
    try {
      const runs = await this.e2e.listRuns();
      this.json(res, 200, runs);
    } catch (err) {
      this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async e2eLoadRun(id: string, res: ServerResponse): Promise<void> {
    if (!this.e2e) {
      this.json(res, 501, { error: 'e2e not configured' });
      return;
    }
    try {
      const run = await this.e2e.loadRun(id);
      if (run === null) {
        this.json(res, 404, { error: 'run not found' });
        return;
      }
      this.json(res, 200, run);
    } catch (err) {
      this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error): void => {
      server.removeListener('error', onErr);
      reject(e);
    };
    server.once('error', onErr);
    server.listen(port, HOST, () => {
      server.removeListener('error', onErr);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}
