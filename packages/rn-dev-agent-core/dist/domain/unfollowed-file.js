import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { listVerifiedDirectory, readFileFromVerifiedDirectory, readFilesFromVerifiedDirectory, } from '../session/process-birth.js';
export function createUnfollowedFileSnapshot(directoryPath, directoryIdentity) {
    return { directoryPath, directoryIdentity, fileIdentities: new Map() };
}
function captureUnfollowedFileIdentities(snapshot, relativePaths) {
    try {
        for (const relativePath of relativePaths) {
            const path = join(snapshot.directoryPath, relativePath);
            const stat = lstatSync(path, { bigint: true });
            if (stat.isSymbolicLink() || !stat.isFile())
                throw new Error('changed');
            const captured = { path, dev: String(stat.dev), ino: String(stat.ino) };
            const existing = snapshot.fileIdentities.get(relativePath);
            if (existing && (existing.dev !== captured.dev || existing.ino !== captured.ino)) {
                throw new Error('changed');
            }
            snapshot.fileIdentities.set(relativePath, existing ?? captured);
        }
    }
    catch {
        throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
    }
}
export function assertUnfollowedFileSnapshotUnchanged(snapshot) {
    try {
        for (const identity of snapshot.fileIdentities.values()) {
            const stat = lstatSync(identity.path, { bigint: true });
            if (stat.isSymbolicLink() ||
                !stat.isFile() ||
                String(stat.dev) !== identity.dev ||
                String(stat.ino) !== identity.ino) {
                throw new Error('changed');
            }
        }
    }
    catch {
        throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
    }
}
export function readUnfollowedSnapshotFiles(snapshot, relativePaths, readFiles = readUnfollowedFiles) {
    assertUnfollowedFileSnapshotUnchanged(snapshot);
    captureUnfollowedFileIdentities(snapshot, relativePaths);
    const contents = readFiles(snapshot.directoryPath, snapshot.directoryIdentity, relativePaths);
    assertUnfollowedFileSnapshotUnchanged(snapshot);
    if (contents.length !== relativePaths.length || contents.some((entry) => entry == null)) {
        throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
    }
    return contents;
}
export function readUnfollowedFile(directoryPath, identity, relativePath) {
    try {
        return readFileFromVerifiedDirectory(directoryPath, identity, relativePath).toString('utf8');
    }
    catch (err) {
        throw new Error(`Refusing inherited action symlink at ${directoryPath}/${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export function readUnfollowedFiles(directoryPath, identity, relativePaths) {
    try {
        return readFilesFromVerifiedDirectory(directoryPath, identity, relativePaths).map((entry) => entry ? entry.toString('utf8') : null);
    }
    catch (err) {
        throw new Error(`Refusing replaced learned-action corpus at ${directoryPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export function listUnfollowedDirectory(directoryPath, identity) {
    try {
        return listVerifiedDirectory(directoryPath, identity);
    }
    catch (err) {
        throw new Error(`Refusing replaced learned-action corpus at ${directoryPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
