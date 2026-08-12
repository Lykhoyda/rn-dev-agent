// packages/rn-dev-agent-core/src/observability/mirror/sources.ts
import { spawn, execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JpegFrameExtractor } from './jpeg-stream.js';
export class RestartGate {
    limit;
    windowMs;
    now;
    exits = [];
    constructor(limit = 3, windowMs = 10_000, now = Date.now) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.now = now;
    }
    record() {
        const t = this.now();
        this.exits = this.exits.filter((e) => t - e < this.windowMs);
        this.exits.push(t);
        return this.exits.length < this.limit;
    }
}
// GH#578: a bare `pipx install fb-idb` resolves the newest interpreter. On
// Python 3.14 that reinstalls the exact combination that crashes (fb-idb 1.1.7
// calls asyncio.get_event_loop(), removed in 3.14), so the hint the user
// follows recreates the break. Every printed command pins the interpreter.
// Mirrors the no-interpreter variant of install_command() in
// scripts/ensure-idb.sh: the interpreter install is prepended because a
// python3.14-only machine would otherwise get `pipx: No such python` — a hint
// the developer cannot follow, which is the defect this change removes.
export const IDB_INSTALL_COMMAND = 'brew install python@3.13 && brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion && pipx install --python python3.13 --force fb-idb';
export const SIMCTL_HINT = `install idb for smoother mirroring (${IDB_INSTALL_COMMAND})`;
// The probe only sees a non-zero exit, so the cause is stated as probable:
// a timeout or EACCES lands here too, and a confidently wrong diagnosis is the
// same defect as a hint that cannot be followed.
export const SIMCTL_BROKEN_IDB_HINT = 'idb is installed but did not respond successfully — most likely fb-idb 1.1.7 under Python 3.14, which removed the asyncio.get_event_loop() it needs. ' +
    'Reinstall it under a supported interpreter: pipx install --python python3.13 --force fb-idb';
