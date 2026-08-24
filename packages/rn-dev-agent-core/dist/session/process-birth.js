import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, chmodSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTrustedSystemExecutable, } from '../util/trusted-system-executable.js';
const DARWIN_HELPER_MANIFEST = {
    sourceSha256: '4f3ad25913f08e4518a8dec6918e73cc5e9bc80f7ec9e0cb9f64a363e1c8f147',
    recipeSha256: '7e6b6b39a39ded2e3f748006264247e6d494fd5c9054cf8580ecb4396970b025',
    stableBinarySha256: '1662cb03acb7f5cf3b879a851322602de522479a3e18dc0f4ec8ca5303592f23',
    binarySha256: '3c0c6bd9b591feaf1246990f30d42d7ac8943d826e05ddcc0285f511d08da0d4',
    cdhashes: [
        'd2af3d210165b1a915562e4ec1895a6286fd1d6f',
        '26875724107a2489e9341d8d86ffa020b3b2d5a5',
    ],
};
const LINUX_PUBLICATION_HELPER_SHA256 = {
    x64: '9a38afcecb28015c3016f509fb659db541d2f452bb48cfbcaa737b8b0f76df80',
    arm64: '354dc1dfe1a80250a2b4a017eeff474f9ec77d5dbf70885b18b929afce9915be',
};
const VERIFIED_FILESYSTEM_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const VERIFIED_FILESYSTEM_BATCH_BYTES = 24 * 1024 * 1024;
const VERIFIED_FILESYSTEM_BATCH_FILES = 16;
const VERIFIED_FILESYSTEM_ENTRY_FRAME_BYTES = 9;
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
function runVerifiedPublicationHelper(helperPath, expectedSha256, args, directoryFd) {
    const boundPath = `${helperPath}.publish.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    copyFileSync(helperPath, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    chmodSync(boundPath, 0o700);
    try {
        if (createHash('sha256').update(readFileSync(boundPath)).digest('hex') !== expectedSha256) {
            throw new Error('Conditional action publication helper changed before execution.');
        }
        execFileSync(boundPath, [...args], {
            stdio: directoryFd === undefined ? 'ignore' : ['ignore', 'ignore', 'ignore', directoryFd],
            timeout: 2_000,
        });
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
function publicationWitnessArguments(witnesses) {
    return witnesses.flatMap((witness) => [
        witness.path,
        witness.kind,
        witness.dev,
        witness.ino,
        witness.linkTarget ?? '',
    ]);
}
export function publishFileIfUnchangedInVerifiedDirectory(directoryFd, targetName, candidateName, expectedName, witnesses) {
    const helper = verifiedNativePublicationHelper();
    return runVerifiedPublicationHelper(helper.path, helper.sha256, [
        '--publish-relative-if-unchanged',
        targetName,
        candidateName,
        expectedName,
        ...publicationWitnessArguments(witnesses),
    ], directoryFd);
}
export function linkFileIntoVerifiedDirectoryFd(directoryFd, candidateName, targetName, witnesses) {
    const helper = verifiedNativePublicationHelper();
    return runVerifiedPublicationHelper(helper.path, helper.sha256, [
        '--link-relative-if-unchanged',
        candidateName,
        targetName,
        ...publicationWitnessArguments(witnesses),
    ], directoryFd);
}
export function unlinkFileFromVerifiedDirectoryFd(directoryFd, fileName) {
    const helper = verifiedNativePublicationHelper();
    return runVerifiedPublicationHelper(helper.path, helper.sha256, ['--unlink-relative-file', fileName], directoryFd);
}
function verifiedFilesystemHelper() {
    if (process.platform === 'darwin') {
        const helper = verifyDarwinProcessBirthHelper({});
        return { path: helper.path, sha256: DARWIN_HELPER_MANIFEST.binarySha256 };
    }
    if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
        const architecture = process.arch;
        return {
            path: verifiedLinuxPublicationHelper(architecture),
            sha256: LINUX_PUBLICATION_HELPER_SHA256[architecture],
        };
    }
    throw new Error(`Verified directory reads are unavailable on ${process.platform}/${process.arch}.`);
}
function runVerifiedFilesystemHelper(args) {
    const helper = verifiedFilesystemHelper();
    const boundPath = `${helper.path}.read.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    copyFileSync(helper.path, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    chmodSync(boundPath, 0o700);
    try {
        if (createHash('sha256').update(readFileSync(boundPath)).digest('hex') !== helper.sha256) {
            throw new Error('Verified directory helper changed before execution.');
        }
        return execFileSync(boundPath, [...args], {
            maxBuffer: VERIFIED_FILESYSTEM_MAX_BUFFER_BYTES,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10_000,
        });
    }
    finally {
        unlinkSync(boundPath);
    }
}
export function readFileFromVerifiedDirectory(directoryPath, identity, relativePath) {
    return runVerifiedFilesystemHelper([
        '--read-directory-entry',
        directoryPath,
        relativePath,
        identity.dev,
        identity.ino,
    ]);
}
export function readFilesFromVerifiedDirectory(directoryPath, identity, relativePaths) {
    if (relativePaths.length === 0)
        return [];
    const entries = [];
    const batches = [];
    let batch = [];
    let batchBytes = 0;
    for (const relativePath of relativePaths) {
        let framedBytes = VERIFIED_FILESYSTEM_ENTRY_FRAME_BYTES;
        try {
            const stat = lstatSync(join(directoryPath, relativePath));
            if (stat.isFile())
                framedBytes += stat.size;
        }
        catch {
            framedBytes = VERIFIED_FILESYSTEM_ENTRY_FRAME_BYTES;
        }
        if (batch.length > 0 &&
            (batch.length >= VERIFIED_FILESYSTEM_BATCH_FILES ||
                batchBytes + framedBytes > VERIFIED_FILESYSTEM_BATCH_BYTES)) {
            batches.push(batch);
            batch = [];
            batchBytes = 0;
        }
        batch.push(relativePath);
        batchBytes += framedBytes;
    }
    if (batch.length > 0)
        batches.push(batch);
    for (const currentBatch of batches) {
        const output = runVerifiedFilesystemHelper([
            '--read-directory-entries',
            directoryPath,
            identity.dev,
            identity.ino,
            ...currentBatch,
        ]);
        let offset = 0;
        for (const relativePath of currentBatch) {
            if (offset + 9 > output.length) {
                throw new Error(`Verified directory batch was truncated before ${relativePath}.`);
            }
            const status = output[offset];
            const length = output.readBigUInt64BE(offset + 1);
            offset += 9;
            if (length > BigInt(Number.MAX_SAFE_INTEGER) || offset + Number(length) > output.length) {
                throw new Error(`Verified directory batch was malformed at ${relativePath}.`);
            }
            const end = offset + Number(length);
            if (status === 0)
                entries.push(Buffer.from(output.subarray(offset, end)));
            else if (status === 1 && length === 0n)
                entries.push(null);
            else
                throw new Error(`Verified directory batch had an invalid status for ${relativePath}.`);
            offset = end;
        }
        if (offset !== output.length)
            throw new Error('Verified directory batch had trailing data.');
    }
    return entries;
}
export function listVerifiedDirectory(directoryPath, identity) {
    const output = runVerifiedFilesystemHelper([
        '--list-directory',
        directoryPath,
        identity.dev,
        identity.ino,
    ]);
    if (output.length === 0)
        return [];
    if (output[output.length - 1] !== 0)
        throw new Error('Verified directory listing was malformed.');
    return output
        .subarray(0, -1)
        .toString('utf8')
        .split('\0')
        .filter((entry) => entry.length > 0 && entry !== '.' && entry !== '..' && !entry.includes('/'));
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
