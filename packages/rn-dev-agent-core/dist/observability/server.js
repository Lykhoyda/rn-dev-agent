import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isPostAllowed } from './e2e-csrf.js';
const HOST = '127.0.0.1';
const __dir = dirname(fileURLToPath(import.meta.url));
export class ObservabilityServer {
    recorder;
    e2e;
    mirror;
    state;
    authority;
    server = null;
    port = 0;
    streams = new Set();
    constructor(recorder, e2e, mirror, state, authority) {
        this.recorder = recorder;
        this.e2e = e2e;
        this.mirror = mirror;
        this.state = state;
        this.authority = authority;
    }
    async start(preferredPort) {
        if (this.server)
            return { url: this.url(), port: this.port };
        const server = createServer((req, res) => this.handle(req, res));
        // SSE responses are long-lived, so disable the body timeout. But keep a
        // small headersTimeout so a connection that stalls mid-request-headers
        // (slow-loris) is closed instead of held open forever — SSE clients send
        // their headers immediately, so 5s is ample.
        server.requestTimeout = 0;
        server.headersTimeout = 5_000;
        try {
            this.port = await listen(server, preferredPort ?? 0);
        }
        catch (e) {
            if (e.code === 'EADDRINUSE' && preferredPort) {
                throw new Error(`OBSERVE_PORT_CLAIM_CONFLICT: allocated Observe port ${preferredPort} is occupied`);
            }
            throw e;
        }
        this.server = server;
        return { url: this.url(), port: this.port };
    }
    async stop() {
        const s = this.server;
        this.server = null;
        this.mirror?.shutdown();
        // Tell live SSE clients we're shutting down BEFORE yanking the sockets, so
        // the browser's EventSource closes instead of entering its auto-reconnect
        // loop (which would otherwise hammer the dead port, or silently reattach to
        // a different session started later on the same port).
        for (const res of this.streams) {
            try {
                res.write('data: {"type":"shutdown"}\n\n');
                res.end();
            }
            catch {
                /* already closed */
            }
        }
        this.streams.clear();
        if (s) {
            s.closeAllConnections?.();
            await new Promise((r) => s.close(() => r()));
        }
    }
    url() {
        return `http://${HOST}:${this.port}`;
    }
    handle(req, res) {
        if (!this.guard(req, res))
            return;
        const url = new URL(req.url ?? '/', `http://${HOST}:${this.port}`);
        const path = url.pathname;
        if (path === '/api/authority') {
            return this.json(res, 200, {
                sessionId: this.authority?.sessionId,
                claimEpoch: this.authority?.claimEpoch,
                instanceId: this.authority?.instanceId,
            });
        }
        if (path === '/api/stream')
            return this.stream(res);
        const shot = /^\/api\/screenshot\/(\d+)$/.exec(path);
        if (shot)
            return this.screenshot(Number(shot[1]), res);
        if (/^\/api\/live-screenshot\/\d+$/.test(path))
            return this.liveScreenshot(res);
        if (path === '/api/device/mirror') {
            if (req.method?.toUpperCase() !== 'GET') {
                this.json(res, 405, { error: 'method not allowed' });
                return;
            }
            return this.mirrorStream(res);
        }
        const stateKind = /^\/api\/state\/([A-Za-z]+)$/.exec(path);
        if (stateKind)
            return void this.stateRead(stateKind[1], req, res);
        if (path === '/api/e2e/run')
            return void this.e2eRun(req, res);
        if (path === '/api/e2e/runs')
            return void this.e2eListRuns(res);
        const runById = /^\/api\/e2e\/runs\/([^/]+)$/.exec(path);
        if (runById)
            return void this.e2eLoadRun(runById[1], res);
        if (path === '/api/e2e/actions')
            return void this.e2eListActions(res);
        if (path === '/api/e2e/actions/run')
            return void this.e2eRunAction(req, res);
        if (path === '/')
            return this.index(res);
        res.writeHead(404);
        res.end();
    }
    stream(res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
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
        this.streams.add(res);
        const { snapshot, detach } = this.recorder.attach((ev) => {
            // Recorder.clear() emits a terminal sentinel — end the stream cleanly.
            if (ev.type === 'cleared') {
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
            }
            catch {
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
    guard(req, res) {
        const host = (req.headers.host ?? '').toLowerCase();
        const okHost = host === `127.0.0.1:${this.port}` ||
            host === `localhost:${this.port}` ||
            host === '127.0.0.1' ||
            host === 'localhost';
        const site = req.headers['sec-fetch-site'];
        const okSite = site === undefined || site === 'same-origin' || site === 'none';
        const path = new URL(req.url ?? '/', `http://${HOST}:${this.port}`).pathname;
        const rootNavigation = path === '/' && (site === undefined || site === 'none');
        const staticAsset = !path.startsWith('/api/') && path !== '/events';
        const requestUrl = new URL(req.url ?? '/', `http://${HOST}:${this.port}`);
        const authorization = req.headers.authorization ??
            (requestUrl.searchParams.get('capability')
                ? `Bearer ${requestUrl.searchParams.get('capability')}`
                : undefined);
        const instance = req.headers['x-rn-observe-instance'] ?? requestUrl.searchParams.get('instance') ?? undefined;
        const authorized = !this.authority ||
            rootNavigation ||
            staticAsset ||
            (authorization === `Bearer ${this.authority.capability}` &&
                instance === this.authority.instanceId);
        if (!okHost || !okSite || !authorized) {
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
    liveScreenshot(res) {
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
    mirrorStream(res) {
        if (!this.mirror) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.socket?.setTimeout(0);
        res.on('error', () => {
            /* client socket reset mid-stream — manager cleanup runs on 'close' */
        });
        this.mirror.attach(res);
    }
    async stateRead(kind, req, res) {
        if (req.method?.toUpperCase() !== 'GET') {
            this.json(res, 405, { error: 'method not allowed' });
            return;
        }
        if (!this.state) {
            this.json(res, 501, { error: 'state read not configured' });
            return;
        }
        try {
            const out = await this.state.read(kind);
            if (out === null) {
                this.json(res, 404, { error: `unknown state kind: ${kind}` });
                return;
            }
            this.json(res, 200, out);
        }
        catch (err) {
            this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    index(res) {
        try {
            // __dir is dist/observability/; the SPA bundle ships at
            // dist/observability/web-dist/index.html (vite outDir).
            let html = readFileSync(join(__dir, 'web-dist', 'index.html'), 'utf8');
            if (this.authority) {
                const authorityJs = JSON.stringify({
                    capability: this.authority.capability,
                    instanceId: this.authority.instanceId,
                }).replace(/</g, '\\u003c');
                html = html.replace('</head>', `<script>window.__RN_OBSERVE_AUTHORITY__=${authorityJs}</script></head>`);
            }
            if (this.e2e) {
                // JSON.stringify + \u003c escaping: a token containing quotes or
                // </script> must never break out of the inline tag (GH #438 review).
                const tokenJs = JSON.stringify(this.e2e.token).replace(/</g, '\\u003c');
                html = html.replace('</head>', `<script>window.__E2E_CSRF__=${tokenJs}</script></head>`);
            }
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
            });
            res.end(html);
        }
        catch {
            res.writeHead(503);
            res.end('SPA bundle not built — run npm run build:web');
        }
    }
    // Bounded body read that can never become an unhandled rejection —
    // handle() fire-and-forgets the async routes, so a rejecting await here
    // would crash the process on an oversized/aborted request (GH #438 review).
    readBody(req) {
        return new Promise((resolve) => {
            let body = '';
            let bytes = 0;
            req.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > 65536) {
                    req.destroy();
                    resolve(null);
                    return;
                }
                body += chunk.toString();
            });
            req.on('end', () => resolve(body));
            req.on('error', () => resolve(null));
        });
    }
    json(res, status, obj) {
        const body = JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body);
    }
    async e2eRun(req, res) {
        if (!this.e2e) {
            this.json(res, 501, { error: 'e2e not configured' });
            return;
        }
        if (req.method?.toUpperCase() === 'GET') {
            this.json(res, 405, { error: 'method not allowed' });
            return;
        }
        const check = isPostAllowed({ method: req.method, headers: req.headers }, this.e2e.token);
        if (!check.ok) {
            this.json(res, check.status, { error: check.reason });
            return;
        }
        const body = await this.readBody(req);
        if (body === null) {
            this.json(res, 413, { error: 'body too large' });
            return;
        }
        let parsed = {};
        try {
            parsed = JSON.parse(body);
        }
        catch {
            this.json(res, 400, { error: 'invalid json body' });
            return;
        }
        try {
            const result = await this.e2e.triggerRun(parsed.pattern);
            this.json(res, 200, result);
        }
        catch (err) {
            this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    async e2eListRuns(res) {
        if (!this.e2e) {
            this.json(res, 501, { error: 'e2e not configured' });
            return;
        }
        try {
            const runs = await this.e2e.listRuns();
            this.json(res, 200, runs);
        }
        catch (err) {
            this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    async e2eLoadRun(id, res) {
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
        }
        catch (err) {
            this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    async e2eListActions(res) {
        if (!this.e2e) {
            this.json(res, 501, { error: 'e2e not configured' });
            return;
        }
        try {
            const actions = await this.e2e.listActions();
            this.json(res, 200, actions);
        }
        catch (err) {
            this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    async e2eRunAction(req, res) {
        if (!this.e2e) {
            this.json(res, 501, { error: 'e2e not configured' });
            return;
        }
        if (req.method?.toUpperCase() === 'GET') {
            this.json(res, 405, { error: 'method not allowed' });
            return;
        }
        const check = isPostAllowed({ method: req.method, headers: req.headers }, this.e2e.token);
        if (!check.ok) {
            this.json(res, check.status, { error: check.reason });
            return;
        }
        const body = await this.readBody(req);
        if (body === null) {
            this.json(res, 413, { error: 'body too large' });
            return;
        }
        let parsed = {};
        try {
            parsed = JSON.parse(body);
        }
        catch {
            this.json(res, 400, { error: 'invalid json body' });
            return;
        }
        if (!parsed.actionId || typeof parsed.actionId !== 'string' || !parsed.actionId.trim()) {
            this.json(res, 400, { error: 'actionId is required' });
            return;
        }
        try {
            const result = await this.e2e.runAction(parsed.actionId, parsed.params);
            if (result.missingParams && result.missingParams.length > 0) {
                this.json(res, 400, result);
                return;
            }
            if (!result.ok) {
                this.json(res, 500, result);
                return;
            }
            this.json(res, 200, result);
        }
        catch (err) {
            this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }
}
function listen(server, port) {
    return new Promise((resolve, reject) => {
        const onErr = (e) => {
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
