import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  listVerifiedDirectory,
  readFileFromVerifiedDirectory,
  readFilesFromVerifiedDirectory,
} from '../session/process-birth.js';

export interface VerifiedDirectoryIdentity {
  dev: string;
  ino: string;
}

export interface UnfollowedFileIdentity {
  path: string;
  dev: string;
  ino: string;
}

export interface UnfollowedFileSnapshot {
  directoryPath: string;
  directoryIdentity: VerifiedDirectoryIdentity;
  fileIdentities: Map<string, UnfollowedFileIdentity>;
}

export function createUnfollowedFileSnapshot(
  directoryPath: string,
  directoryIdentity: VerifiedDirectoryIdentity,
): UnfollowedFileSnapshot {
  return { directoryPath, directoryIdentity, fileIdentities: new Map() };
}

function captureUnfollowedFileIdentities(
  snapshot: UnfollowedFileSnapshot,
  relativePaths: readonly string[],
): void {
  try {
    for (const relativePath of relativePaths) {
      const path = join(snapshot.directoryPath, relativePath);
      const stat = lstatSync(path, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('changed');
      const captured = { path, dev: String(stat.dev), ino: String(stat.ino) };
      const existing = snapshot.fileIdentities.get(relativePath);
      if (existing && (existing.dev !== captured.dev || existing.ino !== captured.ino)) {
        throw new Error('changed');
      }
      snapshot.fileIdentities.set(relativePath, existing ?? captured);
    }
  } catch {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
}

export function assertUnfollowedFileSnapshotUnchanged(snapshot: UnfollowedFileSnapshot): void {
  try {
    for (const identity of snapshot.fileIdentities.values()) {
      const stat = lstatSync(identity.path, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        String(stat.dev) !== identity.dev ||
        String(stat.ino) !== identity.ino
      ) {
        throw new Error('changed');
      }
    }
  } catch {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
}

export function readUnfollowedSnapshotFiles(
  snapshot: UnfollowedFileSnapshot,
  relativePaths: readonly string[],
  readFiles: typeof readUnfollowedFiles = readUnfollowedFiles,
): string[] {
  assertUnfollowedFileSnapshotUnchanged(snapshot);
  captureUnfollowedFileIdentities(snapshot, relativePaths);
  const contents = readFiles(snapshot.directoryPath, snapshot.directoryIdentity, relativePaths);
  assertUnfollowedFileSnapshotUnchanged(snapshot);
  if (contents.length !== relativePaths.length || contents.some((entry) => entry == null)) {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
  return contents as string[];
}

export function readUnfollowedFile(
  directoryPath: string,
  identity: VerifiedDirectoryIdentity,
  relativePath: string,
): string {
  try {
    return readFileFromVerifiedDirectory(directoryPath, identity, relativePath).toString('utf8');
  } catch (err) {
    throw new Error(
      `Refusing inherited action symlink at ${directoryPath}/${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function readUnfollowedFiles(
  directoryPath: string,
  identity: VerifiedDirectoryIdentity,
  relativePaths: readonly string[],
): Array<string | null> {
  try {
    return readFilesFromVerifiedDirectory(directoryPath, identity, relativePaths).map((entry) =>
      entry ? entry.toString('utf8') : null,
    );
  } catch (err) {
    throw new Error(
      `Refusing replaced learned-action corpus at ${directoryPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function listUnfollowedDirectory(
  directoryPath: string,
  identity: VerifiedDirectoryIdentity,
): string[] {
  try {
    return listVerifiedDirectory(directoryPath, identity);
  } catch (err) {
    throw new Error(
      `Refusing replaced learned-action corpus at ${directoryPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
