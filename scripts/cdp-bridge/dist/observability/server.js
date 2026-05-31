import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HOST = '127.0.0.1';
const __dir = dirname(fileURLToPath(import.meta.url));
export class ObservabilityServer {
    recorder;
    server = null;
    port = 0;
    constructor(recorder) {
        this.recorder = recorder;
    }
    async start(preferredPort) {
        if (this.server)
            return { url: this.url(), port: this.port };
        const server = createServer((req, res) => this.handle(req, res));
        server.requestTimeout = 0;
        server.headersTimeout = 0;
        try {
            this.port = await listen(server, preferredPort ?? 0);
        }
        catch (e) {
            if (e.code === 'EADDRINUSE' && preferredPort) {
                this.port = await listen(server, 0);
            }
            else {
                throw e;
            }
        }
        this.server = server;
        return { url: this.url(), port: this.port };
    }
    async stop() {
        const s = this.server;
        this.server = null;
        if (s) {
            s.closeAllConnections?.();
            await new Promise((r) => s.close(() => r()));
        }
    }
    url() { return `http://${HOST}:${this.port}`; }
    handle(req, res) {
        if (!this.guard(req, res))
            return;
        const url = req.url ?? '/';
        if (url === '/api/stream')
            return this.stream(res);
        const shot = /^\/api\/screenshot\/(\d+)$/.exec(url);
        if (shot)
            return this.screenshot(Number(shot[1]), res);
        if (url === '/')
            return this.index(res);
        res.writeHead(404);
        res.end();
    }
    stream(res) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.flushHeaders?.();
        res.socket?.setTimeout(0);
        const write = (ev) => {
            try {
                return res.write(`data: ${JSON.stringify(ev)}\n\n`);
            }
            catch {
                return false;
            }
        };
        const { snapshot, detach } = this.recorder.attach((ev) => { if (!write(ev)) {
            detach();
            res.end();
        } });
        write({ type: 'snapshot', events: snapshot });
        const hb = setInterval(() => { try {
            res.write(': hb\n\n');
        }
        catch { /* closed */ } }, 15_000);
        hb.unref?.();
        res.on('close', () => { clearInterval(hb); detach(); });
    }
    guard(req, res) {
        const host = (req.headers.host ?? '').toLowerCase();
        const okHost = host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
            || host === '127.0.0.1' || host === 'localhost';
        const site = req.headers['sec-fetch-site'];
        const okSite = site === undefined || site === 'same-origin' || site === 'none';
        if (!okHost || !okSite) {
            res.writeHead(403);
            res.end('forbidden');
            return false;
        }
        return true;
    }
    screenshot(seq, res) {
        const shot = this.recorder.getScreenshot(seq);
        if (!shot) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': shot.contentType, 'Cache-Control': 'no-store' });
        res.end(shot.buf);
    }
    index(res) {
        try {
            // __dir is dist/observability/; the SPA bundle ships at
            // dist/observability/web-dist/index.html (vite outDir).
            const html = readFileSync(join(__dir, 'web-dist', 'index.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        }
        catch {
            res.writeHead(503);
            res.end('SPA bundle not built — run npm run build:web');
        }
    }
}
function listen(server, port) {
    return new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener('error', onErr); reject(e); };
        server.once('error', onErr);
        server.listen(port, HOST, () => {
            server.removeListener('error', onErr);
            const addr = server.address();
            resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
    });
}
