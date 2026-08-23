import { listVerifiedDirectory, readFileFromVerifiedDirectory } from '../session/process-birth.js';

export interface VerifiedDirectoryIdentity {
  dev: string;
  ino: string;
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
