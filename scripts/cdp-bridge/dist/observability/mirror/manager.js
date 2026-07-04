import { SIMCTL_HINT } from './sources.js';
export const MIRROR_BOUNDARY = 'rnmirror';
const MULTIPART_HEADERS = {
    'Content-Type': `multipart/x-mixed-replace; boundary=${MIRROR_BOUNDARY}`,
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
};
function framePart(frame) {
    return Buffer.concat([
        Buffer.from(`--${MIRROR_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`),
        frame,
        Buffer.from('\r\n'),
    ]);
}
export class MirrorManager {
    deps;
    clients = new Set();
    state = 'idle';
    latest = null;
    source = null;
    graceTimer = null;
    graceMs;
    // Bumped on every teardown (grace-stop, shutdown, source exit) and at the
    // start of every pipeline attempt. Sink callbacks close over the token that
    // was current when their source was started; a mismatch means the source
    // has since been stopped/replaced, so the callback is a stale straggler
    // (e.g. IosSimctlLoopSource's documented one-trailing-onFrame-after-stop)
    // and must be a no-op rather than reviving a dead cycle.
    cycle = 0;
    constructor(deps) {
        this.deps = deps;
        this.graceMs = deps.graceMs ?? 5000;
    }
    attach(client) {
        client.writeHead(200, MULTIPART_HEADERS);
        const entry = { client, ready: true };
        this.clients.add(entry);
        client.on('close', () => {
            this.clients.delete(entry);
            if (this.clients.size === 0)
                this.scheduleGrace();
        });
        client.on('drain', () => {
            entry.ready = true;
        });
        if (this.graceTimer) {
            clearTimeout(this.graceTimer);
            this.graceTimer = null;
        }
        if (this.latest) {
            entry.ready = client.write(framePart(this.latest));
        }
        if (this.state === 'idle' || this.state === 'error') {
            this.state = 'starting';
            void this.startPipeline();
        }
    }
    isStreaming() {
        return this.state === 'streaming';
    }
    shutdown() {
        this.cycle += 1;
        if (this.graceTimer) {
            clearTimeout(this.graceTimer);
            this.graceTimer = null;
        }
        this.source?.stop();
        this.source = null;
        this.endAllClients();
        this.latest = null;
        this.state = 'idle';
    }
    scheduleGrace() {
        if (this.graceTimer)
            clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => {
            this.graceTimer = null;
            this.cycle += 1;
            this.source?.stop();
            this.source = null;
            this.latest = null;
            this.state = 'idle';
            this.deps.pushStatus({ type: 'mirror', status: 'idle' });
        }, this.graceMs);
    }
    endAllClients() {
        for (const entry of this.clients) {
            entry.client.end();
        }
        this.clients.clear();
    }
    broadcast(frame) {
        const part = framePart(frame);
        for (const entry of this.clients) {
            if (!entry.ready)
                continue;
            if (!entry.client.write(part))
                entry.ready = false;
        }
    }
    async startPipeline() {
        const myCycle = ++this.cycle;
        const resolution = await this.deps.resolveTarget();
        if (myCycle !== this.cycle)
            return;
        if (!resolution.ok) {
            this.state = 'error';
            this.deps.pushStatus({
                type: 'mirror',
                status: 'error',
                reason: resolution.reason,
                hint: resolution.hint,
            });
            this.endAllClients();
            return;
        }
        const { target } = resolution;
        this.deps.pushStatus({
            type: 'mirror',
            status: 'starting',
            platform: target.platform,
            deviceId: target.deviceId,
        });
        const source = await this.deps.createSource(target);
        if (myCycle !== this.cycle) {
            // Superseded (shutdown/grace-stop) while resolving/creating — no client
            // is waiting on this attempt; stop it immediately rather than leaking it.
            source.stop();
            return;
        }
        this.source = source;
        const sink = {
            onFrame: (frame) => {
                if (myCycle !== this.cycle)
                    return;
                this.onSourceFrame(frame, target, source);
            },
            onExit: (err) => {
                if (myCycle !== this.cycle)
                    return;
                this.onSourceExit(err);
            },
        };
        source.start(sink);
    }
    onSourceFrame(frame, target, source) {
        this.latest = frame;
        if (this.state !== 'streaming') {
            this.state = 'streaming';
            this.deps.pushStatus({
                type: 'mirror',
                status: 'streaming',
                platform: target.platform,
                deviceId: target.deviceId,
                pipeline: source.pipeline,
                fps: source.nominalFps,
                hint: source.pipeline === 'simctl' ? SIMCTL_HINT : undefined,
            });
        }
        this.broadcast(frame);
    }
    onSourceExit(err) {
        this.cycle += 1;
        this.source = null;
        this.latest = null;
        this.state = 'error';
        this.deps.pushStatus({
            type: 'mirror',
            status: 'error',
            reason: err?.reason ?? 'capture stopped',
            hint: err?.hint,
        });
        this.endAllClients();
    }
}
