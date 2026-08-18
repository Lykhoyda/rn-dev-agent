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
    activeTarget = null;
    streamingPipeline = null;
    demoted = false;
    graceTimer = null;
    watchdogTimer = null;
    graceMs;
    firstFrameWatchdogMs;
    // Bumped on every teardown (grace-stop, shutdown, source exit) and at the
    // start of every pipeline attempt. Sink callbacks close over the token that
    // was current when their source was started; a mismatch means the source
    // has since been stopped/replaced, so the callback is a stale straggler
    // (e.g. IosSimctlLoopSource's documented one-trailing-onFrame-after-stop)
    // and must be a no-op rather than reviving a dead cycle.
    cycle = 0;
    lastStatus = null;
    constructor(deps) {
        this.deps = deps;
        this.graceMs = deps.graceMs ?? 5000;
        this.firstFrameWatchdogMs = deps.firstFrameWatchdogMs ?? 45_000;
    }
    /** Statuses are transient SSE messages; the server replays this to late subscribers. */
    currentStatus() {
        return this.lastStatus;
    }
    pushStatus(s) {
        this.lastStatus = s;
        this.deps.pushStatus(s);
    }
    armWatchdog() {
        if (this.watchdogTimer)
            clearTimeout(this.watchdogTimer);
        this.watchdogTimer = setTimeout(() => {
            this.watchdogTimer = null;
            // Only reaps a pipeline still waiting on its first frame.
            if (this.state === 'streaming' || this.state === 'idle' || this.state === 'error')
                return;
            this.cycle += 1;
            this.source?.stop();
            this.source = null;
            this.activeTarget = null;
            this.streamingPipeline = null;
            this.demoted = false;
            this.latest = null;
            this.state = 'error';
            this.pushStatus({
                type: 'mirror',
                status: 'error',
                reason: `no mirror frame within ${this.firstFrameWatchdogMs}ms`,
                hint: 'the device may be unreachable — check the session device, then reload Observe',
            });
            this.endAllClients();
        }, this.firstFrameWatchdogMs);
    }
    disarmWatchdog() {
        if (this.watchdogTimer) {
            clearTimeout(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }
    attach(client) {
        client.writeHead(200, MULTIPART_HEADERS);
        client.flushHeaders?.();
        const entry = { client, ready: true };
        this.clients.add(entry);
        client.on('close', () => {
            this.clients.delete(entry);
            // A real socket's 'close' fires a tick after onSourceExit/resolution
            // failure has already torn the pipeline down via endAllClients() and set
            // state to 'error'. Scheduling a grace-stop from that straggler close
            // would push a spurious 'idle' status later even though nothing is
            // running — the frontend reads idle as "not broken", remounts <img>,
            // re-attaches, fails again, and loops forever. Only grace-stop a
            // pipeline that is actually still live (starting/streaming).
            if (this.clients.size === 0 && this.state !== 'error')
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
            try {
                entry.ready = client.write(framePart(this.latest));
            }
            catch {
                // Destroyed socket — don't keep a dead client registered.
                this.clients.delete(entry);
                // Dropping the last (possibly only) client here must still reap the
                // pipeline — otherwise a broken reconnect leaves clients.size === 0
                // with the pipeline running forever. Same guard as the 'close'
                // handler: never grace-schedule over an 'error' teardown.
                if (this.clients.size === 0 && this.state !== 'error')
                    this.scheduleGrace();
                return;
            }
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
        this.disarmWatchdog();
        if (this.graceTimer) {
            clearTimeout(this.graceTimer);
            this.graceTimer = null;
        }
        this.source?.stop();
        this.source = null;
        this.activeTarget = null;
        this.streamingPipeline = null;
        this.demoted = false;
        this.endAllClients();
        this.latest = null;
        this.state = 'idle';
        this.lastStatus = null;
    }
    scheduleGrace() {
        if (this.graceTimer)
            clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => {
            this.graceTimer = null;
            // Error teardown (onSourceExit/resolution failure) may have landed
            // between scheduling and firing — never overwrite 'error' with 'idle';
            // the frontend treats idle as safe-to-reconnect and would retry forever.
            if (this.state === 'error')
                return;
            this.cycle += 1;
            this.disarmWatchdog();
            this.source?.stop();
            this.source = null;
            this.activeTarget = null;
            this.streamingPipeline = null;
            this.demoted = false;
            this.latest = null;
            this.state = 'idle';
            this.pushStatus({ type: 'mirror', status: 'idle' });
        }, this.graceMs);
    }
    endAllClients() {
        for (const entry of this.clients) {
            try {
                entry.client.end();
            }
            catch {
                // Ignore — client socket is already gone; still end the others.
            }
        }
        this.clients.clear();
    }
    broadcast(frame) {
        const part = framePart(frame);
        for (const entry of this.clients) {
            if (!entry.ready)
                continue;
            try {
                if (!entry.client.write(part))
                    entry.ready = false;
            }
            catch {
                // Destroyed socket — drop this client and keep serving the rest.
                this.clients.delete(entry);
                // If that was the last client, reap the pipeline the same way the
                // 'close' handler does — otherwise state stays 'streaming' with
                // zero clients and the capture runs forever.
                if (this.clients.size === 0 && this.state !== 'error')
                    this.scheduleGrace();
            }
        }
    }
    async startPipeline() {
        const myCycle = ++this.cycle;
        // Status + watchdog precede resolution: a hung resolveTarget must never
        // leave clients on a silent frameless multipart stream.
        this.armWatchdog();
        this.pushStatus({ type: 'mirror', status: 'starting' });
        let platform;
        let deviceId;
        try {
            const resolution = await this.deps.resolveTarget();
            if (myCycle !== this.cycle)
                return;
            if (!resolution.ok) {
                this.disarmWatchdog();
                this.state = 'error';
                this.pushStatus({
                    type: 'mirror',
                    status: 'error',
                    reason: resolution.reason,
                    hint: resolution.hint,
                    code: resolution.code,
                });
                this.endAllClients();
                return;
            }
            const { target } = resolution;
            platform = target.platform;
            deviceId = target.deviceId;
            this.activeTarget = target;
            this.demoted = false;
            this.streamingPipeline = null;
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
        catch (err) {
            if (myCycle !== this.cycle)
                return;
            this.cycle += 1;
            this.disarmWatchdog();
            this.source?.stop();
            this.source = null;
            this.activeTarget = null;
            this.streamingPipeline = null;
            this.demoted = false;
            this.state = 'error';
            this.pushStatus({
                type: 'mirror',
                status: 'error',
                reason: err instanceof Error ? err.message : String(err),
                platform,
                deviceId,
            });
            this.endAllClients();
        }
    }
    onSourceFrame(frame, target, source) {
        // Only a complete JPEG (SOI…EOI) counts as liveness — an empty, truncated,
        // or non-JPEG buffer must not disarm the watchdog or publish streaming.
        if (frame.length < 4 ||
            frame[0] !== 0xff ||
            frame[1] !== 0xd8 ||
            frame[frame.length - 2] !== 0xff ||
            frame[frame.length - 1] !== 0xd9) {
            return;
        }
        this.disarmWatchdog();
        this.latest = frame;
        const pipelineChanged = this.streamingPipeline !== source.pipeline;
        if (this.state !== 'streaming' || pipelineChanged) {
            this.state = 'streaming';
            this.streamingPipeline = source.pipeline;
            this.pushStatus({
                type: 'mirror',
                status: 'streaming',
                platform: target.platform,
                deviceId: target.deviceId,
                pipeline: source.pipeline,
                fps: source.nominalFps,
                hint: source.pipeline === 'simctl' ? (source.degradedHint ?? SIMCTL_HINT) : undefined,
            });
        }
        this.broadcast(frame);
    }
    onSourceExit(err) {
        const dying = this.source;
        const target = this.activeTarget;
        const canDemote = dying?.pipeline === 'idb' &&
            target?.platform === 'ios' &&
            typeof this.deps.createFallbackSource === 'function' &&
            !this.demoted &&
            // A typed exit is a terminal refusal (e.g. authority), never a capture
            // failure worth demoting around.
            !err?.code &&
            this.clients.size > 0;
        this.cycle += 1;
        dying?.stop();
        this.source = null;
        if (canDemote && target) {
            // Keep the 200 multipart client; do not push 'starting' (DevicePane
            // remounts <img> on starting and would double-attach). Internally the
            // fallback is a fresh frameless attempt: reset readiness and re-arm the
            // watchdog so a hung/frameless fallback stays bounded (GH #791).
            this.demoted = true;
            this.state = 'starting';
            // Keep the published status truthful during fallback spin-up; the pane
            // re-arms on 'starting' but attach() during a live cycle only re-registers.
            this.pushStatus({ type: 'mirror', status: 'starting' });
            this.armWatchdog();
            void this.startFallback(target, err);
            return;
        }
        this.disarmWatchdog();
        this.activeTarget = null;
        this.streamingPipeline = null;
        this.latest = null;
        this.state = 'error';
        this.pushStatus({
            type: 'mirror',
            status: 'error',
            reason: err?.reason ?? 'capture stopped',
            hint: err?.hint,
            code: err?.code,
        });
        this.endAllClients();
    }
    async startFallback(target, cause) {
        const myCycle = this.cycle;
        try {
            const source = await this.deps.createFallbackSource(target, cause);
            if (myCycle !== this.cycle) {
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
                onExit: (exitErr) => {
                    if (myCycle !== this.cycle)
                        return;
                    this.onSourceExit(exitErr);
                },
            };
            source.start(sink);
        }
        catch (err) {
            if (myCycle !== this.cycle)
                return;
            this.onSourceExit({
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
