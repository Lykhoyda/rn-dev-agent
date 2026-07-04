// scripts/cdp-bridge/src/observability/mirror/sources.ts
import { spawn, execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JpegFrameExtractor } from './jpeg-stream.js';

export interface MirrorFrameSink {
  onFrame(frame: Buffer): void;
  /** Terminal for this attach cycle. err absent = deliberate stop. */
  onExit(err?: { reason: string; hint?: string }): void;
}

export interface MirrorSource {
  readonly pipeline: 'idb' | 'simctl' | 'screenrecord';
  readonly nominalFps: number;
  start(sink: MirrorFrameSink): void;
  /**
   * IosSimctlLoopSource aborts its in-flight capture on stop() via
   * AbortSignal, so no trailing onFrame is expected from it. Other sources
   * kill their child process synchronously; consumers should not rely on
   * any further onFrame delivery after stop() returns.
   */
  stop(): void;
}

export class RestartGate {
  private exits: number[] = [];
  constructor(
    private readonly limit = 3,
    private readonly windowMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}
  record(): boolean {
    const t = this.now();
    this.exits = this.exits.filter((e) => t - e < this.windowMs);
    this.exits.push(t);
    return this.exits.length < this.limit;
  }
}

export interface SourceOpts {
  spawnFn?: SpawnFn;
  now?: () => number;
  restartDelayMs?: number;
}

export interface LoopOpts {
  execJpeg?: (cmd: string, args: string[], signal?: AbortSignal) => Promise<Buffer>;
  now?: () => number;
  idleDelayMs?: number;
  failurePauseMs?: number;
  tmpPath?: () => string;
}

export type SpawnFn = (cmd: string, args: string[]) => SpawnedLike;

export interface SpawnedLike {
  stdout: NodeJS.ReadableStream;
  stdin?: NodeJS.WritableStream;
  stderr?: NodeJS.ReadableStream;
  on(event: 'close' | 'error', cb: (arg?: unknown) => void): void;
  kill(): void;
}

export const SIMCTL_HINT =
  'install idb for smoother mirroring (brew install idb-companion && pipx install fb-idb)';

const IDB_HINT = 'idb not found — brew install idb-companion && pipx install fb-idb';
const FFMPEG_HINT = 'ffmpeg not found — run scripts/ensure-ffmpeg.sh or brew install ffmpeg';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// setTimeout(fn, 0) is clamped and raced against the timers phase, so a 0ms
// restart delay (as used by tests) can lag an arbitrary number of event-loop
// turns behind. setImmediate fires deterministically on the very next turn,
// which is what "no delay" should mean in practice.
const scheduleAfter = (fn: () => void, delayMs: number): void => {
  if (delayMs <= 0) setImmediate(fn);
  else setTimeout(fn, delayMs);
};

const defaultSpawn: SpawnFn = (cmd, args) =>
  spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as SpawnedLike;

export async function detectIdb(execFileFn: typeof execFile = execFile): Promise<boolean> {
  return new Promise((resolve) => {
    execFileFn('which', ['idb'], { timeout: 3000 }, (err) => resolve(!err));
  });
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT';
}

export class IosIdbSource implements MirrorSource {
  readonly pipeline = 'idb' as const;
  readonly nominalFps: number;
  private active = false;
  private proc: SpawnedLike | null = null;
  private readonly spawnFn: SpawnFn;
  private readonly gate: RestartGate;
  private readonly restartDelayMs: number;

  constructor(
    private readonly udid: string,
    fps: number,
    opts: SourceOpts = {},
  ) {
    this.nominalFps = fps;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.gate = new RestartGate(3, 10_000, opts.now ?? Date.now);
    this.restartDelayMs = opts.restartDelayMs ?? 300;
  }

  start(sink: MirrorFrameSink): void {
    this.active = true;
    this.spawnOnce(sink);
  }

