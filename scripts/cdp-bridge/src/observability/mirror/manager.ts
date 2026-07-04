// scripts/cdp-bridge/src/observability/mirror/manager.ts
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
}

export interface MirrorClient {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: Buffer | string): boolean;
  end(): void;
  on(event: 'close' | 'drain', cb: () => void): void;
}

export interface MirrorManagerDeps {
  resolveTarget(): Promise<MirrorTargetResolution>;
  createSource(target: MirrorTarget): Promise<MirrorSource>;
  pushStatus(s: MirrorStatus): void;
  graceMs?: number;
}

export const MIRROR_BOUNDARY = 'rnmirror';

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
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly graceMs: number;
  // Bumped on every teardown (grace-stop, shutdown, source exit) and at the
  // start of every pipeline attempt. Sink callbacks close over the token that
  // was current when their source was started; a mismatch means the source
  // has since been stopped/replaced, so the callback is a stale straggler
  // (e.g. IosSimctlLoopSource's documented one-trailing-onFrame-after-stop)
  // and must be a no-op rather than reviving a dead cycle.
  private cycle = 0;

  constructor(private readonly deps: MirrorManagerDeps) {
    this.graceMs = deps.graceMs ?? 5000;
  }

  attach(client: MirrorClient): void {
    client.writeHead(200, MULTIPART_HEADERS);

    const entry: ClientEntry = { client, ready: true };
    this.clients.add(entry);
    client.on('close', () => {
      this.clients.delete(entry);
      if (this.clients.size === 0) this.scheduleGrace();
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

  private scheduleGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
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
      }
    }
  }

  private async startPipeline(): Promise<void> {
    const myCycle = ++this.cycle;
    let platform: string | undefined;
    let deviceId: string | undefined;
    try {
      const resolution = await this.deps.resolveTarget();
      if (myCycle !== this.cycle) return;

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
      platform = target.platform;
      deviceId = target.deviceId;
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

      const sink: MirrorFrameSink = {
        onFrame: (frame) => {
          if (myCycle !== this.cycle) return;
          this.onSourceFrame(frame, target, source);
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
      this.source = null;
      this.state = 'error';
      this.deps.pushStatus({
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

  private onSourceExit(err?: { reason: string; hint?: string }): void {
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
