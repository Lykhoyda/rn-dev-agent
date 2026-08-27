#!/usr/bin/env node
import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);

// packages/rn-dev-agent-core/dist/learned-actions.js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// packages/rn-dev-agent-core/dist/domain/unfollowed-file.js
import { execFileSync as execFileSync2 } from "node:child_process";
import { lstatSync as lstatSync2 } from "node:fs";
import { isAbsolute, join as join2 } from "node:path";

// packages/rn-dev-agent-core/dist/session/process-birth.js
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, chmodSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var DARWIN_HELPER_MANIFEST = {
  sourceSha256: "f97feaa1c0434cd2ee31c0dce56c9308eb17f893a6a771ac1333b62fcec8b702",
  recipeSha256: "9617fe093885ac5c1043b39aa467754db8427080b52ebafea6f780535c2b3685",
  stableBinarySha256: "9887a09246c4fc9c7765ef8fee2ae30027bcf0b9227ae408e48682107e4d88b8",
  binarySha256: "49db19d9cd0ca2e7a78379c1e4b9551532d85447c043c51f06c6e03573c104ad",
  cdhashes: [
    "cebd22e7adf08990d4ff69b3156de03962d44b74",
    "e3de1b27f4da23957a3acf60ae8f01c6402bd424"
  ]
};
var LINUX_PUBLICATION_HELPER_SHA256 = {
  x64: "93bcb6e186470efd2a0944756d7b2de790182b59a5dcb3377334291076ad6032",
  arm64: "1d0f2fc75e9eff675f8fd5ca329eca03950339796d2f339a4f59a85c2f97ba63"
};
function darwinProcessBirthHelperPath() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "native", "darwin-process-birth"),
    join(moduleDirectory, "..", "native", "darwin-process-birth")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate))
      return candidate;
  }
  return candidates[0];
}
function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.size === after.size && before.uid === after.uid;
}
function darwinProcessBirthRequirement() {
  return `(${DARWIN_HELPER_MANIFEST.cdhashes.map((cdhash) => `cdhash H"${cdhash}"`).join(" or ")})`;
}
function verifyDarwinProcessBirthHelper(dependencies) {
  const helper = (dependencies.helperPath ?? darwinProcessBirthHelperPath)();
  const manifestPath = `${helper}.json`;
  const canonicalize = dependencies.canonicalize ?? realpathSync;
  const metadata = dependencies.lstat ?? lstatSync;
  const descriptorMetadata = dependencies.fstat ?? fstatSync;
  const readBinary = dependencies.readBinary ?? ((path2) => readFileSync(path2));
  const readDescriptor = dependencies.readDescriptor ?? ((fd2) => {
    const size = descriptorMetadata(fd2).size;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd2, buffer, offset, size - offset, offset);
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
    throw new Error("Darwin process-birth helper path is not canonical");
  }
  const helperBefore = metadata(helper);
  const manifestBefore = metadata(manifestPath);
  const trustedOwners = /* @__PURE__ */ new Set([0, ...uid === void 0 ? [] : [uid]]);
  if (!helperBefore.isFile() || !manifestBefore.isFile() || !trustedOwners.has(helperBefore.uid) || !trustedOwners.has(manifestBefore.uid) || (helperBefore.mode & 18) !== 0 || (manifestBefore.mode & 18) !== 0 || (helperBefore.mode & 73) === 0) {
    throw new Error("Darwin process-birth helper metadata is untrusted");
  }
  const manifestBytes = readBinary(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (Object.entries(DARWIN_HELPER_MANIFEST).some(([key, expected]) => JSON.stringify(manifest[key]) !== JSON.stringify(expected))) {
    throw new Error("Darwin process-birth helper provenance is invalid");
  }
  const fd = open(helper, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = descriptorMetadata(fd);
    if (!opened.isFile() || !sameFile(helperBefore, opened) || createHash("sha256").update(readDescriptor(fd)).digest("hex") !== DARWIN_HELPER_MANIFEST.binarySha256 || !sameFile(manifestBefore, metadata(manifestPath))) {
      throw new Error("Darwin process-birth helper changed during verification");
    }
    return {
      path: helper,
      requirement: darwinProcessBirthRequirement()
    };
  } finally {
    close(fd);
  }
}
function verifiedFilesystemHelper() {
  if (process.platform === "darwin") {
    const helper = verifyDarwinProcessBirthHelper({});
    return { path: helper.path, sha256: DARWIN_HELPER_MANIFEST.binarySha256 };
  }
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    const architecture = process.arch;
    return {
      path: verifiedLinuxPublicationHelper(architecture),
      sha256: LINUX_PUBLICATION_HELPER_SHA256[architecture]
    };
  }
  throw new Error(`Verified directory reads are unavailable on ${process.platform}/${process.arch}.`);
}
function runVerifiedFilesystemHelper(args) {
  const helper = verifiedFilesystemHelper();
  const boundPath = `${helper.path}.read.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  copyFileSync(helper.path, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(boundPath, 448);
  try {
    if (createHash("sha256").update(readFileSync(boundPath)).digest("hex") !== helper.sha256) {
      throw new Error("Verified directory helper changed before execution.");
    }
    return execFileSync(boundPath, [...args], {
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1e4
    });
  } finally {
    unlinkSync(boundPath);
  }
}
function listVerifiedDirectory(directoryPath, identity) {
  const output = runVerifiedFilesystemHelper([
    "--list-directory",
    directoryPath,
    identity.dev,
    identity.ino
  ]);
  if (output.length === 0)
    return [];
  if (output[output.length - 1] !== 0)
    throw new Error("Verified directory listing was malformed.");
  return output.subarray(0, -1).toString("utf8").split("\0").filter((entry) => entry.length > 0 && entry !== "." && entry !== ".." && !entry.includes("/"));
}
function linuxConditionalPublicationHelperPath(architecture) {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const name = `linux-conditional-publication-${architecture}`;
  const candidates = [
    join(moduleDirectory, "native", name),
    join(moduleDirectory, "..", "native", name)
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
    throw new Error("Linux conditional publication helper path is not canonical.");
  }
  const before = lstatSync(helperPath);
  const uid = process.getuid?.();
  if (!before.isFile() || before.isSymbolicLink() || !(/* @__PURE__ */ new Set([0, ...uid === void 0 ? [] : [uid]])).has(before.uid) || (before.mode & 18) !== 0 || (before.mode & 73) === 0) {
    throw new Error("Linux conditional publication helper metadata is untrusted.");
  }
  const helperFd = openSync(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(helperFd);
    if (!opened.isFile() || !sameFile(before, opened) || createHash("sha256").update(readFileSync(helperFd)).digest("hex") !== LINUX_PUBLICATION_HELPER_SHA256[architecture]) {
      throw new Error("Linux conditional publication helper changed during verification.");
    }
  } finally {
    closeSync(helperFd);
  }
  return helperPath;
}

// packages/rn-dev-agent-core/dist/domain/unfollowed-file.js
function createUnfollowedFileSnapshot(directoryPath, directoryIdentity) {
  return { directoryPath, directoryIdentity, fileIdentities: /* @__PURE__ */ new Map() };
}
var UNFOLLOWED_READER_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
var UNFOLLOWED_READER_BATCH_BYTES = 24 * 1024 * 1024;
var UNFOLLOWED_READER_BATCH_FILES = 16;
var UNFOLLOWED_READER_FRAME_BYTES = 9;
var UNFOLLOWED_READER_SCRIPT = String.raw`
const { closeSync, constants, fstatSync, openSync, readSync, realpathSync, writeSync } = require('node:fs');
const { join } = require('node:path');
const request = JSON.parse(process.argv[1]);
const opened = [];
let directory = -1;
const closeAll = () => {
  for (const entry of opened) if (entry.fd >= 0) closeSync(entry.fd);
  if (directory >= 0) closeSync(directory);
};
const matches = (stat, identity) =>
  stat.isFile() &&
  String(stat.dev) === identity.dev &&
  String(stat.ino) === identity.ino &&
  String(stat.size) === identity.size &&
  String(stat.mtimeNs) === identity.mtimeNs &&
  String(stat.ctimeNs) === identity.ctimeNs;
try {
  directory = openSync(
    request.directoryPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  const directoryStat = fstatSync(directory, { bigint: true });
  if (
    !directoryStat.isDirectory() ||
    String(directoryStat.dev) !== request.directoryIdentity.dev ||
    String(directoryStat.ino) !== request.directoryIdentity.ino
  ) {
    throw new Error('directory changed');
  }
  let batchBytes = 0;
  for (const entry of request.entries) {
    if (!entry.identity) {
      opened.push({ fd: -1, size: 0, identity: null });
      batchBytes += 9;
      continue;
    }
    const path = join(request.directoryPath, entry.relativePath);
    if (realpathSync.native(path) !== path) throw new Error('path followed a link');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    if (!matches(stat, entry.identity)) {
      closeSync(fd);
      throw new Error('file changed');
    }
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      closeSync(fd);
      throw new Error('invalid size');
    }
    batchBytes += 9 + size;
    if (batchBytes > ${UNFOLLOWED_READER_BATCH_BYTES}) {
      closeSync(fd);
      throw new Error('batch too large');
    }
    opened.push({ fd, size, identity: entry.identity });
  }
  for (const entry of opened) {
    const frame = Buffer.alloc(9);
    if (entry.fd < 0) {
      frame[0] = 1;
      writeSync(1, frame);
      continue;
    }
    frame.writeBigUInt64BE(BigInt(entry.size), 1);
    writeSync(1, frame);
    const buffer = Buffer.allocUnsafe(Math.min(16384, Math.max(entry.size, 1)));
    let offset = 0;
    while (offset < entry.size) {
      const count = readSync(entry.fd, buffer, 0, Math.min(buffer.length, entry.size - offset), offset);
      if (count <= 0) throw new Error('short read');
      writeSync(1, buffer, 0, count);
      offset += count;
    }
    if (!matches(fstatSync(entry.fd, { bigint: true }), entry.identity)) {
      throw new Error('file changed during read');
    }
  }
  closeAll();
} catch {
  closeAll();
  process.exit(10);
}
`;
function identityFromStat(path2, stat) {
  return {
    path: path2,
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function captureUnfollowedFileIdentities(snapshot, relativePaths) {
  const identities = [];
  try {
    for (const relativePath of relativePaths) {
      const path2 = join2(snapshot.directoryPath, relativePath);
      const stat = lstatSync2(path2, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("changed");
      const captured = identityFromStat(path2, stat);
      const existing = snapshot.fileIdentities.get(relativePath);
      if (existing && !sameIdentity(existing, captured))
        throw new Error("changed");
      const selected = existing ?? captured;
      snapshot.fileIdentities.set(relativePath, selected);
      identities.push(selected);
    }
  } catch {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
  return identities;
}
function assertUnfollowedFileSnapshotUnchanged(snapshot) {
  try {
    for (const identity of snapshot.fileIdentities.values()) {
      const stat = lstatSync2(identity.path, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile() || !sameIdentity(identity, identityFromStat(identity.path, stat))) {
        throw new Error("changed");
      }
    }
  } catch {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
}
function readUnfollowedSnapshotFiles(snapshot, relativePaths, readFiles = readUnfollowedFiles) {
  assertUnfollowedFileSnapshotUnchanged(snapshot);
  const identities = captureUnfollowedFileIdentities(snapshot, relativePaths);
  const contents = readFiles(snapshot.directoryPath, snapshot.directoryIdentity, relativePaths, identities);
  assertUnfollowedFileSnapshotUnchanged(snapshot);
  if (contents.length !== relativePaths.length || contents.some((entry) => entry == null)) {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
  return contents;
}
function readUnfollowedFiles(directoryPath, identity, relativePaths, expectedIdentities) {
  try {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error(`Verified directory reads are unavailable on ${process.platform}/${process.arch}.`);
    }
    if (expectedIdentities && expectedIdentities.length !== relativePaths.length) {
      throw new Error("Selected file identities did not match the requested paths.");
    }
    const entries = relativePaths.map((relativePath, index) => {
      if (isAbsolute(relativePath) || relativePath.split("/").some((component) => !component || component === "." || component === "..")) {
        throw new Error(`Invalid relative path: ${relativePath}.`);
      }
      if (expectedIdentities) {
        const selected = expectedIdentities[index];
        if (!selected || selected.path !== join2(directoryPath, relativePath)) {
          throw new Error(`Selected file identity did not match ${relativePath}.`);
        }
        return { relativePath, identity: selected };
      }
      const path2 = join2(directoryPath, relativePath);
      try {
        const stat = lstatSync2(path2, { bigint: true });
        return {
          relativePath,
          identity: stat.isSymbolicLink() || !stat.isFile() ? null : identityFromStat(path2, stat)
        };
      } catch (err) {
        if (err.code === "ENOENT")
          return { relativePath, identity: null };
        throw err;
      }
    });
    const contents = [];
    let batch = [];
    let batchBytes = 0;
    const flush = () => {
      if (batch.length === 0)
        return;
      const output = execFileSync2(process.execPath, [
        "--no-warnings",
        "--input-type=commonjs",
        "-e",
        UNFOLLOWED_READER_SCRIPT,
        JSON.stringify({ directoryPath, directoryIdentity: identity, entries: batch })
      ], {
        maxBuffer: UNFOLLOWED_READER_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1e4
      });
      let offset = 0;
      for (const entry of batch) {
        if (offset + UNFOLLOWED_READER_FRAME_BYTES > output.length) {
          throw new Error(`Verified directory batch was truncated before ${entry.relativePath}.`);
        }
        const status = output[offset];
        const length = output.readBigUInt64BE(offset + 1);
        offset += UNFOLLOWED_READER_FRAME_BYTES;
        if (length > BigInt(Number.MAX_SAFE_INTEGER) || offset + Number(length) > output.length) {
          throw new Error(`Verified directory batch was malformed at ${entry.relativePath}.`);
        }
        const end = offset + Number(length);
        if (status === 0)
          contents.push(output.toString("utf8", offset, end));
        else if (status === 1 && length === 0n)
          contents.push(null);
        else
          throw new Error(`Verified directory batch refused ${entry.relativePath}.`);
        offset = end;
      }
      if (offset !== output.length)
        throw new Error("Verified directory batch had trailing data.");
      batch = [];
      batchBytes = 0;
    };
    for (const entry of entries) {
      const size = entry.identity ? Number(entry.identity.size) : 0;
      const framedBytes = UNFOLLOWED_READER_FRAME_BYTES + size;
      if (!Number.isSafeInteger(size) || framedBytes > UNFOLLOWED_READER_BATCH_BYTES) {
        throw new Error(`Verified directory entry exceeds the safe batch size: ${entry.relativePath}.`);
      }
      if (batch.length > 0 && (batch.length >= UNFOLLOWED_READER_BATCH_FILES || batchBytes + framedBytes > UNFOLLOWED_READER_BATCH_BYTES)) {
        flush();
      }
      batch.push(entry);
      batchBytes += framedBytes;
    }
    flush();
    return contents;
  } catch (err) {
    throw new Error(`Refusing replaced learned-action corpus at ${directoryPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function listUnfollowedDirectory(directoryPath, identity) {
  try {
    return listVerifiedDirectory(directoryPath, identity);
  } catch (err) {
    throw new Error(`Refusing replaced learned-action corpus at ${directoryPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// packages/rn-dev-agent-core/dist/session/worktree-inheritance.js
import { spawnSync } from "node:child_process";
import { closeSync as closeSync2, constants as constants2, existsSync as existsSync2, fstatSync as fstatSync2, lstatSync as lstatSync3, mkdirSync, openSync as openSync2, readFileSync as readFileSync2, readlinkSync, realpathSync as realpathSync2, renameSync, statSync, symlinkSync, unlinkSync as unlinkSync2 } from "node:fs";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join3, relative, resolve, sep } from "node:path";

// packages/rn-dev-agent-core/dist/session/worktree-repair-remedy.js
var WORKTREE_REPAIR_ENTRY = '"${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}/rn-dev-agent-core/dist/worktree-inheritance.js"';
var HEADLESS_WORKTREE_REPAIR_COMMAND = `node ${WORKTREE_REPAIR_ENTRY} repair --app-root "$PWD"`;
var LEGACY_ROOT_REPAIR_REQUIRED = "RN_AGENT_LEGACY_ROOT_REPAIR_REQUIRED";
function legacyRootRepairRemedy(lead) {
  return `${LEGACY_ROOT_REPAIR_REQUIRED}: ${lead} Run ${HEADLESS_WORKTREE_REPAIR_COMMAND}.`;
}

// packages/rn-dev-agent-core/dist/session/worktree-inheritance.js
var SHAREABLE_RESOURCES = [
  {
    id: "rn-agent-actions",
    label: "learned action corpus (.rn-agent/actions)",
    type: "directory",
    anchor: "app",
    path: ".rn-agent/actions",
    parent: ".rn-agent",
    hosts: ["claude", "codex"]
  }
];
var repositoryIdentityEvidence = /* @__PURE__ */ Symbol("repositoryIdentityEvidence");
var GIT_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_NAMESPACE"
];
function gitEnvironment() {
  const env = { ...process.env };
  for (const key of GIT_ENV_OVERRIDES)
    delete env[key];
  return env;
}
function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0)
    return { ok: false, stdout: "" };
  return { ok: true, stdout: (result.stdout ?? "").replace(/\n$/, "") };
}
function canonical(path2) {
  try {
    return realpathSync2(path2);
  } catch {
    return null;
  }
}
function contained(parent, child) {
  if (parent === child)
    return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute2(rel);
}
function toPosix(path2) {
  return sep === "/" ? path2 : path2.split(sep).join("/");
}
function isRnAppRoot(directory) {
  const manifest = join3(directory, "package.json");
  try {
    const parsed = JSON.parse(readFileSync2(manifest, "utf8"));
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    return Boolean(deps["react-native"] || deps["expo"]);
  } catch {
    return false;
  }
}
function parseFirstWorktreeRecord(porcelain) {
  const separator = porcelain.indexOf("\n\n");
  const block = separator === -1 ? porcelain : porcelain.slice(0, separator);
  const lines = block.split("\n");
  const header = lines[0];
  if (!header?.startsWith("worktree "))
    return null;
  const path2 = header.slice("worktree ".length);
  if (!path2)
    return null;
  return {
    path: path2,
    bare: lines.slice(1).includes("bare"),
    prunable: lines.slice(1).some((line) => line === "prunable" || line.startsWith("prunable "))
  };
}
function verifiedPrimary(worktreeRoot, commonDir) {
  const listing = git(worktreeRoot, ["worktree", "list", "--porcelain"]);
  if (!listing.ok)
    return null;
  const main = parseFirstWorktreeRecord(listing.stdout);
  if (!main || main.bare || main.prunable)
    return null;
  const candidate = canonical(main.path);
  if (!candidate)
    return null;
  const topLevelBefore = captureDirectoryIdentity(candidate);
  const commonDirBefore = captureDirectoryIdentity(commonDir);
  if (!topLevelBefore || !commonDirBefore)
    return null;
  const top = git(candidate, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || canonical(top.stdout) !== candidate)
    return null;
  const candidateGitDir = git(candidate, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const candidateCommon = git(candidate, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ]);
  if (!candidateGitDir.ok || !candidateCommon.ok)
    return null;
  const resolvedGitDir = canonical(candidateGitDir.stdout);
  const resolvedCommon = canonical(candidateCommon.stdout);
  if (!resolvedGitDir || !resolvedCommon)
    return null;
  if (resolvedCommon !== commonDir || resolvedGitDir !== resolvedCommon)
    return null;
  const topLevelAfter = captureDirectoryIdentity(candidate);
  const commonDirAfter = captureDirectoryIdentity(commonDir);
  if (!topLevelAfter || !commonDirAfter || topLevelBefore.identity.dev !== topLevelAfter.identity.dev || topLevelBefore.identity.ino !== topLevelAfter.identity.ino || commonDirBefore.identity.dev !== commonDirAfter.identity.dev || commonDirBefore.identity.ino !== commonDirAfter.identity.ino) {
    return null;
  }
  return {
    root: candidate,
    identity: { topLevel: topLevelAfter, commonDir: commonDirAfter }
  };
}
function resolveWorktreeLayout(input) {
  const cwd = canonical(input.cwd);
  if (!cwd)
    return { refusal: "NOT_GIT" };
  const insideWorkTree = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree.ok) {
    const bare = git(cwd, ["rev-parse", "--is-bare-repository"]);
    if (bare.ok && bare.stdout === "true")
      return { refusal: "BARE" };
    return { refusal: "NOT_GIT" };
  }
  if (insideWorkTree.stdout !== "true")
    return { refusal: "BARE" };
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDirRaw = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonRaw = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top.ok || !gitDirRaw.ok || !commonRaw.ok)
    return { refusal: "GIT_UNAVAILABLE" };
  const worktreeRoot = canonical(top.stdout);
  const gitDir = canonical(gitDirRaw.stdout);
  const commonDir = canonical(commonRaw.stdout);
  if (!worktreeRoot || !gitDir || !commonDir)
    return { refusal: "GIT_UNAVAILABLE" };
  const appRootInput = canonical(input.appRoot ? resolve(input.appRoot) : cwd);
  if (!appRootInput)
    return { refusal: "NOT_RN_APP" };
  if (!contained(worktreeRoot, appRootInput))
    return { refusal: "APP_OUTSIDE_WORKTREE" };
  if (!input.allowNonRnApp && !isRnAppRoot(appRootInput))
    return { refusal: "NOT_RN_APP" };
  const appRelative = worktreeRoot === appRootInput ? "." : toPosix(relative(worktreeRoot, appRootInput));
  const base = {
    kind: gitDir === commonDir ? "primary" : "linked",
    worktreeRoot,
    commonDir,
    gitDir,
    appRoot: appRootInput,
    appRelative
  };
  if (base.kind === "primary")
    return base;
  const primary = verifiedPrimary(worktreeRoot, commonDir);
  if (!primary)
    return { ...base, refusal: "NO_PRIMARY" };
  const primaryRoot = primary.root;
  const primaryAppRoot = appRelative === "." ? primaryRoot : join3(primaryRoot, appRelative);
  if (!contained(primaryRoot, primaryAppRoot))
    return { ...base, refusal: "PRIMARY_APP_MISSING" };
  let primaryAppReal = null;
  try {
    if (lstatSync3(primaryAppRoot).isDirectory())
      primaryAppReal = canonical(primaryAppRoot);
  } catch {
    primaryAppReal = null;
  }
  if (!primaryAppReal || !contained(primaryRoot, primaryAppReal)) {
    return { ...base, refusal: "PRIMARY_APP_MISSING" };
  }
  const linked = { ...base, primaryRoot, primaryAppRoot };
  Object.defineProperty(linked, repositoryIdentityEvidence, { value: primary.identity });
  return linked;
}
function classifySource(path2, type, boundary) {
  const rel = relative(boundary, path2);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute2(rel)) {
    return { state: "WRONG_TYPE" };
  }
  const paths = [boundary];
  let cursor = boundary;
  for (const component of rel.split(sep).filter(Boolean)) {
    cursor = join3(cursor, component);
    paths.push(cursor);
  }
  const inspect = () => {
    const evidence = [];
    for (let index = 0; index < paths.length; index += 1) {
      let node;
      try {
        node = lstatSync3(paths[index], { bigint: true });
      } catch (error) {
        const code = error.code;
        if (code === "EACCES" || code === "EPERM")
          return { state: "PERMISSION_DENIED" };
        return { state: "MISSING" };
      }
      if (node.isSymbolicLink())
        return { state: "WRONG_TYPE" };
      const isLeaf = index === paths.length - 1;
      const typeOk = isLeaf ? type === "directory" ? node.isDirectory() : node.isFile() : node.isDirectory();
      if (!typeOk)
        return { state: "WRONG_TYPE" };
      evidence.push({ dev: String(node.dev), ino: String(node.ino) });
    }
    const resolved = canonical(path2);
    if (!resolved || !contained(boundary, resolved))
      return { state: "WRONG_TYPE" };
    return { state: "AVAILABLE", evidence };
  };
  const before = inspect();
  if (before.state !== "AVAILABLE")
    return before;
  const after = inspect();
  if (after.state !== "AVAILABLE" || !sameSourceEvidence(before.evidence, after.evidence)) {
    return { state: "WRONG_TYPE" };
  }
  return after;
}
function sameSourceEvidence(left, right) {
  if (!left || !right)
    return left === right;
  return left.length === right.length && left.every((identity, index) => {
    const candidate = right[index];
    return identity.dev === candidate.dev && identity.ino === candidate.ino;
  });
}
function sourceLeafMatchesIdentity(evidence, identity) {
  const leaf = evidence?.at(-1);
  return leaf?.dev === identity.dev && leaf.ino === identity.ino;
}
function repositoryIdentityUnchanged(identity) {
  return currentIdentityMatches(identity.topLevel.path, identity.topLevel.identity, "directory") && currentIdentityMatches(identity.commonDir.path, identity.commonDir.identity, "directory") && canonical(identity.topLevel.path) === identity.topLevel.path && canonical(identity.commonDir.path) === identity.commonDir.path;
}
function classifyDestination(path2, sourcePath, type) {
  let link;
  try {
    link = lstatSync3(path2, { bigint: true });
  } catch (error) {
    const code = error.code;
    if (code === "EACCES" || code === "EPERM")
      return { state: "PERMISSION_DENIED" };
    return { state: "MISSING" };
  }
  if (!link.isSymbolicLink()) {
    if (link.isDirectory())
      return { state: "DIRECTORY" };
    return { state: "FILE" };
  }
  const evidence = { dev: String(link.dev), ino: String(link.ino) };
  const resolved = canonical(path2);
  if (!resolved)
    return { state: "LINK_STALE", evidence };
  const expected = sourcePath ? canonical(sourcePath) : null;
  if (!expected || resolved !== expected)
    return { state: "LINK_FOREIGN", evidence };
  try {
    const stats = statSync(resolved);
    const typeOk = type === "directory" ? stats.isDirectory() : stats.isFile();
    return { state: typeOk ? "LINK_VALID" : "LINK_FOREIGN", evidence };
  } catch {
    return { state: "LINK_STALE", evidence };
  }
}
function identityOf(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function lstatIfPresent(path2) {
  try {
    return lstatSync3(path2, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT")
      return null;
    throw error;
  }
}
function refuseCorpus(reason) {
  return { status: "refused", reason };
}
function refuseForeignActions(actionsDir) {
  return refuseCorpus(`Refusing foreign learned-action corpus symlink at ${actionsDir}.`);
}
function refuseReplacedActions(actionsDir) {
  return refuseCorpus(`Refusing replaced learned-action corpus symlink at ${actionsDir}.`);
}
function refuseDanglingActions(actionsDir) {
  return refuseCorpus(`Refusing dangling learned-action corpus symlink at ${actionsDir}.`);
}
function directoryIdentityUnchanged(path2, expected) {
  const current = lstatIfPresent(path2);
  return Boolean(current && !current.isSymbolicLink() && current.isDirectory() && String(current.dev) === expected.dev && String(current.ino) === expected.ino);
}
function openUnfollowedDirectory(path2, expected) {
  let fd;
  try {
    fd = openSync2(path2, constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_DIRECTORY);
  } catch {
    return false;
  }
  try {
    const opened = fstatSync2(fd, { bigint: true });
    return opened.isDirectory() && String(opened.dev) === expected.dev && String(opened.ino) === expected.ino;
  } finally {
    closeSync2(fd);
  }
}
function resolveReadableActionCorpus(projectRoot, dependencies = {}) {
  const root = canonical(projectRoot) ?? resolve(projectRoot);
  const projectRootEntry = captureDirectoryIdentity(root);
  if (!projectRootEntry)
    return { status: "absent" };
  const projectRootIdentity = projectRootEntry.identity;
  const rnAgentDir = join3(root, ".rn-agent");
  const actionsDir = join3(rnAgentDir, "actions");
  const rnAgentStat = lstatIfPresent(rnAgentDir);
  if (!rnAgentStat)
    return { status: "absent" };
  if (rnAgentStat.isSymbolicLink() || !rnAgentStat.isDirectory()) {
    return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
  }
  const rnAgentIdentity = identityOf(rnAgentStat);
  if (!openUnfollowedDirectory(rnAgentDir, rnAgentIdentity)) {
    return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
  }
  const actionsStat = lstatIfPresent(actionsDir);
  if (!directoryIdentityUnchanged(rnAgentDir, rnAgentIdentity)) {
    return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
  }
  if (!actionsStat)
    return { status: "absent" };
  if (!actionsStat.isSymbolicLink()) {
    if (!actionsStat.isDirectory())
      return { status: "absent" };
    const identity = identityOf(actionsStat);
    if (!openUnfollowedDirectory(actionsDir, identity)) {
      return refuseReplacedActions(actionsDir);
    }
    if (!directoryIdentityUnchanged(rnAgentDir, rnAgentIdentity)) {
      return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
    }
    if (!directoryIdentityUnchanged(actionsDir, identity)) {
      return refuseReplacedActions(actionsDir);
    }
    if (!directoryIdentityUnchanged(root, projectRootIdentity)) {
      return refuseReplacedActions(actionsDir);
    }
    return {
      status: "owned-directory",
      projectRoot: root,
      projectRootIdentity,
      rnAgentDir,
      rnAgentIdentity,
      actionsDir,
      identity
    };
  }
  const layout = resolveWorktreeLayout({ cwd: root, appRoot: root });
  if (!("kind" in layout) || layout.kind !== "linked" || layout.refusal || !layout.primaryRoot || !layout.primaryAppRoot) {
    return refuseForeignActions(actionsDir);
  }
  const primaryIdentity = layout[repositoryIdentityEvidence];
  if (!primaryIdentity)
    return refuseReplacedActions(actionsDir);
  const linkedIdentity = captureLinkedRepositoryIdentity(layout);
  if (!linkedIdentity)
    return refuseReplacedActions(actionsDir);
  const primaryRnAgentDir = join3(layout.primaryAppRoot, ".rn-agent");
  const primaryActionsDir = join3(primaryRnAgentDir, "actions");
  const planned = planResource(layout, SHAREABLE_RESOURCES[0]);
  if (planned.destinationState === "LINK_STALE")
    return refuseDanglingActions(actionsDir);
  if (planned.state !== "LINK_VALID_SAFE" || !planned.evidence) {
    return refuseCorpus(`Refusing learned-action corpus at ${actionsDir}; setup classified it as ${planned.state}.`);
  }
  if (planned.sourceState !== "AVAILABLE" || !planned.sourceEvidence) {
    return refuseForeignActions(actionsDir);
  }
  dependencies.beforeTargetOpen?.();
  const targetDir = canonical(primaryActionsDir);
  if (!targetDir)
    return refuseForeignActions(actionsDir);
  const targetStat = lstatIfPresent(targetDir);
  if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    return refuseForeignActions(actionsDir);
  }
  const targetIdentity = identityOf(targetStat);
  if (!openUnfollowedDirectory(targetDir, targetIdentity)) {
    return refuseReplacedActions(actionsDir);
  }
  dependencies.afterTargetOpen?.();
  const plannedAfter = planResource(layout, SHAREABLE_RESOURCES[0]);
  if (plannedAfter.state !== "LINK_VALID_SAFE" || !plannedAfter.evidence || plannedAfter.evidence.dev !== planned.evidence.dev || plannedAfter.evidence.ino !== planned.evidence.ino || plannedAfter.sourceState !== "AVAILABLE" || !sameSourceEvidence(planned.sourceEvidence, plannedAfter.sourceEvidence) || !sourceLeafMatchesIdentity(planned.sourceEvidence, targetIdentity) || !sourceLeafMatchesIdentity(plannedAfter.sourceEvidence, targetIdentity) || !directoryIdentityUnchanged(root, projectRootIdentity) || !directoryIdentityUnchanged(rnAgentDir, rnAgentIdentity) || !linkedRepositoryIdentityUnchanged(linkedIdentity) || !repositoryIdentityUnchanged(primaryIdentity)) {
    return refuseReplacedActions(actionsDir);
  }
  return {
    status: "approved-inherited",
    projectRoot: root,
    projectRootIdentity,
    rnAgentDir,
    rnAgentIdentity,
    actionsDir,
    targetDir,
    linkIdentity: planned.evidence,
    targetIdentity,
    primaryRoot: layout.primaryRoot,
    commonDir: layout.commonDir,
    primaryIdentity,
    linkedIdentity
  };
}
var readableActionOperationSequence = 0;
function freezeIdentity(identity) {
  return Object.freeze({ ...identity });
}
function captureDirectoryIdentity(path2) {
  const stat = lstatIfPresent(path2);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory())
    return null;
  return Object.freeze({ path: path2, identity: freezeIdentity(identityOf(stat)) });
}
function captureFileIdentity(path2) {
  const stat = lstatIfPresent(path2);
  if (!stat || stat.isSymbolicLink() || !stat.isFile())
    return null;
  return Object.freeze({ path: path2, identity: freezeIdentity(identityOf(stat)) });
}
function captureLinkedRepositoryIdentity(layout) {
  const worktreeRoot = captureDirectoryIdentity(layout.worktreeRoot);
  const gitEntry = captureFileIdentity(join3(layout.worktreeRoot, ".git"));
  const gitDir = captureDirectoryIdentity(layout.gitDir);
  if (!worktreeRoot || !gitEntry || !gitDir)
    return null;
  return { worktreeRoot, gitEntry, gitDir };
}
function linkedRepositoryIdentityUnchanged(identity) {
  return currentIdentityMatches(identity.worktreeRoot.path, identity.worktreeRoot.identity, "directory") && currentIdentityMatches(identity.gitEntry.path, identity.gitEntry.identity, "file") && currentIdentityMatches(identity.gitDir.path, identity.gitDir.identity, "directory");
}
function captureReadableActionOperationSnapshot(corpus) {
  const operationId = `${process.pid}:${++readableActionOperationSequence}`;
  if (corpus.status === "owned-directory") {
    if (!directoryIdentityUnchanged(corpus.projectRoot, corpus.projectRootIdentity) || !directoryIdentityUnchanged(corpus.rnAgentDir, corpus.rnAgentIdentity)) {
      throw new Error(refuseReplacedActions(corpus.actionsDir).reason);
    }
    return Object.freeze({
      operationId,
      kind: corpus.status,
      projectRoot: corpus.projectRoot,
      projectRootIdentity: freezeIdentity(corpus.projectRootIdentity),
      rnAgentDir: corpus.rnAgentDir,
      rnAgentIdentity: freezeIdentity(corpus.rnAgentIdentity),
      actionsDir: corpus.actionsDir,
      directory: corpus.actionsDir,
      directoryIdentity: freezeIdentity(corpus.identity)
    });
  }
  if (corpus.status === "approved-inherited") {
    if (!directoryIdentityUnchanged(corpus.projectRoot, corpus.projectRootIdentity) || !directoryIdentityUnchanged(corpus.rnAgentDir, corpus.rnAgentIdentity) || !repositoryIdentityUnchanged(corpus.primaryIdentity)) {
      throw new Error(refuseReplacedActions(corpus.actionsDir).reason);
    }
    return Object.freeze({
      operationId,
      kind: corpus.status,
      projectRoot: corpus.projectRoot,
      projectRootIdentity: freezeIdentity(corpus.projectRootIdentity),
      rnAgentDir: corpus.rnAgentDir,
      rnAgentIdentity: freezeIdentity(corpus.rnAgentIdentity),
      actionsDir: corpus.actionsDir,
      directory: corpus.targetDir,
      directoryIdentity: freezeIdentity(corpus.targetIdentity),
      linkIdentity: freezeIdentity(corpus.linkIdentity),
      linkedIdentity: Object.freeze({
        worktreeRoot: Object.freeze({
          path: corpus.linkedIdentity.worktreeRoot.path,
          identity: freezeIdentity(corpus.linkedIdentity.worktreeRoot.identity)
        }),
        gitEntry: Object.freeze({
          path: corpus.linkedIdentity.gitEntry.path,
          identity: freezeIdentity(corpus.linkedIdentity.gitEntry.identity)
        }),
        gitDir: Object.freeze({
          path: corpus.linkedIdentity.gitDir.path,
          identity: freezeIdentity(corpus.linkedIdentity.gitDir.identity)
        })
      }),
      primaryIdentity: Object.freeze({
        topLevel: Object.freeze({
          path: corpus.primaryIdentity.topLevel.path,
          identity: freezeIdentity(corpus.primaryIdentity.topLevel.identity)
        }),
        commonDir: Object.freeze({
          path: corpus.primaryIdentity.commonDir.path,
          identity: freezeIdentity(corpus.primaryIdentity.commonDir.identity)
        })
      })
    });
  }
  return null;
}
function currentIdentityMatches(path2, expected, kind) {
  const current = lstatIfPresent(path2);
  if (!current)
    return false;
  const typeMatches = kind === "directory" ? current.isDirectory() : kind === "file" ? current.isFile() && !current.isSymbolicLink() : current.isSymbolicLink();
  return typeMatches && String(current.dev) === expected.dev && String(current.ino) === expected.ino;
}
function assertReadableActionOperationUnchanged(snapshot) {
  let unchanged = canonical(snapshot.projectRoot) === snapshot.projectRoot && currentIdentityMatches(snapshot.projectRoot, snapshot.projectRootIdentity, "directory") && currentIdentityMatches(snapshot.rnAgentDir, snapshot.rnAgentIdentity, "directory");
  if (snapshot.kind === "owned-directory") {
    unchanged = unchanged && currentIdentityMatches(snapshot.actionsDir, snapshot.directoryIdentity, "directory") && canonical(snapshot.actionsDir) === snapshot.directory;
  } else {
    unchanged = unchanged && Boolean(snapshot.linkIdentity && snapshot.linkedIdentity && snapshot.primaryIdentity) && currentIdentityMatches(snapshot.actionsDir, snapshot.linkIdentity, "symlink") && currentIdentityMatches(snapshot.directory, snapshot.directoryIdentity, "directory") && currentIdentityMatches(snapshot.linkedIdentity.worktreeRoot.path, snapshot.linkedIdentity.worktreeRoot.identity, "directory") && currentIdentityMatches(snapshot.linkedIdentity.gitEntry.path, snapshot.linkedIdentity.gitEntry.identity, "file") && currentIdentityMatches(snapshot.linkedIdentity.gitDir.path, snapshot.linkedIdentity.gitDir.identity, "directory") && currentIdentityMatches(snapshot.primaryIdentity.topLevel.path, snapshot.primaryIdentity.topLevel.identity, "directory") && currentIdentityMatches(snapshot.primaryIdentity.commonDir.path, snapshot.primaryIdentity.commonDir.identity, "directory") && canonical(snapshot.actionsDir) === snapshot.directory && canonical(snapshot.directory) === snapshot.directory && canonical(snapshot.primaryIdentity.topLevel.path) === snapshot.primaryIdentity.topLevel.path && canonical(snapshot.primaryIdentity.commonDir.path) === snapshot.primaryIdentity.commonDir.path;
  }
  if (!unchanged)
    throw new Error(refuseReplacedActions(snapshot.actionsDir).reason);
}
function isTracked(worktreeRoot, relativePath) {
  const listed = git(worktreeRoot, ["ls-files", "--", relativePath]);
  return listed.ok && listed.stdout.trim().length > 0;
}
function isIgnoreSafe(worktreeRoot, relativePath) {
  const result = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", relativePath], {
    cwd: worktreeRoot,
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: "ignore"
  });
  return !result.error && result.status === 0;
}
function anchorFor(layout, resource) {
  if (resource.anchor === "worktree-root") {
    return { local: layout.worktreeRoot, source: layout.primaryRoot ?? "" };
  }
  return { local: layout.appRoot, source: layout.primaryAppRoot ?? "" };
}
function destinationRelative(layout, resource) {
  if (resource.anchor === "worktree-root")
    return resource.path;
  return layout.appRelative === "." ? resource.path : `${layout.appRelative}/${resource.path}`;
}
function planResource(layout, resource) {
  const anchor = anchorFor(layout, resource);
  const destination = join3(anchor.local, resource.path);
  const destinationRel = destinationRelative(layout, resource);
  const source = anchor.source ? join3(anchor.source, resource.path) : void 0;
  const sourceBoundary = layout.primaryRoot;
  const sourceBefore = source && sourceBoundary ? classifySource(source, resource.type, sourceBoundary) : { state: "MISSING" };
  const { state: destinationState, evidence } = classifyDestination(destination, sourceBefore.state === "AVAILABLE" ? source : void 0, resource.type);
  const sourceAfter = source && sourceBoundary ? classifySource(source, resource.type, sourceBoundary) : { state: "MISSING" };
  const sourceStable = sourceBefore.state === sourceAfter.state && sameSourceEvidence(sourceBefore.evidence, sourceAfter.evidence);
  const sourceState = sourceStable ? sourceAfter.state : "WRONG_TYPE";
  const sourceEvidence = sourceStable ? sourceAfter.evidence : void 0;
  const linkedParent = resource.parent !== void 0 ? classifyLegacyParent(layout, anchor.local, resource.parent) : null;
  const parentRelative = resource.parent === void 0 ? void 0 : toPosix(layout.appRelative === "." ? resource.parent : `${layout.appRelative}/${resource.parent}`);
  const ignoreSafe = isIgnoreSafe(layout.worktreeRoot, destinationRel) || linkedParent !== null && parentRelative !== void 0 && (isIgnoreSafe(layout.worktreeRoot, parentRelative) || isIgnoreSafe(layout.worktreeRoot, `${parentRelative}/`));
  const base = {
    id: resource.id,
    label: resource.label,
    destination: toPosix(destinationRel),
    sourceState,
    destinationState,
    ignoreSafe,
    evidence,
    sourceEvidence
  };
  const gitManaged = isTracked(layout.worktreeRoot, destinationRel) || resource.parent !== void 0 && isTracked(layout.worktreeRoot, toPosix(layout.appRelative === "." ? resource.parent : `${layout.appRelative}/${resource.parent}`));
  if (gitManaged) {
    return {
      ...base,
      regime: "GIT_MANAGED",
      state: "TRACKED",
      action: "none",
      remediation: "Git owns this path; the tracked/team regime is never replaced or inherited."
    };
  }
  const regime = sourceState === "AVAILABLE" ? "PRIVATE_SOURCE_AVAILABLE" : "NO_SOURCE";
  if (linkedParent) {
    if (linkedParent !== "expected") {
      return {
        ...base,
        regime,
        state: "LINK_FOREIGN",
        action: "none",
        remediation: `The whole "${resource.parent}" directory is a foreign symlink. Nothing is read from or written through it.`
      };
    }
    if (sourceState !== "AVAILABLE") {
      return {
        ...base,
        regime,
        state: sourceState === "WRONG_TYPE" ? "SOURCE_WRONG_TYPE" : "SOURCE_MISSING",
        action: "none",
        remediation: "The legacy root link is recognized, but the canonical actions source is unavailable."
      };
    }
    return {
      ...base,
      regime,
      state: "LEGACY_ROOT_LINK",
      action: "none",
      remediation: legacyRootRepairRemedy("A legacy whole-root link was detected; startup and reconnect never mutate it.")
    };
  }
  if (destinationState === "PERMISSION_DENIED" || sourceState === "PERMISSION_DENIED") {
    return {
      ...base,
      regime,
      state: "PERMISSION_DENIED",
      action: "none",
      remediation: "Permission denied while inspecting this path; fix permissions and re-run."
    };
  }
  if (destinationState === "FILE") {
    return { ...base, regime, state: "COLLISION_FILE", action: "none", remediation: LOCAL_CONTENT };
  }
  if (destinationState === "DIRECTORY") {
    return {
      ...base,
      regime,
      state: "COLLISION_DIRECTORY",
      action: "none",
      remediation: LOCAL_CONTENT
    };
  }
  if (destinationState === "LINK_VALID") {
    if (sourceState !== "AVAILABLE") {
      return {
        ...base,
        regime,
        state: sourceState === "WRONG_TYPE" ? "SOURCE_WRONG_TYPE" : "SOURCE_MISSING",
        action: "none",
        remediation: "The existing link no longer has a safe canonical source."
      };
    }
    return {
      ...base,
      regime,
      state: ignoreSafe ? "LINK_VALID_SAFE" : "LINK_VALID_GIT_VISIBLE",
      action: "none",
      remediation: ignoreSafe ? void 0 : ignoreRemediation(base.destination)
    };
  }
  if (destinationState === "LINK_FOREIGN") {
    return {
      ...base,
      regime,
      state: "LINK_FOREIGN",
      action: "none",
      remediation: "Destination is a symlink to something else; /rn-dev-agent:setup can re-point it after explicit confirmation."
    };
  }
  if (destinationState === "LINK_STALE") {
    if (sourceState !== "AVAILABLE") {
      return {
        ...base,
        regime,
        state: "LINK_STALE_SOURCE_MISSING",
        action: "none",
        remediation: "Destination is a broken symlink and no canonical source is available; restore the source first."
      };
    }
    return {
      ...base,
      regime,
      state: "LINK_STALE_SOURCE_AVAILABLE",
      action: "repair",
      remediation: "Run /rn-dev-agent:setup to repair the broken link after confirmation."
    };
  }
  if (sourceState === "MISSING") {
    return {
      ...base,
      regime,
      state: "SOURCE_MISSING",
      action: "none",
      remediation: "No canonical source in the primary worktree; nothing to inherit."
    };
  }
  if (sourceState === "WRONG_TYPE") {
    return {
      ...base,
      regime,
      state: "SOURCE_WRONG_TYPE",
      action: "none",
      remediation: `Canonical source is not a ${resource.type}; refusing to link.`
    };
  }
  if (!ignoreSafe) {
    return {
      ...base,
      regime,
      state: "IGNORE_UNSAFE",
      action: "none",
      remediation: ignoreRemediation(base.destination)
    };
  }
  return { ...base, regime, state: "DEST_MISSING", action: "link" };
}
var LOCAL_CONTENT = "Local real content is present; it is never overwritten and is not shared.";
function ignoreRemediation(destination) {
  return `Git would see this path. Add the file-form rule "/${destination}" (no trailing slash) to your own local ignore policy, then re-run.`;
}
function classifyLegacyParent(layout, localAnchor, parent) {
  const localParent = join3(localAnchor, parent);
  let stats;
  try {
    stats = lstatSync3(localParent);
  } catch {
    return null;
  }
  if (!stats.isSymbolicLink())
    return null;
  const resolved = canonical(localParent);
  const expected = layout.primaryAppRoot ? canonical(join3(layout.primaryAppRoot, parent)) : null;
  return resolved && expected && resolved === expected ? "expected" : "foreign";
}

// packages/rn-dev-agent-core/dist/learned-actions.js
var argv = process.argv.slice(2);
var flags = {
  json: false,
  filter: "",
  appId: "",
  memoryCwd: process.cwd(),
  workspaceRoot: process.cwd(),
  section: "all",
  max: 50
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json")
    flags.json = true;
  else if (a === "--filter")
    flags.filter = (argv[++i] || "").toLowerCase();
  else if (a === "--appId")
    flags.appId = argv[++i] || "";
  else if (a === "--memory-cwd")
    flags.memoryCwd = argv[++i] || process.cwd();
  else if (a === "--workspace-root")
    flags.workspaceRoot = argv[++i] || process.cwd();
  else if (a === "--section")
    flags.section = (argv[++i] || "all").toLowerCase();
  else if (a === "--max") {
    const m = parseInt(argv[++i] || "50", 10);
    flags.max = Number.isNaN(m) ? 50 : m;
  } else if (a === "--help" || a === "-h") {
    console.log(`Usage: learned-actions [--json] [--filter KW] [--appId ID]
                               [--memory-cwd PATH] [--workspace-root PATH]
                               [--section a|b|c|d|all] [--max N]`);
    process.exit(0);
  } else {
    process.stderr.write(`unknown flag: ${a}
`);
    process.exit(2);
  }
}
var matchKw = (...fields) => !flags.filter || fields.some((f) => (f || "").toString().toLowerCase().includes(flags.filter));
function scanMemories() {
  const encoded = flags.memoryCwd.replace(/[^a-zA-Z0-9]/g, "-");
  const memDir = path.join(os.homedir(), ".claude", "projects", encoded, "memory");
  if (!fs.existsSync(memDir))
    return { exists: false, dir: memDir, items: [] };
  const items = [];
  for (const f of fs.readdirSync(memDir)) {
    if (!f.startsWith("feedback_") || !f.endsWith(".md"))
      continue;
    const fp = path.join(memDir, f);
    const text = fs.readFileSync(fp, "utf8");
    const fm = parseFrontmatter(text);
    if (!matchKw(fm["name"], fm["description"], f))
      continue;
    items.push({
      file: f,
      path: fp,
      name: fm["name"] || f.replace(/\.md$/, ""),
      description: truncate(fm["description"] || firstParagraph(stripFrontmatter(text)), 160),
      type: fm["type"] || "feedback"
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { exists: true, dir: memDir, items: items.slice(0, flags.max) };
}
function resolveFlowFile(files, id) {
  const yamlPath = `${id}.yaml`;
  const ymlPath = `${id}.yml`;
  const yamlExists = files.includes(yamlPath);
  const ymlExists = files.includes(ymlPath);
  if (yamlExists && ymlExists)
    return null;
  if (yamlExists)
    return yamlPath;
  if (ymlExists)
    return ymlPath;
  return null;
}
function openFlowRootOperation(actionsDir) {
  if (path.basename(actionsDir) !== "actions" || path.basename(path.dirname(actionsDir)) !== ".rn-agent") {
    return null;
  }
  const corpus = resolveReadableActionCorpus(path.dirname(path.dirname(actionsDir)));
  if (corpus.status === "refused")
    throw new Error(corpus.reason);
  if (corpus.status !== "owned-directory" && corpus.status !== "approved-inherited")
    return null;
  return captureReadableActionOperationSnapshot(corpus);
}
function scanFlows() {
  const roots = collectFlowRoots(flags.workspaceRoot);
  const items = [];
  for (const root of roots) {
    const operation = openFlowRootOperation(root);
    if (!operation)
      continue;
    const files = listUnfollowedDirectory(operation.directory, operation.directoryIdentity);
    assertReadableActionOperationUnchanged(operation);
    const ids = [
      ...new Set(files.filter((file) => /\.ya?ml$/.test(file)).map((file) => file.replace(/\.ya?ml$/, "")))
    ];
    const flowFiles = ids.map((id) => resolveFlowFile(files, id));
    const readableFlowFiles = flowFiles.filter((file) => file !== null);
    const fileSnapshot = createUnfollowedFileSnapshot(operation.directory, operation.directoryIdentity);
    const flowTexts = readUnfollowedSnapshotFiles(fileSnapshot, readableFlowFiles);
    assertReadableActionOperationUnchanged(operation);
    const textByFile = new Map(readableFlowFiles.map((file, index) => [file, flowTexts[index]]));
    const rootItems = [];
    for (const id of ids) {
      const f = resolveFlowFile(files, id);
      if (!f)
        continue;
      const reportedPath = path.join(root, f);
      const text = textByFile.get(f);
      if (text == null)
        continue;
      const meta = parseFlowMeta(text);
      if (flags.appId && meta.appId !== flags.appId)
        continue;
      const tagsStr = (meta.tags || []).join(",");
      if (!matchKw(meta.purpose, meta.appId, meta.intent, tagsStr, f, reportedPath))
        continue;
      const params = (text.match(/\$\{([A-Z_][A-Z0-9_]*)\}/g) || []).map((s) => s.slice(2, -1));
      const uniqParams = Array.from(new Set(params));
      const replay = replayHint(meta.id, reportedPath, uniqParams);
      rootItems.push({
        flow: f.replace(/\.ya?ml$/, ""),
        path: reportedPath,
        appId: meta.appId,
        purpose: truncate(meta.purpose, 140),
        id: meta.id,
        intent: meta.intent,
        tags: meta.tags,
        mutates: meta.mutates,
        status: meta.status,
        params: uniqParams,
        produces: meta.produces,
        metaFormat: meta.metaFormat,
        metaInvalid: meta.metaInvalid,
        replay
      });
    }
    assertReadableActionOperationUnchanged(operation);
    assertUnfollowedFileSnapshotUnchanged(fileSnapshot);
    items.push(...rootItems);
  }
  items.sort((a, b) => a.flow.localeCompare(b.flow));
  return { items: items.slice(0, flags.max), roots };
}
function replayHint(id, flowPath, params) {
  const paramObj = params.length > 0 ? `, params: { ${params.map((p) => `${p}: "..."`).join(", ")} }` : "";
  const actionsDir = path.dirname(flowPath);
  const canonicalYaml = id !== null && path.basename(flowPath).replace(/\.ya?ml$/, "") === id && path.basename(actionsDir) === "actions" && path.basename(path.dirname(actionsDir)) === ".rn-agent";
  if (canonicalYaml) {
    const projectRoot = path.dirname(path.dirname(actionsDir));
    return `cdp_run_action({ actionId: "${id}", projectRoot: "${projectRoot}"${paramObj} })`;
  }
  return `maestro_run({ flowPath: "${flowPath}"${paramObj} })`;
}
function collectFlowRoots(start) {
  const candidates = /* @__PURE__ */ new Set();
  const own = path.join(start, ".rn-agent", "actions");
  candidates.add(own);
  const parent = path.dirname(start);
  if (fs.existsSync(parent)) {
    for (const sib of safeReaddir(parent)) {
      const ta = path.join(parent, sib, "test-app", ".rn-agent", "actions");
      if (fs.existsSync(ta))
        candidates.add(ta);
    }
  }
  const ta2 = path.join(start, "test-app", ".rn-agent", "actions");
  if (fs.existsSync(ta2))
    candidates.add(ta2);
  return Array.from(candidates);
}
function parseFlowMeta(text) {
  const appIdMatch = text.match(/^appId:\s*([^\s#]+)/m);
  const lines = text.split("\n");
  const purposeLines = [];
  const meta = {
    id: null,
    intent: null,
    tags: null,
    mutates: null,
    status: null,
    produces: null
  };
  const META_KEYS = /* @__PURE__ */ new Set(["id", "intent", "tags", "mutates", "status", "produces"]);
  const presentKeys = /* @__PURE__ */ new Set();
  const invalidKeys = [];
  let inComment = false;
  for (const line of lines) {
    if (line.startsWith("#")) {
      inComment = true;
      const stripped = line.replace(/^#\s?/, "").trim();
      if (!stripped)
        continue;
      const kv = stripped.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
      if (kv && META_KEYS.has(kv[1])) {
        const key = kv[1];
        const raw = kv[2].trim();
        presentKeys.add(key);
        if (key === "tags") {
          meta.tags = raw.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean);
        } else if (key === "mutates") {
          if (/^(true|false)$/i.test(raw)) {
            meta.mutates = /^true$/i.test(raw);
          } else {
            invalidKeys.push("mutates");
          }
        } else if (key === "produces") {
          meta.produces = parseProducesMap(raw);
          if (meta.produces === null)
            invalidKeys.push("produces");
        } else {
          meta[key] = raw;
        }
        continue;
      }
      purposeLines.push(stripped);
    } else if (inComment && line.trim() === "") {
      if (purposeLines.length)
        break;
    } else if (inComment) {
      break;
    }
  }
  const fallbackPurpose = purposeLines.length ? purposeLines.join(" ") : "(no description comment)";
  const purpose = meta.intent || fallbackPurpose;
  return {
    appId: appIdMatch ? appIdMatch[1] : null,
    purpose,
    id: meta.id,
    intent: meta.intent,
    tags: meta.tags,
    mutates: meta.mutates,
    status: meta.status,
    produces: meta.produces,
    metaFormat: presentKeys.size > 0 ? "m7" : "pre-m7",
    metaInvalid: invalidKeys
  };
}
function parseProducesMap(raw) {
  const trimmed = raw.trim();
  if (/^\{\s*\}$/.test(trimmed))
    return {};
  const inner = trimmed.replace(/^\{|\}$/g, "").trim();
  if (!inner)
    return null;
  const result = {};
  for (const part of inner.split(",")) {
    const kv = part.match(/^\s*([a-zA-Z_][\w.-]*)\s*:\s*(.+?)\s*$/);
    if (!kv)
      return null;
    const key = kv[1];
    const valueRaw = kv[2].trim();
    if (/^(true|false)$/i.test(valueRaw)) {
      result[key] = /^true$/i.test(valueRaw);
    } else if (/^-?\d+(\.\d+)?$/.test(valueRaw)) {
      result[key] = Number(valueRaw);
    } else {
      result[key] = valueRaw.replace(/^['"]|['"]$/g, "");
    }
  }
  return result;
}
function scanSkeletons() {
  const candidates = [
    path.join(flags.workspaceRoot, ".rn-agent", "skeleton.yaml"),
    path.join(flags.workspaceRoot, "test-app", ".rn-agent", "skeleton.yaml")
  ];
  const parent = path.dirname(flags.workspaceRoot);
  if (fs.existsSync(parent)) {
    for (const sib of safeReaddir(parent)) {
      candidates.push(path.join(parent, sib, "test-app", ".rn-agent", "skeleton.yaml"));
    }
  }
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const fp of candidates) {
    if (!fs.existsSync(fp))
      continue;
    const real = fs.realpathSync(fp);
    if (seen.has(real))
      continue;
    seen.add(real);
    const text = fs.readFileSync(fp, "utf8");
    const appIdMatch = text.match(/^appId:\s*([^\s#]+)/m);
    const screenKeys = (text.match(/^  [a-z][^:]*:\s*$/gm) || []).map((s) => s.trim().replace(/:$/, "")).filter((k) => !["screens", "navigation"].includes(k));
    const testIdCount = (text.match(/^[ \t]+[a-z][^:]*:\s+[a-z][^\s#]+/gim) || []).length;
    if (!matchKw(fp, appIdMatch ? appIdMatch[1] : ""))
      continue;
    items.push({
      path: fp,
      appId: appIdMatch ? appIdMatch[1] : null,
      screens: screenKeys.length,
      testIds: testIdCount
    });
  }
  return { items };
}
function scanPluginCommands() {
  const dir = path.join(flags.workspaceRoot, "commands");
  if (!fs.existsSync(dir))
    return { items: [] };
  const items = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md"))
      continue;
    const fp = path.join(dir, f);
    const text = fs.readFileSync(fp, "utf8");
    const fm = parseFrontmatter(text);
    if (!fm["command"] && !fm["description"])
      continue;
    const name = fm["command"] || f.replace(/\.md$/, "");
    if (!matchKw(name, fm["description"], f))
      continue;
    items.push({
      command: `/rn-dev-agent:${name}`,
      description: truncate(fm["description"] || "(no description)", 160),
      path: fp
    });
  }
  items.sort((a, b) => a.command.localeCompare(b.command));
  return { items: items.slice(0, flags.max) };
}
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m)
    return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const km = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (km) {
      let v = km[2].trim();
      if (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'")) {
        v = v.slice(1, -1);
      }
      out[km[1]] = v;
    }
  }
  return out;
}
function stripFrontmatter(text) {
  return text.replace(/^---\s*\n[\s\S]*?\n---\n?/, "");
}
function firstParagraph(text) {
  const trimmed = text.trim();
  const idx = trimmed.indexOf("\n\n");
  return (idx === -1 ? trimmed : trimmed.slice(0, idx)).replace(/\s+/g, " ").trim();
}
function truncate(s, n) {
  if (!s)
    return "";
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "\u2026";
}
function safeReaddir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}
var want = (s) => flags.section === "all" || flags.section === s;
var memories = want("a") ? scanMemories() : { items: [], exists: false, dir: void 0 };
var flows = want("b") ? scanFlows() : { items: [], roots: [] };
var skeletons = want("c") ? scanSkeletons() : { items: [] };
var commands = want("d") ? scanPluginCommands() : { items: [] };
var total = memories.items.length + flows.items.length + skeletons.items.length + commands.items.length;
if (flags.json) {
  process.stdout.write(JSON.stringify({
    cwd: process.cwd(),
    memoryCwd: flags.memoryCwd,
    filter: flags.filter || null,
    sections: {
      memories: { count: memories.items.length, dir: memories.dir, items: memories.items },
      flows: { count: flows.items.length, roots: flows.roots, items: flows.items },
      skeletons: { count: skeletons.items.length, items: skeletons.items },
      commands: { count: commands.items.length, items: commands.items }
    },
    total
  }, null, 2) + "\n");
  process.exit(total === 0 ? 3 : 0);
}
var parts = [];
parts.push(`# Learned actions${flags.filter ? ` (filter: "${flags.filter}")` : ""}`);
parts.push("");
if (want("a")) {
  parts.push(`## A. Feedback memories (${memories.items.length})`);
  if (!memories.exists) {
    parts.push(`_No memory directory at ${memories.dir}_`);
  } else if (memories.items.length === 0) {
    parts.push("_None match._");
  } else {
    parts.push("| Name | Description | File |");
    parts.push("|---|---|---|");
    for (const m of memories.items) {
      parts.push(`| ${escapeMarkdownTableCell(m.name)} | ${escapeMarkdownTableCell(m.description)} | \`${m.file}\` |`);
    }
  }
  parts.push("");
}
if (want("b")) {
  parts.push(`## B. Reusable Maestro flows (${flows.items.length})`);
  parts.push("_Source: `.rn-agent/actions/`._");
  if (flows.items.length === 0) {
    parts.push("_None match._");
    if (flows.roots.length) {
      parts.push(`_Searched: ${flows.roots.map((r) => "`" + r + "`").join(", ")}_`);
    }
  } else {
    parts.push("| Flow | Purpose | App ID | Mutates | Status | Tags | Produces | Replay |");
    parts.push("|---|---|---|---|---|---|---|---|");
    for (const f of flows.items) {
      const absent = f.metaFormat === "pre-m7" ? "pre-M7" : "-";
      const mut = f.mutates === null || f.mutates === void 0 ? f.metaInvalid.includes("mutates") ? "?" : absent : f.mutates ? "yes" : "no";
      const status = f.status || absent;
      const tags = f.tags ? f.tags.length ? f.tags.join(", ") : "-" : absent;
      const produces = f.produces ? Object.keys(f.produces).length ? formatProducesCell(f.produces) : "-" : f.metaInvalid.includes("produces") ? "?" : absent;
      parts.push(`| \`${f.flow}\` | ${escapeMarkdownTableCell(f.purpose)} | \`${f.appId || "?"}\` | ${mut} | ${status} | ${escapeMarkdownTableCell(tags)} | ${escapeMarkdownTableCell(produces)} | \`${f.replay}\` |`);
    }
  }
  parts.push("");
}
if (want("c")) {
  parts.push(`## C. UI skeletons (${skeletons.items.length})`);
  if (skeletons.items.length === 0) {
    parts.push("_None found._");
  } else {
    parts.push("| Path | App ID | Screens | testIDs |");
    parts.push("|---|---|---|---|");
    for (const s of skeletons.items) {
      parts.push(`| \`${s.path}\` | \`${s.appId || "?"}\` | ${s.screens} | ${s.testIds} |`);
    }
  }
  parts.push("");
}
if (want("d")) {
  parts.push(`## D. Plugin commands (${commands.items.length})`);
  if (commands.items.length === 0) {
    parts.push("_Not running inside the plugin repo._");
  } else {
    for (const c of commands.items) {
      parts.push(`- \`${c.command}\` \u2014 ${escapeMarkdownTableCell(c.description)}`);
    }
  }
  parts.push("");
}
parts.push("---");
parts.push("**Reminder:** For any UI flow, replay a compatible owned action from section B through `cdp_run_action` before composing `device_*` primitives. Missing or incompatible owned automation is terminal; manual walks are not an authorized fallback.");
process.stdout.write(parts.join("\n") + "\n");
process.exit(total === 0 ? 3 : 0);
function escapeMarkdownTableCell(s) {
  return (s || "").toString().replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function formatProducesCell(produces) {
  const keys = Object.keys(produces).sort();
  return keys.map((k) => `${k}=${produces[k]}`).join(", ");
}
