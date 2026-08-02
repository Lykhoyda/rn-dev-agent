import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
function runText(command, args) {
    return execFileSync(command, [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
    });
}
function runBuffer(command, args) {
    return execFileSync(command, [...args], {
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
        maxBuffer: 512 * 1024 * 1024,
    });
}
function digest(parts) {
    const hash = createHash('sha256');
    for (const part of parts) {
        hash.update(`${part.byteLength}:`);
        hash.update(part);
    }
    return hash.digest('hex');
}
function generation(parts) {
    return digest(parts.map((part) => Buffer.from(part)));
}
function listAppFiles(appPath) {
    const files = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(path);
            }
            else if (entry.isFile() || entry.isSymbolicLink()) {
                files.push(relative(appPath, path));
            }
            else {
                throw new Error('APP_INSTALL_IDENTITY_CHANGED: iOS app contains an unsupported filesystem entry');
            }
        }
    };
    visit(appPath);
    return files.sort();
}
function iosAppFiles(appPath, dependencies) {
    return [...(dependencies.listAppFiles ?? listAppFiles)(appPath)].sort();
}
function assertIosSymlinkContained(appPath, path, realpath) {
    const target = realpath(path);
    const child = relative(realpath(appPath), target);
    if (child === '..' ||
        child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(child)) {
        throw new Error('APP_INSTALL_IDENTITY_CHANGED: iOS app symlink escapes the installed bundle');
    }
}
function androidApkPaths(target, text) {
    return text('adb', ['-s', target.deviceId, 'shell', 'pm', 'path', target.appId])
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('package:'))
        .map((line) => line.slice('package:'.length))
        .sort();
}
export function captureInstallGeneration(target, dependencies = {}) {
    const text = dependencies.runText ?? runText;
    if (target.platform === 'ios') {
        const appPath = text('xcrun', [
            'simctl',
            'get_app_container',
            target.deviceId,
            target.appId,
            'app',
        ]).trim();
        if (!appPath) {
            throw new Error('APP_INSTALL_IDENTITY_CHANGED: exact iOS app container was not found');
        }
        const infoPath = join(appPath, 'Info.plist');
        const executable = text('plutil', [
            '-extract',
            'CFBundleExecutable',
            'raw',
            '-o',
            '-',
            infoPath,
        ]).trim();
        if (!executable) {
            throw new Error('APP_INSTALL_IDENTITY_CHANGED: iOS executable identity is unavailable');
        }
        const stat = dependencies.stat ?? statSync;
        const metadata = iosAppFiles(appPath, dependencies).map((entry) => {
            const path = join(appPath, entry);
            const value = stat(path);
            return `${entry}:${String(value.ino)}:${value.size}:${value.mtimeMs}`;
        });
        return generation(metadata);
    }
    const apkPaths = androidApkPaths(target, text);
    if (!apkPaths.length) {
        throw new Error('APP_INSTALL_IDENTITY_CHANGED: exact Android package was not found');
    }
    const metadata = text('adb', [
        '-s',
        target.deviceId,
        'shell',
        'stat',
        '-c',
        '%n:%i:%s:%Y',
        ...apkPaths,
    ])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .sort();
    if (metadata.length !== apkPaths.length) {
        throw new Error('APP_INSTALL_IDENTITY_CHANGED: Android install generation is unavailable');
    }
    return generation(metadata);
}
export function captureInstalledArtifact(target, dependencies = {}) {
    const text = dependencies.runText ?? runText;
    const buffer = dependencies.runBuffer ?? runBuffer;
    const read = dependencies.read ?? readFileSync;
    if (target.platform === 'ios') {
        const appPath = text('xcrun', [
            'simctl',
            'get_app_container',
            target.deviceId,
            target.appId,
            'app',
        ]).trim();
        if (!appPath) {
            throw new Error('APP_INSTALL_IDENTITY_CHANGED: exact iOS app container was not found');
        }
        const infoPath = join(appPath, 'Info.plist');
        const executable = text('plutil', [
            '-extract',
            'CFBundleExecutable',
            'raw',
            '-o',
            '-',
            infoPath,
        ]).trim();
        if (!executable) {
            throw new Error('APP_INSTALL_IDENTITY_CHANGED: iOS executable identity is unavailable');
        }
        const files = iosAppFiles(appPath, dependencies);
        const lstat = dependencies.lstat ?? lstatSync;
        const readLink = dependencies.readLink ?? readlinkSync;
        const realpath = dependencies.realpath ?? realpathSync;
        const artifactParts = [];
        for (const entry of files) {
            const path = join(appPath, entry);
            const stat = lstat(path);
            artifactParts.push(Buffer.from(entry));
            if (stat.isFile()) {
                artifactParts.push(Buffer.from('file'), read(path));
            }
            else if (stat.isSymbolicLink()) {
                assertIosSymlinkContained(appPath, path, realpath);
                artifactParts.push(Buffer.from('symlink'), Buffer.from(readLink(path)));
            }
            else {
                throw new Error('APP_INSTALL_IDENTITY_CHANGED: iOS app contains an unsupported filesystem entry');
            }
        }
        return {
            ...target,
            artifactDigest: digest(artifactParts),
            installGeneration: captureInstallGeneration(target, dependencies),
        };
    }
    const apkPaths = androidApkPaths(target, text);
    if (!apkPaths.length) {
        throw new Error('APP_INSTALL_IDENTITY_CHANGED: exact Android package was not found');
    }
    return {
        ...target,
        artifactDigest: digest(apkPaths.map((path) => buffer('adb', ['-s', target.deviceId, 'exec-out', 'cat', path]))),
        installGeneration: captureInstallGeneration(target, dependencies),
    };
}
export function verifyInstalledArtifact(expected, observed) {
    if (expected.platform !== observed.platform ||
        expected.deviceId !== observed.deviceId ||
        expected.appId !== observed.appId ||
        expected.artifactDigest !== observed.artifactDigest ||
        expected.installGeneration !== observed.installGeneration) {
        throw new Error('APP_INSTALL_IDENTITY_CHANGED: installed artifact no longer matches the session build');
    }
}