  private spawnOnce(sink: MirrorFrameSink): void {
    const extractor = new JpegFrameExtractor();
    const proc = this.spawnFn('idb', [
      'video-stream',
      '--udid',
      this.udid,
      '--fps',
      String(this.nominalFps),
      '--format',
      'mjpeg',
      '--compression-quality',
      '0.7',
    ]);
    this.proc = proc;
    // Undrained stderr can fill the 64KB pipe and block the child mid-write —
    // resume() discards it.
    proc.stderr?.resume();

    proc.stdout.on('data', (chunk: Buffer) => {
      if (!this.active) return;
      for (const frame of extractor.push(chunk)) {
        if (this.active) sink.onFrame(frame);
      }
    });

    proc.on('error', (err?: unknown) => {
      if (!this.active) return;
      if (isEnoent(err)) {
        this.active = false;
        sink.onExit({ reason: 'idb not found', hint: IDB_HINT });
      }
    });

    proc.on('close', () => {
      if (!this.active) return;
      if (this.gate.record()) {
        scheduleAfter(() => {
          if (this.active) this.spawnOnce(sink);
        }, this.restartDelayMs);
      } else {
        this.active = false;
        sink.onExit({ reason: 'idb video-stream keeps exiting' });
      }
    });
  }

  stop(): void {
    this.active = false;
    this.proc?.kill();
  }
}

export class IosSimctlLoopSource implements MirrorSource {
  readonly pipeline = 'simctl' as const;
  readonly nominalFps = 6;
  private active = false;
  private inFlight: AbortController | null = null;
  private readonly execJpeg: (cmd: string, args: string[], signal?: AbortSignal) => Promise<Buffer>;
  private readonly gate: RestartGate;
  private readonly idleDelayMs: number;
  private readonly failurePauseMs: number;
  private readonly tmpPath: () => string;

  constructor(
    private readonly udid: string,
    opts: LoopOpts = {},
  ) {
    this.execJpeg = opts.execJpeg ?? defaultExecJpeg;
    this.gate = new RestartGate(3, 10_000, opts.now ?? Date.now);
    this.idleDelayMs = opts.idleDelayMs ?? 25;
    this.failurePauseMs = opts.failurePauseMs ?? 500;
    this.tmpPath =
      opts.tmpPath ?? (() => join(tmpdir(), 'rn-mirror-simctl-' + process.pid + '.jpg'));
  }

  start(sink: MirrorFrameSink): void {
    this.active = true;
    void this.loop(sink);
  }

  private async loop(sink: MirrorFrameSink): Promise<void> {
    while (this.active) {
      const controller = new AbortController();
      this.inFlight = controller;
      try {
        const buf = await this.execJpeg(
          'xcrun',
          ['simctl', 'io', this.udid, 'screenshot', '--type=jpeg', this.tmpPath()],
          controller.signal,
        );
        sink.onFrame(buf);
        if (!this.active) break;
        await sleep(this.idleDelayMs);
      } catch {
        // stop() aborted the in-flight capture — that's a deliberate
        // teardown, not a capture failure, so it must not count toward
        // RestartGate or trigger a failure pause.
        if (!this.active) break;
        if (!this.gate.record()) {
          if (this.active) sink.onExit({ reason: 'simctl screenshot failing', hint: SIMCTL_HINT });
          this.active = false;
          break;
        }
        await sleep(this.failurePauseMs);
      } finally {
        this.inFlight = null;
      }
    }
  }

  stop(): void {
    this.active = false;
    this.inFlight?.abort();
  }
}

// simctl's `screenshot --type=jpeg -` is documented as writing to stdout when
// the target is `-`, but on current Xcode/simctl builds this is broken: it
// instead writes a literal file named `-` in the process cwd (and logs
// "Wrote screenshot to: <cwd>/-" on stderr); passing `/dev/stdout` errors
// outright. So the default capture path goes through a real tmp file — the
// last element of `args` is, by construction, that output path — and reads
// it back once simctl exits.
function defaultExecJpeg(cmd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  const outPath = args[args.length - 1];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10_000, signal }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      readFile(outPath)
        .then((buf) => {
          void unlink(outPath).catch(() => {});
          resolve(buf);
        })
        .catch((readErr) => {
          void unlink(outPath).catch(() => {});
          reject(readErr);
        });
    });
  });
}

