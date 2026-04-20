import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { logger } from '../logger.js';
export class CDPMultiplexer {
    opts;
    httpServer = null;
    wss = null;
    hermesWs = null;
    consumers = new Map();
    nextConsumerId = 1;
    upstreamSeq = 1;
    routingTable = new Map();
    hermesBuffer = [];
    state = 'stopped';
    boundPort = null;
    constructor(opts) {
        this.opts = {
            hermesUrl: opts.hermesUrl,
            host: opts.host ?? '127.0.0.1',
            port: opts.port ?? 0,
            logTag: opts.logTag ?? 'CDP.proxy',
        };
    }
    get port() {
        return this.boundPort;
    }
    get isRunning() {
        return this.state === 'running';
    }
    get consumerCount() {
        return this.consumers.size;
    }
    async start() {
        if (this.state !== 'stopped') {
            throw new Error(`CDPMultiplexer cannot start from state '${this.state}'`);
        }
        this.state = 'starting';
        try {
            const port = await this.startConsumerServer();
            await this.connectHermes();
            this.state = 'running';
            logger.info(this.opts.logTag, `multiplexer running on ${this.opts.host}:${port}`);
            return port;
        }
        catch (err) {
            this.state = 'stopped';
            await this.cleanup();
            throw err;
        }
    }
    async stop() {
        if (this.state === 'stopped' || this.state === 'stopping')
            return;
        this.state = 'stopping';
        await this.cleanup();
        this.state = 'stopped';
        logger.info(this.opts.logTag, 'multiplexer stopped');
    }
    startConsumerServer() {
        return new Promise((resolve, reject) => {
            this.httpServer = createServer();
            this.wss = new WebSocketServer({ server: this.httpServer });
            this.wss.on('connection', (ws) => this.onConsumerConnect(ws));
            this.wss.on('error', (err) => {
                logger.warn(this.opts.logTag, `WebSocketServer error: ${err instanceof Error ? err.message : err}`);
            });
            this.httpServer.once('error', reject);
            this.httpServer.listen(this.opts.port, this.opts.host, () => {
                const addr = this.httpServer?.address();
                if (!addr) {
                    reject(new Error('httpServer.address() returned null after listen'));
                    return;
                }
                this.boundPort = addr.port;
                resolve(addr.port);
            });
        });
    }
    connectHermes() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.opts.hermesUrl);
            this.hermesWs = ws;
            const onOpen = () => {
                ws.off('error', onError);
                for (const msg of this.hermesBuffer)
                    ws.send(msg);
                this.hermesBuffer = [];
                logger.info(this.opts.logTag, `connected to upstream Hermes at ${this.opts.hermesUrl}`);
                resolve();
            };
            const onError = (err) => {
                ws.off('open', onOpen);
                reject(err);
            };
            ws.once('open', onOpen);
            ws.once('error', onError);
            ws.on('message', (data) => this.onHermesMessage(data));
            ws.on('close', (code, reason) => this.onHermesClose(code, reason.toString()));
            ws.on('error', (err) => {
                logger.warn(this.opts.logTag, `upstream WS error: ${err.message}`);
            });
        });
    }
    onConsumerConnect(ws) {
        const consumerId = this.nextConsumerId++;
        this.consumers.set(consumerId, ws);
        logger.info(this.opts.logTag, `consumer ${consumerId} connected (total: ${this.consumers.size})`);
        ws.on('message', (data) => this.onConsumerMessage(consumerId, data));
        ws.on('close', () => {
            this.consumers.delete(consumerId);
            for (const [upstreamId, entry] of this.routingTable) {
                if (entry.consumerId === consumerId)
                    this.routingTable.delete(upstreamId);
            }
            logger.info(this.opts.logTag, `consumer ${consumerId} disconnected (remaining: ${this.consumers.size})`);
        });
        ws.on('error', (err) => {
            logger.warn(this.opts.logTag, `consumer ${consumerId} WS error: ${err.message}`);
        });
    }
    onConsumerMessage(consumerId, data) {
        const raw = data.toString();
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            logger.warn(this.opts.logTag, `consumer ${consumerId} sent non-JSON, dropping`);
            return;
        }
        if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
            logger.warn(this.opts.logTag, `consumer ${consumerId} sent non-object, dropping`);
            return;
        }
        const m = msg;
        const consumerOriginalId = typeof m.id === 'number' ? m.id : null;
        if (consumerOriginalId !== null) {
            const upstreamId = this.upstreamSeq++;
            this.routingTable.set(upstreamId, { consumerId, consumerOriginalId });
            m.id = upstreamId;
        }
        this.sendToHermes(JSON.stringify(m));
    }
    onHermesMessage(data) {
        const raw = data.toString();
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            logger.warn(this.opts.logTag, 'upstream sent non-JSON, dropping');
            return;
        }
        if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
            logger.warn(this.opts.logTag, 'upstream sent non-object, dropping');
            return;
        }
        const m = msg;
        const upstreamId = typeof m.id === 'number' ? m.id : null;
        if (upstreamId === null) {
            this.broadcastToConsumers(raw);
            return;
        }
        const route = this.routingTable.get(upstreamId);
        if (!route)
            return;
        this.routingTable.delete(upstreamId);
        m.id = route.consumerOriginalId;
        const rewritten = JSON.stringify(m);
        const consumerWs = this.consumers.get(route.consumerId);
        if (consumerWs && consumerWs.readyState === WebSocket.OPEN) {
            consumerWs.send(rewritten);
        }
    }
    onHermesClose(code, reason) {
        logger.warn(this.opts.logTag, `upstream Hermes closed (code=${code}, reason='${reason}')`);
        for (const ws of this.consumers.values()) {
            try {
                ws.close(1011, 'upstream closed');
            }
            catch { /* ignore */ }
        }
        this.consumers.clear();
        this.routingTable.clear();
    }
    sendToHermes(rawMessage) {
        if (!this.hermesWs) {
            logger.warn(this.opts.logTag, 'sendToHermes called with no upstream WS');
            return;
        }
        if (this.hermesWs.readyState === WebSocket.CONNECTING) {
            this.hermesBuffer.push(rawMessage);
            return;
        }
        if (this.hermesWs.readyState !== WebSocket.OPEN) {
            logger.warn(this.opts.logTag, `upstream WS not open (state=${this.hermesWs.readyState}), dropping`);
            return;
        }
        this.hermesWs.send(rawMessage);
    }
    broadcastToConsumers(rawMessage) {
        for (const ws of this.consumers.values()) {
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(rawMessage);
                }
                catch { /* one consumer failing should not abort the others */ }
            }
        }
    }
    async cleanup() {
        if (this.hermesWs) {
            try {
                this.hermesWs.close(1000, 'proxy stopping');
            }
            catch { /* ignore */ }
            this.hermesWs = null;
        }
        for (const ws of this.consumers.values()) {
            try {
                ws.close(1001, 'proxy stopping');
            }
            catch { /* ignore */ }
        }
        this.consumers.clear();
        this.routingTable.clear();
        this.hermesBuffer = [];
        if (this.wss) {
            try {
                this.wss.close();
            }
            catch { /* ignore */ }
            this.wss = null;
        }
        if (this.httpServer) {
            await new Promise((resolve) => {
                this.httpServer?.close(() => resolve());
            });
            this.httpServer = null;
        }
        this.boundPort = null;
    }
}
/**
 * Parse an RN version object or string into a semver triple. Returns null if the shape is unrecognized.
 */
export function parseRNVersion(raw) {
    if (raw === null || raw === undefined)
        return null;
    if (typeof raw === 'string') {
        const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
        if (!match)
            return null;
        return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
    }
    if (typeof raw === 'object') {
        const v = raw;
        if (typeof v.major === 'number' && typeof v.minor === 'number' && typeof v.patch === 'number') {
            return { major: v.major, minor: v.minor, patch: v.patch };
        }
    }
    return null;
}
/**
 * RN greater than or equal to 0.85 has native multi-debugger support via metro-bridge's
 * supportsMultipleDebuggers flag, so the proxy is redundant. Returns true when the
 * version is 0.85+ (no proxy needed). Unknown / unparseable versions return false
 * (conservative default: use proxy).
 */
export function supportsNativeMultiDebugger(rnVersion) {
    const parsed = parseRNVersion(rnVersion);
    if (!parsed)
        return false;
    if (parsed.major > 0)
        return true;
    return parsed.minor >= 85;
}
