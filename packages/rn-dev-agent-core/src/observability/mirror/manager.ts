// packages/rn-dev-agent-core/src/observability/mirror/manager.ts
import type { MirrorSource, MirrorFrameSink } from './sources.js';
import { SIMCTL_HINT } from './sources.js';
import type { MirrorTarget, MirrorTargetResolution } from './target.js';

export interface MirrorStatus {
  type: 'mirror';
  status: 'starting' | 'streaming' | 'error' | 'idle';
  platform?: string;
  deviceId?: string;
  pipeline?: string;
  fps?: number;
  hint?: string;
  reason?: string;
  /** GH #791: typed authority code so the UI can render an explicit blocked state. */
  code?: string;
}

export interface MirrorExitInfo {
  reason: string;
  hint?: string;
  /** GH #791: typed authority code detected at source level, forwarded verbatim. */
  code?: string;
}

export interface MirrorClient {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: Buffer | string): boolean;
  end(): void;
  on(event: 'close' | 'drain', cb: () => void): void;
  // ServerResponse buffers headers until first body write; flush so clients see the stream is live before the first frame.
  flushHeaders?(): void;
}

export interface MirrorManagerDeps {
  resolveTarget(): Promise<MirrorTargetResolution>;
  createSource(target: MirrorTarget): Promise<MirrorSource>;
  /**
   * iOS-only idb→simctl demotion. Must not re-enter createSource (that re-selects idb).
   * Absent → source-exit is a typed terminal error (bounded empty-200 failure).
   */
  createFallbackSource?(target: MirrorTarget, cause?: MirrorExitInfo): Promise<MirrorSource>;
  pushStatus(s: MirrorStatus): void;
  graceMs?: number;
  /** Bound on a frameless pipeline; must exceed the source-level idb first-frame timeout so demotion runs first. */
  firstFrameWatchdogMs?: number;
}

export const MIRROR_BOUNDARY = 'rnmirror';

const MAX_WATCHDOG_REARMS = 3;

const MULTIPART_HEADERS: Record<string, string> = {
  'Content-Type': `multipart/x-mixed-replace; boundary=${MIRROR_BOUNDARY}`,
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
};

interface ClientEntry {
  client: MirrorClient;
  ready: boolean;
}

function framePart(frame: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${MIRROR_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    ),
    frame,
    Buffer.from('\r\n'),
  ]);
}

export class MirrorManager {
  private readonly clients = new Set<ClientEntry>();
  private state: 'idle' | 'starting' | 'streaming' | 'error' = 'idle';
  private latest: Buffer | null = null;
  private source: MirrorSource | null = null;
  private activeTarget: MirrorTarget | null = null;
  private streamingPipeline: string | null = null;
  private demoted = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogRearms = 0;
  private unusableFrames = 0;
  private readonly graceMs: number;
  private readonly firstFrameWatchdogMs: number;
  // Bumped on every teardown (grace-stop, shutdown, source exit) and at the
  // start of every pipeline attempt. Sink callbacks close over the token that
  // was current when their source was started; a mismatch means the source
  // has since been stopped/replaced, so the callback is a stale straggler
  // (e.g. IosSimctlLoopSource's documented one-trailing-onFrame-after-stop)
  // and must be a no-op rather than reviving a dead cycle.
  private cycle = 0;

  private lastStatus: MirrorStatus | null = null;

  constructor(private readonly deps: MirrorManagerDeps) {
    this.graceMs = deps.graceMs ?? 5000;
    this.firstFrameWatchdogMs = deps.firstFrameWatchdogMs ?? 45_000;
  }

  /** Statuses are transient SSE messages; the server replays this to late subscribers. */
  currentStatus(): MirrorStatus | null {
    return this.lastStatus;
  }

  private pushStatus(s: MirrorStatus): void {
    this.lastStatus = s;
    this.deps.pushStatus(s);
  }