export class AndroidScreenrecordSource implements MirrorSource {
  readonly pipeline = 'screenrecord' as const;
  readonly nominalFps = 25;
  private active = false;
  private adb: SpawnedLike | null = null;
  private ffmpeg: SpawnedLike | null = null;
  private readonly spawnFn: SpawnFn;
  private readonly gate: RestartGate;
  private readonly restartDelayMs: number;

  constructor(
    private readonly serial: string,
    opts: SourceOpts = {},
  ) {
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.gate = new RestartGate(3, 10_000, opts.now ?? Date.now);
    this.restartDelayMs = opts.restartDelayMs ?? 300;
  }

  start(sink: MirrorFrameSink): void {
    this.active = true;
    this.spawnCycle(sink);
  }

  private spawnCycle(sink: MirrorFrameSink): void {
    let cycleDone = false;
    const extractor = new JpegFrameExtractor();

    const adb = this.spawnFn('adb', [
      '-s',
      this.serial,
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      '--time-limit=179',
      '-',
    ]);
    const ffmpeg = this.spawnFn('ffmpeg', [
      '-loglevel',
      'error',
      '-fflags',
      'nobuffer',
      '-f',
      'h264',
      '-i',
      'pipe:0',
      '-q:v',
      '7',
      '-f',
      'mjpeg',
      'pipe:1',
    ]);
    this.adb = adb;
    this.ffmpeg = ffmpeg;
    adb.stderr?.resume();
    ffmpeg.stderr?.resume();

    if (ffmpeg.stdin) {
      // pipe() does not forward destination errors: if ffmpeg dies mid-write,
      // an unhandled EPIPE on its stdin would crash the bridge process. The
      // process-level close/error handlers own recovery; this only swallows.
      ffmpeg.stdin.on('error', () => {});
      adb.stdout.pipe(ffmpeg.stdin);
    }

    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      if (!this.active) return;
      for (const frame of extractor.push(chunk)) {
        if (this.active) sink.onFrame(frame);
      }
    });

    const killSibling = (self: 'adb' | 'ffmpeg') => {
      if (self === 'adb') ffmpeg.kill();
      else adb.kill();
    };

    adb.on('error', (err?: unknown) => {
      if (!this.active || cycleDone) return;
      if (isEnoent(err)) {
        cycleDone = true;
        this.active = false;
        killSibling('adb');
        sink.onExit({ reason: 'adb not found' });
      }
    });

    ffmpeg.on('error', (err?: unknown) => {
      if (!this.active || cycleDone) return;
      if (isEnoent(err)) {
        cycleDone = true;
        this.active = false;
        killSibling('ffmpeg');
        sink.onExit({ reason: 'ffmpeg not found', hint: FFMPEG_HINT });
      }
    });

    const onClose = (self: 'adb' | 'ffmpeg') => {
      if (!this.active || cycleDone) return;
      cycleDone = true;
      killSibling(self);
      if (this.gate.record()) {
        scheduleAfter(() => {
          if (this.active) this.spawnCycle(sink);
        }, this.restartDelayMs);
      } else {
        this.active = false;
        sink.onExit({ reason: 'screen capture pipeline keeps exiting' });
      }
    };

    adb.on('close', () => onClose('adb'));
    ffmpeg.on('close', () => onClose('ffmpeg'));
  }

  stop(): void {
    this.active = false;
    this.adb?.kill();
    this.ffmpeg?.kill();
  }
}

export async function createMirrorSource(
  target: { platform: 'ios' | 'android'; deviceId: string },
  fps: number,
): Promise<MirrorSource> {
  if (target.platform === 'android') {
    return new AndroidScreenrecordSource(target.deviceId);
  }
  const hasIdb = await detectIdb();
  return hasIdb ? new IosIdbSource(target.deviceId, fps) : new IosSimctlLoopSource(target.deviceId);
}
