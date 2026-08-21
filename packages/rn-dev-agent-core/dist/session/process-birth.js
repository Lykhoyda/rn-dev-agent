import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, chmodSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTrustedSystemExecutable, } from '../util/trusted-system-executable.js';
const DARWIN_HELPER_MANIFEST = {
    sourceSha256: '5cafc275ab929026203e64527f993cd77e2854f1697cdb419b7d901293e1bc48',
    recipeSha256: 'a1293ae1f70a5da3a4ea9b1b79a095a5f182f7cb39e37521abe87cb1864f625b',
    stableBinarySha256: 'e5dffbe66f7fa52f8e2554fb397b4b44000d8c092feff35e0c42f5f3e0150c3f',
    binarySha256: 'dd8346dab2ccb6e3ce11840bbca5f8ea2f4cbd95efae34ddb130f98824a065aa',
    cdhashes: [
        '0471a3583ce2363ee96afe3e85951dd5fd154dec',
        '1998527647f4fef05eae6007fe7a1f945aa7c54d',
    ],
};
const LINUX_PUBLICATION_HELPER_SHA256 = {
    x64: '3851cbf2d01caf77b282f477365613e6d903caf1aff88ea99e8d855eab9bacfb',
    arm64: '76ba6597b964d6541ec2657195ee515728f9a1270636275b3a55d110267f34da',
};
function defaultRun(command, args) {
    try {
        return execFileSync(command, [...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2_000,
        });
    }
    catch (error) {
        if (command === '/bin/ps' &&
            typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            error.status === 1) {
            return '';
        }
        throw error;
    }
}
const VERIFIED_HELPER_SCRIPT = `
set -euo pipefail
helper_pid=
cleanup() {
  if [[ -n "$helper_pid" ]]; then
    /bin/kill -CONT "$helper_pid" 2>/dev/null || true
    /bin/kill -KILL "$helper_pid" 2>/dev/null || true
    wait "$helper_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM
coproc "$1" "$2" --hold
helper_pid=$!
IFS= read -r -p result
attempt=0
state=
while (( attempt < 100 )); do
  state=$(/bin/ps -p "$helper_pid" -o state= 2>/dev/null || true)
  [[ "$state" == T* ]] && break
  [[ -z "$state" || "$state" == Z* ]] && exit 1
  /bin/sleep 0.01
  (( attempt += 1 ))
done
[[ "$state" == T* ]]
/usr/bin/codesign --verify --strict "-R=$3" "$1" >/dev/null 2>&1
/usr/bin/codesign --verify --strict "+$helper_pid" >/dev/null 2>&1
live_cdhash=$(
  /usr/bin/codesign --display --verbose=4 "+$helper_pid" 2>&1 |
    /usr/bin/awk -F= '/^CDHash=/{print tolower($2); exit}'
)
[[ "$live_cdhash" != *[^0-9a-f]* ]]
[[ "\${#live_cdhash}" == 40 ]]
expected_cdhash="H\\"\${live_cdhash}\\""
[[ "$3" == *"$expected_cdhash"* ]]
/bin/kill -CONT "$helper_pid"
attempt=0
while (( attempt < 100 )); do
  state=$(/bin/ps -p "$helper_pid" -o state= 2>/dev/null || true)
  [[ -z "$state" || "$state" == Z* ]] && break
  /bin/sleep 0.01
  (( attempt += 1 ))
done
[[ -z "$state" || "$state" == Z* ]]
wait "$helper_pid" 2>/dev/null || true
helper_pid=
trap - EXIT HUP INT TERM
print -r -- "$result"
`;
function defaultRunVerifiedHelper(path, pid, requirement) {
    return execFileSync('/bin/zsh', ['-f', '-c', VERIFIED_HELPER_SCRIPT, 'rn-process-birth', path, String(pid), requirement], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
    });
}
function token(parts) {
    return createHash('sha256').update(parts.join('\0')).digest('hex');
}
export function darwinProcessBirthHelperPath() {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(moduleDirectory, 'native', 'darwin-process-birth'),
        join(moduleDirectory, '..', 'native', 'darwin-process-birth'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return candidates[0];
}
function sameFile(before, after) {
    return (before.dev === after.dev &&
        before.ino === after.ino &&
        before.mode === after.mode &&
        before.size === after.size &&
        before.uid === after.uid);
}
export function darwinProcessBirthRequirement() {
    return `(${DARWIN_HELPER_MANIFEST.cdhashes.map((cdhash) => `cdhash H"${cdhash}"`).join(' or ')})`;
}
function verifyDarwinProcessBirthHelper(dependencies) {
    const helper = (dependencies.helperPath ?? darwinProcessBirthHelperPath)();
    const manifestPath = `${helper}.json`;
    const canonicalize = dependencies.canonicalize ?? realpathSync;
    const metadata = dependencies.lstat ?? lstatSync;
    const descriptorMetadata = dependencies.fstat ?? fstatSync;
    const readBinary = dependencies.readBinary ?? ((path) => readFileSync(path));
    const readDescriptor = dependencies.readDescriptor ??
        ((fd) => {
            const size = descriptorMetadata(fd).size;
            const buffer = Buffer.alloc(size);
            let offset = 0;
            while (offset < size) {
                const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
                if (bytesRead === 0)
                    break;
                offset += bytesRead;
            }
            return buffer.subarray(0, offset);
        });
    const open = dependencies.open ?? openSync;
    const close = dependencies.close ?? closeSync;
    const uid = dependencies.uid ?? process.getuid?.();
    if (canonicalize(helper) !== helper || canonicalize(manifestPath) !== manifestPath) {
        throw new Error('Darwin process-birth helper path is not canonical');
    }
    const helperBefore = metadata(helper);
    const manifestBefore = metadata(manifestPath);
    const trustedOwners = new Set([0, ...(uid === undefined ? [] : [uid])]);
    if (!helperBefore.isFile() ||
        !manifestBefore.isFile() ||
        !trustedOwners.has(helperBefore.uid) ||
        !trustedOwners.has(manifestBefore.uid) ||
        (helperBefore.mode & 0o022) !== 0 ||
        (manifestBefore.mode & 0o022) !== 0 ||
        (helperBefore.mode & 0o111) === 0) {
        throw new Error('Darwin process-birth helper metadata is untrusted');
    }
    const manifestBytes = readBinary(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (Object.entries(DARWIN_HELPER_MANIFEST).some(([key, expected]) => JSON.stringify(manifest[key]) !== JSON.stringify(expected))) {
        throw new Error('Darwin process-birth helper provenance is invalid');
    }
    const fd = open(helper, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = descriptorMetadata(fd);
        if (!opened.isFile() ||
            !sameFile(helperBefore, opened) ||
            createHash('sha256').update(readDescriptor(fd)).digest('hex') !==
                DARWIN_HELPER_MANIFEST.binarySha256 ||
            !sameFile(manifestBefore, metadata(manifestPath))) {
            throw new Error('Darwin process-birth helper changed during verification');
        }
        return {
            path: helper,
            requirement: darwinProcessBirthRequirement(),
        };
    }
    finally {
        close(fd);
    }
}
export async function withVerifiedDarwinProcessBirthHelper(callback) {
    return callback(verifyDarwinProcessBirthHelper({}));
}
export function verifiedNativePublicationHelper() {
    if (process.platform === 'darwin') {
        const helper = verifyDarwinProcessBirthHelper({});
        return { path: helper.path, sha256: DARWIN_HELPER_MANIFEST.binarySha256 };
    }
    if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
        return {
            path: verifiedLinuxPublicationHelper(process.arch),
            sha256: LINUX_PUBLICATION_HELPER_SHA256[process.arch],
        };
    }
    throw new Error('Native runner execution binding is unavailable on this platform.');
}
export function publishFileIfUnchangedDarwin(targetFd, targetPath, candidatePath, expectedPath) {
    if (process.platform === 'linux') {
        return publishFileIfUnchangedLinux(targetFd, targetPath, candidatePath, expectedPath);
    }
    if (process.platform !== 'darwin')
        return false;
    const target = fstatSync(targetFd);
    if (!target.isFile())
        return false;
    const helper = verifyDarwinProcessBirthHelper({});
    const boundPath = `${helper.path}.publish.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    copyFileSync(helper.path, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    chmodSync(boundPath, 0o700);
    try {
        const digest = createHash('sha256').update(readFileSync(boundPath)).digest('hex');
        if (digest !== DARWIN_HELPER_MANIFEST.binarySha256) {
            throw new Error('Conditional action publication helper changed before execution.');
        }
        execFileSync(boundPath, [
            '--publish-if-unchanged',
            targetPath,
            candidatePath,
            expectedPath,
            String(target.dev),
            String(target.ino),
        ], { stdio: 'ignore', timeout: 2_000 });
        return true;
    }
    catch (error) {
        if (error.status === 10)
            return false;
        throw error;
    }
    finally {
        unlinkSync(boundPath);
    }
}
export function linkFileIntoVerifiedDirectory(directoryFd, candidatePath, targetPath) {
    const directory = fstatSync(directoryFd);
    if (!directory.isDirectory() || dirname(targetPath) === targetPath)
        return false;
    if (process.platform === 'darwin') {
        const helper = verifyDarwinProcessBirthHelper({});
        return runVerifiedPublicationHelper(helper.path, DARWIN_HELPER_MANIFEST.binarySha256, [
            '--link-into-directory',
            candidatePath,
            dirname(targetPath),
            targetPath.slice(dirname(targetPath).length + 1),
            String(directory.dev),
            String(directory.ino),
        ]);
    }
    if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
        const helperPath = verifiedLinuxPublicationHelper(process.arch);
        return runVerifiedPublicationHelper(helperPath, LINUX_PUBLICATION_HELPER_SHA256[process.arch], [
            '--link-into-directory',
            candidatePath,
            dirname(targetPath),
            targetPath.slice(dirname(targetPath).length + 1),
            String(directory.dev),
            String(directory.ino),
        ]);
    }
    return false;
}
function runVerifiedPublicationHelper(helperPath, expectedSha256, args) {
    const boundPath = `${helperPath}.publish.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    copyFileSync(helperPath, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    chmodSync(boundPath, 0o700);
    try {
        if (createHash('sha256').update(readFileSync(boundPath)).digest('hex') !== expectedSha256) {
            throw new Error('Conditional action publication helper changed before execution.');
        }
        execFileSync(boundPath, [...args], { stdio: 'ignore', timeout: 2_000 });
        return true;
    }
    catch (error) {
        if (error.status === 10)
            return false;
        throw error;
    }
    finally {
        unlinkSync(boundPath);
    }
}
function linuxConditionalPublicationHelperPath(architecture) {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const name = `linux-conditional-publication-${architecture}`;
    const candidates = [
        join(moduleDirectory, 'native', name),
        join(moduleDirectory, '..', 'native', name),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return candidates[0];
}
function verifiedLinuxPublicationHelper(architecture) {
    const helperPath = linuxConditionalPublicationHelperPath(architecture);
    if (realpathSync(helperPath) !== helperPath) {
        throw new Error('Linux conditional publication helper path is not canonical.');
    }
    const before = lstatSync(helperPath);
    const uid = process.getuid?.();
    if (!before.isFile() ||
        before.isSymbolicLink() ||
        !new Set([0, ...(uid === undefined ? [] : [uid])]).has(before.uid) ||
        (before.mode & 0o022) !== 0 ||
        (before.mode & 0o111) === 0) {
        throw new Error('Linux conditional publication helper metadata is untrusted.');
    }
    const helperFd = openSync(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(helperFd);
        if (!opened.isFile() ||
            !sameFile(before, opened) ||
            createHash('sha256').update(readFileSync(helperFd)).digest('hex') !==
                LINUX_PUBLICATION_HELPER_SHA256[architecture]) {
            throw new Error('Linux conditional publication helper changed during verification.');
        }
    }
    finally {
        closeSync(helperFd);
    }
    return helperPath;
}
function publishFileIfUnchangedLinux(targetFd, targetPath, candidatePath, expectedPath) {
    if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
        return false;
    }
    const architecture = process.arch;
    const helperPath = verifiedLinuxPublicationHelper(architecture);
    const target = fstatSync(targetFd);
    if (!target.isFile())
        return false;
    const boundPath = `${helperPath}.publish.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    copyFileSync(helperPath, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    chmodSync(boundPath, 0o700);
    try {
        if (createHash('sha256').update(readFileSync(boundPath)).digest('hex') !==
            LINUX_PUBLICATION_HELPER_SHA256[architecture]) {
            throw new Error('Conditional action publication helper changed before execution.');
        }
        execFileSync(boundPath, [
            '--publish-if-unchanged',
            targetPath,
            candidatePath,
            expectedPath,
            String(target.dev),
            String(target.ino),
        ], { stdio: 'ignore', timeout: 2_000 });
        return true;
    }
    catch (error) {
        if (error.status === 10)
            return false;
        throw error;
    }
    finally {
        unlinkSync(boundPath);
    }
}
export function readProcessBirth(pid, dependencies = {}) {
    const probe = probeProcessBirth(pid, dependencies);
    return probe.status === 'present' ? probe.birth : null;
}
export function defaultProcessSignalPermission(pid) {
    try {
        process.kill(pid, 0);
        return 'permitted';
    }
    catch (error) {
        const code = error.code;
        if (code === 'ESRCH')
            return 'absent';
        if (code === 'EPERM')
            return 'denied';
        return 'unknown';
    }
}
/** GH #792: an unreadable identity is not the same as an unprovable one. */
export function probeProcessBirth(pid, dependencies = {}) {
    const probe = probeRecordedProcessBirth(pid, dependencies);
    if (probe.status !== 'unknown')
        return probe;
    // 0 and negatives address process groups, not processes.
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return probe;
    // NOTE: POSIX only — on Windows `uv_kill` opens the target for PROCESS_TERMINATE even
    // for signal 0, so this denies a live same-user process. An unreadable identity that is
    // not disproved this way stays `unknown`; absence is the platform branches' job.
    if ((dependencies.platform ?? process.platform) === 'win32')
        return probe;
    const permission = (dependencies.signalPermission ?? defaultProcessSignalPermission)(pid);
    return permission === 'denied' ? { status: 'absent', reason: 'foreign' } : probe;
}
function probeRecordedProcessBirth(pid, dependencies) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return { status: 'unknown' };
    const platform = dependencies.platform ?? process.platform;
    const read = dependencies.read ?? ((path) => readFileSync(path, 'utf8'));
    const run = dependencies.run ?? defaultRun;
    const runVerifiedHelper = dependencies.runVerifiedHelper ?? defaultRunVerifiedHelper;
    try {
        if (platform === 'darwin') {
            const observed = run('/bin/ps', ['-p', String(pid), '-o', 'pid=,state=']).trim();
            if (observed.length === 0)
                return { status: 'absent' };
            const observedFields = /^(\d+)(?:\s+(\S+))?$/.exec(observed);
            if (!observedFields || Number(observedFields[1]) !== pid)
                return { status: 'unknown' };
            // A zombie has already terminated; it runs no code and its pid cannot be
            // reused until the parent reaps it. Reporting it as absent — rather than
            // as an unreadable identity — is what lets a caller prove a stop it just
            // performed (GH #707).
            if (observedFields[2]?.startsWith('Z'))
                return { status: 'absent' };
            const helper = verifyDarwinProcessBirthHelper(dependencies);
            const processInfo = runVerifiedHelper(helper.path, pid, helper.requirement).trim();
            const processMatch = /^(\d+):(\d+):(\d+)$/.exec(processInfo);
            if (!processMatch || Number(processMatch[1]) !== pid)
                return { status: 'unknown' };
            const bootSession = run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']).trim();
            if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootSession)) {
                return { status: 'unknown' };
            }
            return {
                status: 'present',
                birth: {
                    pid,
                    source: 'darwin-libproc',
                    token: token([platform, bootSession.toLowerCase(), processMatch[2], processMatch[3]]),
                },
            };
        }
        if (platform === 'linux') {
            const boot = read('/proc/sys/kernel/random/boot_id').trim();
            let stat;
            try {
                stat = read(`/proc/${pid}/stat`).trim();
            }
            catch (error) {
                return error.code === 'ENOENT'
                    ? { status: 'absent' }
                    : { status: 'unknown' };
            }
            const commandEnd = stat.lastIndexOf(')');
            const fields = commandEnd >= 0
                ? stat
                    .slice(commandEnd + 1)
                    .trim()
                    .split(/\s+/)
                : [];
            if (fields[0] === 'Z')
                return { status: 'absent' };
            const started = fields[19];
            if (!boot || !started || !/^\d+$/.test(started))
                return { status: 'unknown' };
            return {
                status: 'present',
                birth: { pid, source: 'linux-proc', token: token([platform, boot, started]) },
            };
        }
        if (platform === 'win32') {
            const powershell = resolveTrustedSystemExecutable('powershell', platform, dependencies.executableDependencies);
            if (!powershell)
                return { status: 'unknown' };
            const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
                `if ($null -eq $p) { 'ABSENT' } else { $p.StartTime.ToUniversalTime().Ticks }`;
            const started = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script]).trim();
            if (started === 'ABSENT')
                return { status: 'absent' };
            if (!/^\d+$/.test(started))
                return { status: 'unknown' };
            return {
                status: 'present',
                birth: { pid, source: 'windows-powershell', token: token([platform, started]) },
            };
        }
    }
    catch {
        return { status: 'unknown' };
    }
    return { status: 'unknown' };
}
export function processBirthMatches(expected, dependencies = {}) {
    const observed = readProcessBirth(expected.pid, dependencies);
    return observed !== null && observed.token === expected.token;
}
