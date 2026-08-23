import { listVerifiedDirectory, readFileFromVerifiedDirectory, readFilesFromVerifiedDirectory, } from '../session/process-birth.js';
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
