import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
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
        if (s)
            await new Promise((r) => s.close(() => r()));
    }
    url() { return `http://${HOST}:${this.port}`; }
    handle(req, res) {
        if (!this.guard(req, res))
            return;
        res.writeHead(404);
        res.end();
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