export const IDB_NO_FIRST_FRAME_REASON = 'idb video-stream produced no first frame';
export const IDB_MALFORMED_FRAME_REASON = 'idb video-stream produced a malformed frame';
export const IDB_STREAM_UNHEALTHY_HINT = 'idb video-stream produced no usable frame — using simctl screenshot loop';
// Alive child ≠ ready stream. Technique considered from
// https://github.com/mobile-dev-inc/maestro @ e08f33ac (not copied):
// `DeviceStream.awaitStreamReady` in
// maestro-cli/src/main/java/maestro/cli/mcp/viewer/McpViewerServer.kt waits
// ≤30s for a `stream_ready ` line, else typed error + process cleanup;
// maestro-cli/mcp-viewer/src/main.tsx mounts <img> only when
// status==="streaming" && streamUrl. Archived mobile-dev-inc/maestro-mcp is
// historical CLI wrapping only — no live mirror. We bound JPEG SOI/EOI on the
// existing idb pipe and demote to simctl.
const DEFAULT_IDB_FIRST_FRAME_TIMEOUT_MS = 5_000;
const IDB_HINT = `idb not found — ${IDB_INSTALL_COMMAND}`;
const FFMPEG_HINT = 'ffmpeg not found — run scripts/ensure-ffmpeg.sh or brew install ffmpeg';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// setTimeout(fn, 0) is clamped and raced against the timers phase, so a 0ms
// restart delay (as used by tests) can lag an arbitrary number of event-loop
// turns behind. setImmediate fires deterministically on the very next turn,
// which is what "no delay" should mean in practice.
const scheduleAfter = (fn, delayMs) => {
    if (delayMs <= 0)
        setImmediate(fn);
    else
        setTimeout(fn, delayMs);
};
const defaultSpawn = (cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
export async function probeIdbClient(execFileFn = execFile) {
    return new Promise((resolve) => {
        // B269/B263: PATH presence is not health. fb-idb on an incompatible
        // Python (e.g. 3.14) crashes on EVERY invocation; selecting the idb tier
        // for such a client kills the mirror ("idb video-stream keeps exiting")
        // instead of using the working simctl fallback. `idb --help` initializes
        // the CLI without contacting a companion, so it separates the states.
        execFileFn('idb', ['--help'], { timeout: 3000 }, (err) => {
            if (!err)
                return resolve('ready');
            resolve(isEnoent(err) ? 'absent' : 'broken');
        });
    });
}
export async function detectIdb(execFileFn = execFile) {
    return (await probeIdbClient(execFileFn)) === 'ready';
}
function isEnoent(err) {
    return !!err && typeof err === 'object' && err.code === 'ENOENT';
}
export class IosIdbSource {
    udid;
    pipeline = 'idb';
    nominalFps;
    active = false;
    proc = null;
    firstFrameTimer = null;
    spawnFn;
    gate;
    restartDelayMs;
    firstFrameTimeoutMs;
    constructor(udid, fps, opts = {}) {
        this.udid = udid;
        this.nominalFps = fps;
        this.spawnFn = opts.spawnFn ?? defaultSpawn;
        this.gate = new RestartGate(3, 10_000, opts.now ?? Date.now);
        this.restartDelayMs = opts.restartDelayMs ?? 300;
        this.firstFrameTimeoutMs = opts.firstFrameTimeoutMs ?? DEFAULT_IDB_FIRST_FRAME_TIMEOUT_MS;
    }
    start(sink) {
        this.active = true;
        this.spawnOnce(sink);
    }
    spawnOnce(sink) {
        const extractor = new JpegFrameExtractor();
        let gotFrame = false;
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
        this.armFirstFrameTimer(sink);
        proc.stdout.on('data', (chunk) => {
            if (!this.active)
                return;
            for (const frame of extractor.push(chunk)) {
                gotFrame = true;
                this.clearFirstFrameTimer();
                if (this.active)
                    sink.onFrame(frame);
            }
            // Alive + oversized SOI without EOI is not a healthy stream. Fail before
            // the first-frame timer so a garbage producer cannot occupy the attach.
            if (this.active && extractor.overflowed && !gotFrame) {
                this.fail(sink, IDB_MALFORMED_FRAME_REASON);
            }
        });
        proc.on('error', (err) => {
            if (!this.active)
                return;
            if (isEnoent(err)) {
                this.fail(sink, 'idb not found', IDB_HINT);
            }
        });
        proc.on('close', () => {
            if (!this.active)
                return;
            this.clearFirstFrameTimer();
            if (this.gate.record()) {
                scheduleAfter(() => {
                    if (this.active)
                        this.spawnOnce(sink);
                }, this.restartDelayMs);
            }
            else {
                this.fail(sink, 'idb video-stream keeps exiting');
            }
        });
    }
    armFirstFrameTimer(sink) {
        this.clearFirstFrameTimer();
        this.firstFrameTimer = setTimeout(() => {
            this.firstFrameTimer = null;
            if (!this.active)
                return;
            this.fail(sink, IDB_NO_FIRST_FRAME_REASON, IDB_STREAM_UNHEALTHY_HINT);
        }, this.firstFrameTimeoutMs);
    }
    fail(sink, reason, hint) {
        if (!this.active)
            return;
        this.active = false;
        this.clearFirstFrameTimer();
        this.proc?.kill();
        sink.onExit({ reason, hint });
    }
    clearFirstFrameTimer() {
        if (this.firstFrameTimer) {
            clearTimeout(this.firstFrameTimer);
            this.firstFrameTimer = null;
        }
    }
    stop() {
        this.active = false;
        this.clearFirstFrameTimer();
        this.proc?.kill();
    }
}
export class IosSimctlLoopSource {
    udid;
    pipeline = 'simctl';
    nominalFps = 6;
    degradedHint;
    active = false;
    inFlight = null;
    execJpeg;
    gate;
    idleDelayMs;
    failurePauseMs;
    tmpPath;
    constructor(udid, opts = {}) {
        this.udid = udid;
        this.execJpeg = opts.execJpeg ?? defaultExecJpeg;
        this.gate = new RestartGate(3, 10_000, opts.now ?? Date.now);
        this.idleDelayMs = opts.idleDelayMs ?? 25;
        this.failurePauseMs = opts.failurePauseMs ?? 500;
        this.tmpPath =
            opts.tmpPath ?? (() => join(tmpdir(), 'rn-mirror-simctl-' + process.pid + '.jpg'));
        this.degradedHint = opts.degradedHint ?? SIMCTL_HINT;
    }
    start(sink) {
        this.active = true;
        void this.loop(sink);
    }
    async loop(sink) {
        while (this.active) {
            const controller = new AbortController();
            this.inFlight = controller;
            try {
                const buf = await this.execJpeg('xcrun', ['simctl', 'io', this.udid, 'screenshot', '--type=jpeg', this.tmpPath()], controller.signal);
                sink.onFrame(buf);
                if (!this.active)
                    break;
                await sleep(this.idleDelayMs);
            }
            catch {
                // stop() aborted the in-flight capture — that's a deliberate
                // teardown, not a capture failure, so it must not count toward
                // RestartGate or trigger a failure pause.
                if (!this.active)
                    break;
                if (!this.gate.record()) {
                    if (this.active)
                        sink.onExit({ reason: 'simctl screenshot failing', hint: this.degradedHint });
                    this.active = false;
                    break;
                }
                await sleep(this.failurePauseMs);
            }
            finally {
                this.inFlight = null;
            }
        }
    }
    stop() {
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
function defaultExecJpeg(cmd, args, signal) {
    const outPath = args[args.length - 1];
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10_000, signal }, (err) => {
            if (err) {
                reject(err);
                return;
            }
            readFile(outPath)
                .then((buf) => {
                void unlink(outPath).catch(() => { });
                resolve(buf);
            })
                .catch((readErr) => {
                void unlink(outPath).catch(() => { });
                reject(readErr);
            });
        });
    });
}
export class AndroidScreenrecordSource {
    serial;
    pipeline = 'screenrecord';
    nominalFps = 25;
    active = false;
    adb = null;
    ffmpeg = null;
    spawnFn;
    gate;
    restartDelayMs;
    constructor(serial, opts = {}) {
        this.serial = serial;
        this.spawnFn = opts.spawnFn ?? defaultSpawn;
        this.gate = new RestartGate(3, 10_000, opts.now ?? Date.now);
        this.restartDelayMs = opts.restartDelayMs ?? 300;
    }
    start(sink) {
        this.active = true;
        this.spawnCycle(sink);
    }
    spawnCycle(sink) {
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
            ffmpeg.stdin.on('error', () => { });
            adb.stdout.pipe(ffmpeg.stdin);
        }
        ffmpeg.stdout.on('data', (chunk) => {
            if (!this.active)
                return;
            for (const frame of extractor.push(chunk)) {
                if (this.active)
                    sink.onFrame(frame);
            }
        });
        const killSibling = (self) => {
            if (self === 'adb')
                ffmpeg.kill();
            else
                adb.kill();
        };
        adb.on('error', (err) => {
            if (!this.active || cycleDone)
                return;
            if (isEnoent(err)) {
                cycleDone = true;
                this.active = false;
                killSibling('adb');
                sink.onExit({ reason: 'adb not found' });
            }
        });
        ffmpeg.on('error', (err) => {
            if (!this.active || cycleDone)
                return;
            if (isEnoent(err)) {
                cycleDone = true;
                this.active = false;
                killSibling('ffmpeg');
                sink.onExit({ reason: 'ffmpeg not found', hint: FFMPEG_HINT });
            }
        });
        const onClose = (self) => {
            if (!this.active || cycleDone)
                return;
            cycleDone = true;
            killSibling(self);
            if (this.gate.record()) {
                scheduleAfter(() => {
                    if (this.active)
                        this.spawnCycle(sink);
                }, this.restartDelayMs);
            }
            else {
                this.active = false;
                sink.onExit({ reason: 'screen capture pipeline keeps exiting' });
            }
        };
        adb.on('close', () => onClose('adb'));
        ffmpeg.on('close', () => onClose('ffmpeg'));
    }
    stop() {
        this.active = false;
        this.adb?.kill();
        this.ffmpeg?.kill();
    }
}
export async function createMirrorSource(target, fps) {
    if (target.platform === 'android') {
        return new AndroidScreenrecordSource(target.deviceId);
    }
    const state = await probeIdbClient();
    if (state === 'ready')
        return new IosIdbSource(target.deviceId, fps);
    // GH#578: a crashing client is NOT "idb missing" — telling the developer to
    // install what they already installed is the loop this fix removes.
    return new IosSimctlLoopSource(target.deviceId, {
        degradedHint: state === 'broken' ? SIMCTL_BROKEN_IDB_HINT : SIMCTL_HINT,
    });
}
