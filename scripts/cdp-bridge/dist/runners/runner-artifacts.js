// GH #382 (Story 01): prebuilt runner artifacts — resolve a runner from a
// verified cache/download before falling back to the multi-minute local build.
//
// The resolution is fail-open: any problem (offline, 404, checksum mismatch,
// corrupt/unsafe zip, oversize, missing manifest) falls through to `build-local`
// with a diagnostic note. A broken artifact can only make a session slower,
// never blocked.
//
// Split by design: pure decision functions (no IO — unit-tested directly) and an
// injected `ArtifactDeps` IO port (`defaultArtifactDeps()` in production; fakes in
// tests). Mirrors resolveRunnerStartPlan / resolveAndroidInstallAction style.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export const RUNNER_REPO = 'Lykhoyda/rn-dev-agent';
export const ANDROID_APP_APK_NAME = 'app-debug.apk';
export const ANDROID_TEST_APK_NAME = 'app-debug-androidTest.apk';
const DOWNLOAD_TIMEOUT_MS = 60_000;
// The manifest records exact byte counts; a small slack absorbs boundary/overhead
// without allowing a surprise-sized asset through.
const DOWNLOAD_SIZE_SLACK_BYTES = 65_536;
// --- Pure helpers (no IO) ---
export function resolveArtifactDecision(input) {
    if (input.envOverride)
        return 'build-local';
    if (!input.hasManifestAssets)
        return 'build-local';
    if (input.cacheValid)
        return 'cache';
    return 'download';
}
// Reject zip entries that would escape the extraction dir (path traversal /
// absolute paths / Windows drive or UNC roots).
export function assertNoTraversal(entryNames) {
    for (const name of entryNames) {
        const norm = name.replace(/\\/g, '/');
        if (name.startsWith('/') ||
            name.startsWith('\\') ||
            /^[A-Za-z]:/.test(name) ||
            norm.split('/').includes('..')) {
            throw new Error(`unsafe zip entry (path traversal): ${name}`);
        }
    }
}
export function verifyChecksums(expected, actualByName) {
    const mismatched = [];
    const missing = [];
    for (const a of expected) {
        const got = actualByName[a.name];
        if (got === undefined)
            missing.push(a.name);
        else if (got !== a.sha256)
            mismatched.push(a.name);
    }
    return { ok: mismatched.length === 0 && missing.length === 0, mismatched, missing };
}
export function releaseAssetUrl(repo, version, assetName) {
    return `https://github.com/${repo}/releases/download/v${version}/${assetName}`;
}
export function cacheDirFor(home, platformOS, version, platform) {
    const root = platformOS === 'darwin'
        ? join(home, 'Library', 'Caches', 'rn-dev-agent', 'runners')
        : join(home, '.cache', 'rn-dev-agent', 'runners');
    return join(root, version, platform);
}
export function formatArtifactSize(bytes) {
    return `~${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}
export function artifactProvenanceToState(p) {
    return p === 'build-local' ? 'local' : 'prebuilt';
}
async function acquireArtifact(platform, version, deps, extractedOk) {
    if (deps.env.RN_RUNNER_BUILD === 'local')
        return { provenance: 'build-local' };
    const manifest = deps.readManifest();
    if (!version || !manifest || manifest.version !== version)
        return { provenance: 'build-local' };
    const assets = manifest.assets?.[platform] ?? [];
    if (assets.length === 0)
        return { provenance: 'build-local' };
    const cacheDir = deps.cacheDir(version, platform);
    const productsDir = join(cacheDir, 'products');
    // Cache is valid only when every zip is present with a matching SHA-256 AND the
    // extracted runner products are usable — re-hashed each time (artifacts are MBs).
    const actualByName = {};
    let allZipsPresent = true;
    for (const a of assets) {
        const zp = join(cacheDir, a.name);
        if (deps.existsSync(zp)) {
            try {
                actualByName[a.name] = deps.sha256File(zp);
            }
            catch {
                allZipsPresent = false;
            }
        }
        else {
            allZipsPresent = false;
        }
    }
    const cacheValid = allZipsPresent && verifyChecksums(assets, actualByName).ok && extractedOk(productsDir);
    const decision = resolveArtifactDecision({
        envOverride: false,
        hasManifestAssets: true,
        cacheValid,
    });
    if (decision === 'cache')
        return { provenance: 'cache', productsDir };
    // decision === 'download' — verify BEFORE unzip, unzip with a traversal guard.
    try {
        deps.mkdirp(cacheDir);
        for (const a of assets) {
            const zp = join(cacheDir, a.name);
            await deps.fetchToFile(releaseAssetUrl(RUNNER_REPO, version, a.name), zp, {
                timeoutMs: DOWNLOAD_TIMEOUT_MS,
                maxBytes: a.bytes + DOWNLOAD_SIZE_SLACK_BYTES,
            });
            const got = deps.sha256File(zp);
            if (got !== a.sha256) {
                throw new Error(`checksum mismatch for ${a.name} (expected ${a.sha256}, got ${got})`);
            }
            deps.unzip(zp, productsDir);
        }
        if (!extractedOk(productsDir)) {
            throw new Error('prebuilt archive missing expected runner products after unzip');
        }
        const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
        return {
            provenance: 'downloaded',
            productsDir,
            note: `downloaded prebuilt runner (${formatArtifactSize(totalBytes)})`,
        };
    }
    catch (err) {
        try {
            deps.rm(productsDir);
        }
        catch {
            /* best-effort cleanup of a partial extract */
        }
        const msg = err instanceof Error ? err.message : String(err);
        return {
            provenance: 'build-local',
            note: `prebuilt runner unavailable (${msg}); building locally`,
        };
    }
}
function iosExtractedOk(deps) {
    return (productsDir) => deps.listFiles(join(productsDir, 'Build', 'Products')).some((f) => f.endsWith('.xctestrun'));
}
function androidExtractedOk(deps) {
    return (productsDir) => deps.existsSync(join(productsDir, ANDROID_APP_APK_NAME)) &&
        deps.existsSync(join(productsDir, ANDROID_TEST_APK_NAME));
}
export async function resolveIosRunnerArtifacts(version, localDerivedDataPath, deps = defaultArtifactDeps()) {
    const r = await acquireArtifact('ios', version, deps, iosExtractedOk(deps));
    const derivedDataPath = r.provenance === 'build-local' ? localDerivedDataPath : r.productsDir;
    return { provenance: r.provenance, derivedDataPath, note: r.note };
}
export async function resolveAndroidRunnerArtifacts(version, local, deps = defaultArtifactDeps()) {
    const r = await acquireArtifact('android', version, deps, androidExtractedOk(deps));
    if (r.provenance === 'build-local') {
        return { provenance: r.provenance, appApk: local.appApk, testApk: local.testApk, note: r.note };
    }
    return {
        provenance: r.provenance,
        appApk: join(r.productsDir, ANDROID_APP_APK_NAME),
        testApk: join(r.productsDir, ANDROID_TEST_APK_NAME),
        note: r.note,
    };
}
// --- Production IO ports ---
function readCommittedManifest() {
    try {
        // Mirrors getPluginVersion()'s path resolution: 4 levels up from the compiled
        // runners dir is the plugin root, where CI commits runner-manifest.json.
        const manifestPath = join(import.meta.dirname, '..', '..', '..', '..', 'runner-manifest.json');
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (parsed && typeof parsed === 'object' && parsed.assets)
            return parsed;
        return null;
    }
    catch {
        return null;
    }
}
function sha256File(p) {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
}
async function fetchToFile(url, dest, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        if (!res.ok)
            throw new Error(`HTTP ${res.status} fetching ${url}`);
        if (!res.body)
            throw new Error(`empty response body for ${url}`);
        mkdirSync(dirname(dest), { recursive: true });
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > opts.maxBytes) {
                throw new Error(`artifact exceeds size cap (${opts.maxBytes} bytes)`);
            }
            chunks.push(Buffer.from(value));
        }
        writeFileSync(dest, Buffer.concat(chunks));
    }
    finally {
        clearTimeout(timer);
    }
}
function unzipWithGuard(zipPath, destDir) {
    const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf-8' });
    const entries = listing
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    assertNoTraversal(entries);
    mkdirSync(destDir, { recursive: true });
    execFileSync('unzip', ['-o', '-qq', zipPath, '-d', destDir], { stdio: 'ignore' });
}
export function defaultArtifactDeps() {
    return {
        env: process.env,
        readManifest: readCommittedManifest,
        cacheDir: (version, platform) => cacheDirFor(homedir(), process.platform, version, platform),
        existsSync,
        sha256File,
        listFiles: (dir) => {
            try {
                return readdirSync(dir);
            }
            catch {
                return [];
            }
        },
        fetchToFile,
        unzip: unzipWithGuard,
        mkdirp: (p) => {
            mkdirSync(p, { recursive: true });
        },
        rm: (p) => {
            rmSync(p, { recursive: true, force: true });
        },
    };
}
