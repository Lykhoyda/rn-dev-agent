import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Recorder } from './recorder.js';

const HOST = '127.0.0.1';
const __dir = dirname(fileURLToPath(import.meta.url));

export class ObservabilityServer {
  private server: Server | null = null;
  private port = 0;
  constructor(private readonly recorder: Recorder) {}

  async start(preferredPort?: number): Promise<{ url: string; port: number }> {
    if (this.server) return { url: this.url(), port: this.port };
    const server = createServer((req, res) => this.handle(req, res));
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    try {
      this.port = await listen(server, preferredPort ?? 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && preferredPort) {
        this.port = await listen(server, 0);
      } else { throw e; }
    }
    this.server = server;
    return { url: this.url(), port: this.port };
  }

  async stop(): Promise<void> {
    const s = this.server; this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private url(): string { return `http://${HOST}:${this.port}`; }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (!this.guard(req, res)) return;
    if (req.url === '/api/stream') return this.stream(res);
    res.writeHead(404); res.end();
  }

  private stream(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.flushHeaders?.();
    res.socket?.setTimeout(0);
    const write = (ev: unknown): boolean => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const { snapshot, detach } = this.recorder.attach((ev) => { if (!write(ev)) { detach(); res.end(); } });
    write({ type: 'snapshot', events: snapshot });
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 15_000);
    hb.unref?.();
    res.on('close', () => { clearInterval(hb); detach(); });
  }

  private guard(req: IncomingMessage, res: ServerResponse): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    const okHost = host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
      || host === '127.0.0.1' || host === 'localhost';
    const site = req.headers['sec-fetch-site'];
    const okSite = site === undefined || site === 'same-origin' || site === 'none';
    if (!okHost || !okSite) { res.writeHead(403); res.end('forbidden'); return false; }
    return true;
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error): void => { server.removeListener('error', onErr); reject(e); };
    server.once('error', onErr);
    server.listen(port, HOST, () => {
      server.removeListener('error', onErr);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}
