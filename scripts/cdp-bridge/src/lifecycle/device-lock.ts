import {
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const DEFAULT_STALE_MS = 90_000;

export interface DeviceLockBody {
  pid: number;
  projectRoot: string;
  platform: "ios" | "android";
  deviceId: string; // iOS UDID or Android adb serial
  appId?: string;
  startedAt: number;
  lastHeartbeat: number;
  version?: string;
}

export interface DeviceLockAcquired {
  status: "acquired";
  lockPath: string;
  /**
   * True when the lock could NOT be persisted (fs error). The session proceeds
   * UNMANAGED: cross-bridge contention protection is OFF and touch()/release()
   * are no-ops. Callers should treat this as "acquired but unprotected" and warn.
   */
  degraded?: boolean;
}
export interface DeviceLockConflict {
  status: "conflict";
  lockPath: string;
  holder: DeviceLockBody;
}
export type DeviceLockResult = DeviceLockAcquired | DeviceLockConflict;

export interface DeviceLockOptions {
  platform: "ios" | "android";
  deviceId: string;
  projectRoot?: string;
  appId?: string;
  pid?: number;
  uid?: number;
  tmpDir?: string;
  version?: string;
  clock?: () => number;
  processAlive?: (pid: number) => boolean;
  staleMs?: number;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * GH#202 Phase 1.5: a holder is reclaimable when its process is dead OR its
 * heartbeat has gone stale (a crashed bridge stops refreshing the file). This
 * is the liveness check the original daemon.lock lacked — which is why it
 * orphaned and caused #202.
 */
export function isDeviceLockStale(
  body: DeviceLockBody,
  now: number,
  processAlive: (pid: number) => boolean,
  staleMs: number,
): boolean {
  if (!processAlive(body.pid)) return true;
  return now - body.lastHeartbeat > staleMs;
}

/**
 * Persisted, UDID-scoped ownership lock for one iOS simulator. Additive to the
 * projectRoot bridge lock (lifecycle/lockfile.ts) — that one stops two windows
 * of the SAME project; this one stops two DIFFERENT projects' bridges driving
 * the SAME simulator. Acquired lazily at device_snapshot action=open once the
 * UDID is known (it is not known at bridge startup).
 */
export class DeviceLock {
  readonly lockPath: string;
  private acquired = false;
  private readonly pid: number;
  private readonly platform: "ios" | "android";
  private readonly deviceId: string;
  private readonly projectRoot: string;
  private readonly appId?: string;
  private readonly version?: string;
  private readonly clock: () => number;
  private readonly processAlive: (pid: number) => boolean;
  private readonly staleMs: number;
  private readonly tmpDir: string;

  constructor(opts: DeviceLockOptions) {
    this.platform = opts.platform;
    this.deviceId = opts.deviceId;
    this.projectRoot = opts.projectRoot ?? process.env.CLAUDE_USER_CWD ?? process.cwd();
    const uid = opts.uid ?? userInfo().uid;
    this.tmpDir = opts.tmpDir ?? tmpdir();
    this.pid = opts.pid ?? process.pid;
    this.appId = opts.appId;
    this.version = opts.version;
    this.clock = opts.clock ?? Date.now;
    this.processAlive = opts.processAlive ?? defaultProcessAlive;
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.lockPath = join(
      this.tmpDir,
      `rn-dev-agent-device-${uid}-${this.platform}-${this.deviceId}.lock`,
    );
  }

  acquire(): DeviceLockResult {
    try {
      this.create();
      return { status: "acquired", lockPath: this.lockPath };
    } catch (err) {
      if (!isEexist(err)) {
        // Infra error (not ownership contention) → fail-open, UNMANAGED.
        // `acquired` stays false so touch()/release() no-op; the caller is
        // told via `degraded` that cross-bridge protection is off this session.
        return { status: "acquired", lockPath: this.lockPath, degraded: true };
      }
    }
    const holder = this.readExisting();
    if (holder && !isDeviceLockStale(holder, this.clock(), this.processAlive, this.staleMs)) {
      return { status: "conflict", lockPath: this.lockPath, holder };
    }
    // Stale/dead/unreadable holder → reclaim. Narrow the steal-a-fresh-lock
    // window: re-read immediately before unlink and bail if a DIFFERENT,
    // now-live holder appeared since our staleness judgment. The post-unlink
    // race is still caught atomically — create('wx') throws EEXIST if another
    // bridge created a fresh lock in the gap → surfaced as conflict.
    const before = this.readExisting();
    if (
      before &&
      (holder === null || before.pid !== holder.pid || before.startedAt !== holder.startedAt) &&
      !isDeviceLockStale(before, this.clock(), this.processAlive, this.staleMs)
    ) {
      return { status: "conflict", lockPath: this.lockPath, holder: before };
    }
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* already gone */
    }
    try {
      this.create();
      return { status: "acquired", lockPath: this.lockPath };
    } catch (err) {
      if (!isEexist(err)) {
        return { status: "acquired", lockPath: this.lockPath, degraded: true };
      }
      const raced = this.readExisting();
      return raced
        ? { status: "conflict", lockPath: this.lockPath, holder: raced }
        : { status: "acquired", lockPath: this.lockPath, degraded: true };
    }
  }

  touch(): void {
    if (!this.acquired) return;
    const holder = this.readExisting();
    // Owner re-check: if another bridge reclaimed (pid changed) we must NOT
    // overwrite and resurrect a lock we no longer hold.
    if (!holder || holder.pid !== this.pid) return;
    holder.lastHeartbeat = this.clock();
    try {
      writeFileSync(this.lockPath, JSON.stringify(holder, null, 2), "utf8");
    } catch {
      /* best-effort */
    }
  }

  release(): void {
    if (!this.acquired) return;
    try {
      const holder = this.readExisting();
      if (holder?.pid === this.pid) unlinkSync(this.lockPath);
    } catch {
      /* release must never fail shutdown */
    }
    this.acquired = false;
  }

  private create(): void {
    if (!existsSync(this.tmpDir)) mkdirSync(this.tmpDir, { recursive: true });
    const fd = openSync(this.lockPath, "wx"); // atomic exclusive create — throws EEXIST if present
    try {
      const now = this.clock();
      const body: DeviceLockBody = {
        pid: this.pid,
        projectRoot: this.projectRoot,
        platform: this.platform,
        deviceId: this.deviceId,
        appId: this.appId,
        startedAt: now,
        lastHeartbeat: now,
        version: this.version,
      };
      writeSync(fd, JSON.stringify(body, null, 2));
    } finally {
      closeSync(fd);
    }
    this.acquired = true;
  }

  private readExisting(): DeviceLockBody | null {
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath, "utf8")) as unknown;
      if (!isValidBody(parsed)) return null;
      if (parsed.deviceId !== this.deviceId || parsed.platform !== this.platform) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "EEXIST";
}

function isValidBody(o: unknown): o is DeviceLockBody {
  if (typeof o !== "object" || o === null) return false;
  const b = o as Record<string, unknown>;
  return (
    typeof b.pid === "number" &&
    Number.isFinite(b.pid) &&
    (b.platform === "ios" || b.platform === "android") &&
    typeof b.deviceId === "string" &&
    b.deviceId.length > 0 &&
    typeof b.projectRoot === "string" &&
    typeof b.startedAt === "number" &&
    Number.isFinite(b.startedAt) &&
    typeof b.lastHeartbeat === "number" &&
    Number.isFinite(b.lastHeartbeat)
  );
}