  private armWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.unusableFrames = 0;
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      // Only reaps a pipeline still waiting on its first frame.
      if (this.state === 'streaming' || this.state === 'idle' || this.state === 'error') return;
      const reason = this.framelessReason();
      const dying = this.source;
      const target = this.activeTarget;
      // A frameless idb pipeline is what the simctl fallback exists for; an
      // expired budget must demote rather than kill a recoverable mirror.
      if (target && this.canDemote(dying)) {
        this.cycle += 1;
        dying?.stop();
        this.source = null;
        this.demote(target, { reason });
        return;
      }
      this.cycle += 1;
      dying?.stop();
      this.source = null;
      this.activeTarget = null;
      this.streamingPipeline = null;
      this.demoted = false;
      this.latest = null;
      this.state = 'error';
      this.pushStatus({
        type: 'mirror',
        status: 'error',
        reason,
        hint:
          this.unusableFrames > 0
            ? 'the capture source is producing data Observe cannot decode as JPEG — check the mirror pipeline'
            : 'the device may be unreachable — check the session device, then reload Observe',
      });
      this.endAllClients();
    }, this.firstFrameWatchdogMs);
  }

  private framelessReason(): string {
    const base = `no mirror frame within ${this.firstFrameWatchdogMs}ms`;
    return this.unusableFrames > 0
      ? `${base} — ${this.unusableFrames} unusable buffer(s) discarded`
      : base;
  }

  // This bound is the source's own first-frame budget plus slack, so a source
  // that re-arms its budget must restart this one too — otherwise it reaps the
  // pipeline before the source can demote. Capped: a source that flaps forever
  // still cannot hold a frameless stream open (GH #791).
  private onSourceRestart(): void {
    if (this.state !== 'starting') return;
    if (this.watchdogRearms >= MAX_WATCHDOG_REARMS) return;
    this.watchdogRearms += 1;
    this.armWatchdog();
  }

  private canDemote(dying: MirrorSource | null, err?: MirrorExitInfo): boolean {
    return (
      dying?.pipeline === 'idb' &&
      this.activeTarget?.platform === 'ios' &&
      typeof this.deps.createFallbackSource === 'function' &&
      !this.demoted &&
      // A typed exit is a terminal refusal (e.g. authority), never a capture
      // failure worth demoting around.
      !err?.code &&
      this.clients.size > 0
    );
  }

  private demote(target: MirrorTarget, cause?: MirrorExitInfo): void {
    // Keep the 200 multipart client; do not push any status (DevicePane
    // remounts <img> on starting and would tear down the very client this
    // demotion exists to preserve). Internally the fallback is a fresh
    // frameless attempt: reset readiness and re-arm the watchdog so a
    // hung/frameless fallback still ends in a typed error (GH #791).
    this.demoted = true;
    this.state = 'starting';
    this.watchdogRearms = 0;
    this.armWatchdog();
    void this.startFallback(target, cause);
  }

  private disarmWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  attach(client: MirrorClient): void {
    client.writeHead(200, MULTIPART_HEADERS);
    client.flushHeaders?.();

    const entry: ClientEntry = { client, ready: true };
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
      if (this.clients.size === 0 && this.state !== 'error') this.scheduleGrace();
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
      } catch {
        // Destroyed socket — don't keep a dead client registered.
        this.clients.delete(entry);
        // Dropping the last (possibly only) client here must still reap the
        // pipeline — otherwise a broken reconnect leaves clients.size === 0
        // with the pipeline running forever. Same guard as the 'close'
        // handler: never grace-schedule over an 'error' teardown.
        if (this.clients.size === 0 && this.state !== 'error') this.scheduleGrace();
        return;
      }
    }

    if (this.state === 'idle' || this.state === 'error') {
      this.state = 'starting';
      void this.startPipeline();
    }
  }

  isStreaming(): boolean {
    return this.state === 'streaming';
  }

  shutdown(): void {
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

  private scheduleGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      // Error teardown (onSourceExit/resolution failure) may have landed
      // between scheduling and firing — never overwrite 'error' with 'idle';
      // the frontend treats idle as safe-to-reconnect and would retry forever.
      if (this.state === 'error') return;
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

  private endAllClients(): void {
    for (const entry of this.clients) {
      try {
        entry.client.end();
      } catch {
        // Ignore — client socket is already gone; still end the others.
      }
    }
    this.clients.clear();
  }

  private broadcast(frame: Buffer): void {
    const part = framePart(frame);
    for (const entry of this.clients) {
      if (!entry.ready) continue;
      try {
        if (!entry.client.write(part)) entry.ready = false;
      } catch {
        // Destroyed socket — drop this client and keep serving the rest.
        this.clients.delete(entry);
        // If that was the last client, reap the pipeline the same way the
        // 'close' handler does — otherwise state stays 'streaming' with
        // zero clients and the capture runs forever.
        if (this.clients.size === 0 && this.state !== 'error') this.scheduleGrace();
      }
    }
  }

  private async startPipeline(): Promise<void> {
    const myCycle = ++this.cycle;
    // The watchdog precedes resolution: a hung resolveTarget must never leave
    // clients on a silent frameless multipart stream. No status is published
    // yet — a 'starting' that a fast refusal immediately supersedes would
    // re-arm DevicePane's retry budget and loop it back into attach (GH #791).
    this.watchdogRearms = 0;
    this.armWatchdog();
    let platform: string | undefined;
    let deviceId: string | undefined;
    try {
      const resolution = await this.deps.resolveTarget();
      if (myCycle !== this.cycle) return;

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
      this.pushStatus({
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

      const sink: MirrorFrameSink = {
        onFrame: (frame) => {
          if (myCycle !== this.cycle) return;
          this.onSourceFrame(frame, target, source);
        },
        onRestart: () => {
          if (myCycle !== this.cycle) return;
          this.onSourceRestart();
        },
        onExit: (err) => {
          if (myCycle !== this.cycle) return;
          this.onSourceExit(err);
        },
      };
      source.start(sink);
    } catch (err) {
      if (myCycle !== this.cycle) return;
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

  private onSourceFrame(frame: Buffer, target: MirrorTarget, source: MirrorSource): void {
    // Only a complete JPEG (SOI…EOI) counts as liveness — an empty, truncated,
    // or non-JPEG buffer must not disarm the watchdog or publish streaming.
    if (
      frame.length < 4 ||
      frame[0] !== 0xff ||
      frame[1] !== 0xd8 ||
      frame[frame.length - 2] !== 0xff ||
      frame[frame.length - 1] !== 0xd9
    ) {
      this.unusableFrames += 1;
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

  private onSourceExit(err?: MirrorExitInfo): void {
    const dying = this.source;
    const target = this.activeTarget;
    const canDemote = this.canDemote(dying, err);

    this.cycle += 1;
    dying?.stop();
    this.source = null;

    if (canDemote && target) {
      this.demote(target, err);
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

  private async startFallback(target: MirrorTarget, cause?: MirrorExitInfo): Promise<void> {
    const myCycle = this.cycle;
    try {
      const source = await this.deps.createFallbackSource!(target, cause);
      if (myCycle !== this.cycle) {
        source.stop();
        return;
      }
      this.source = source;
      const sink: MirrorFrameSink = {
        onFrame: (frame) => {
          if (myCycle !== this.cycle) return;
          this.onSourceFrame(frame, target, source);
        },
        onExit: (exitErr) => {
          if (myCycle !== this.cycle) return;
          this.onSourceExit(exitErr);
        },
      };
      source.start(sink);
    } catch (err) {
      if (myCycle !== this.cycle) return;
      this.onSourceExit({
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
