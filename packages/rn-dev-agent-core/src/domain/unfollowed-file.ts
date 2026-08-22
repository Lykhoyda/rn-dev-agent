import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

/** Read a regular file without following a final-path symlink. */
export function readUnfollowedFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw err;
    throw new Error(`Refusing inherited action symlink at ${path}.`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`Refusing inherited action symlink at ${path}.`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
