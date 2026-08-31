#!/usr/bin/env node
import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// packages/rn-dev-agent-core/dist/util/trusted-system-executable.js
import { existsSync } from "node:fs";
import { win32 } from "node:path";
function trustedWindowsRoots(environment) {
  return [
    ...new Set([environment.SystemRoot, environment.SYSTEMROOT, environment.windir, environment.WINDIR].filter((root2) => typeof root2 === "string" && /^[a-z]:\\/i.test(root2) && win32.basename(win32.normalize(root2)).toLowerCase() === "windows").map((root2) => win32.normalize(root2)).concat("C:\\Windows"))
  ];
}
function resolveTrustedSystemExecutable(executable, platform, dependencies = {}) {
  const exists = dependencies.exists ?? existsSync;
  const environment = dependencies.environment ?? process.env;
  let candidates;
  if (platform === "win32" && executable === "powershell") {
    candidates = trustedWindowsRoots(environment).map((root2) => win32.join(root2, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  } else if (platform === "win32" && executable === "taskkill") {
    candidates = trustedWindowsRoots(environment).map((root2) => win32.join(root2, "System32", "taskkill.exe"));
  } else if (platform === "linux" && executable === "ss") {
    candidates = ["/usr/bin/ss", "/usr/sbin/ss", "/bin/ss", "/sbin/ss"];
  } else if (platform === "linux" && executable === "lsof") {
    candidates = ["/usr/bin/lsof", "/usr/sbin/lsof", "/bin/lsof", "/sbin/lsof"];
  } else if (platform === "linux" && executable === "ps") {
    candidates = ["/usr/bin/ps", "/bin/ps"];
  } else if (platform === "darwin" && executable === "lsof") {
    candidates = ["/usr/sbin/lsof"];
  } else if (platform === "darwin" && executable === "ps") {
    candidates = ["/bin/ps", "/usr/bin/ps"];
  } else {
    return null;
  }
  return candidates.find(exists) ?? null;
}
var init_trusted_system_executable = __esm({
  "packages/rn-dev-agent-core/dist/util/trusted-system-executable.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/session/process-birth.js
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, chmodSync, constants, copyFileSync, existsSync as existsSync2, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function defaultRun(command, args) {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
  } catch (error) {
    if (command === "/bin/ps" && typeof error === "object" && error !== null && "status" in error && error.status === 1) {
      return "";
    }
    throw error;
  }
}
function defaultRunVerifiedHelper(path, pid, requirement) {
  return execFileSync("/bin/zsh", ["-f", "-c", VERIFIED_HELPER_SCRIPT, "rn-process-birth", path, String(pid), requirement], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2e3
  });
}
function token(parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
function darwinProcessBirthHelperPath() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "native", "darwin-process-birth"),
    join(moduleDirectory, "..", "native", "darwin-process-birth")
  ];
  for (const candidate of candidates) {
    if (existsSync2(candidate))
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
  const readBinary = dependencies.readBinary ?? ((path) => readFileSync(path));
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
function verifiedNativePublicationHelper() {
  if (process.platform === "darwin") {
    const helper = verifyDarwinProcessBirthHelper({});
    return { path: helper.path, sha256: DARWIN_HELPER_MANIFEST.binarySha256 };
  }
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    return {
      path: verifiedLinuxPublicationHelper(process.arch),
      sha256: LINUX_PUBLICATION_HELPER_SHA256[process.arch]
    };
  }
  throw new Error("Native runner execution binding is unavailable on this platform.");
}
function publishFileIfUnchangedDarwin(targetFd, targetPath, candidatePath, expectedPath) {
  if (process.platform === "linux") {
    return publishFileIfUnchangedLinux(targetFd, targetPath, candidatePath, expectedPath);
  }
  if (process.platform !== "darwin")
    return false;
  const target = fstatSync(targetFd);
  if (!target.isFile())
    return false;
  const helper = verifyDarwinProcessBirthHelper({});
  const boundPath = `${helper.path}.publish.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  copyFileSync(helper.path, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(boundPath, 448);
  try {
    const digest = createHash("sha256").update(readFileSync(boundPath)).digest("hex");
    if (digest !== DARWIN_HELPER_MANIFEST.binarySha256) {
      throw new Error("Conditional action publication helper changed before execution.");
    }
    execFileSync(boundPath, [
      "--publish-if-unchanged",
      targetPath,
      candidatePath,
      expectedPath,
      String(target.dev),
      String(target.ino)
    ], { stdio: "ignore", timeout: 2e3 });
    return true;
  } catch (error) {
    if (error.status === 10)
      return false;
    throw error;
  } finally {
    unlinkSync(boundPath);
  }
}
function linkFileIntoVerifiedDirectory(directoryFd, candidatePath, targetPath) {
  const directory = fstatSync(directoryFd);
  if (!directory.isDirectory() || dirname(targetPath) === targetPath)
    return false;
  if (process.platform === "darwin") {
    const helper = verifyDarwinProcessBirthHelper({});
    return runVerifiedPublicationHelper(helper.path, DARWIN_HELPER_MANIFEST.binarySha256, [
      "--link-into-directory",
      candidatePath,
      dirname(targetPath),
      targetPath.slice(dirname(targetPath).length + 1),
      String(directory.dev),
      String(directory.ino)
    ]);
  }
  if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
    const helperPath = verifiedLinuxPublicationHelper(process.arch);
    return runVerifiedPublicationHelper(helperPath, LINUX_PUBLICATION_HELPER_SHA256[process.arch], [
      "--link-into-directory",
      candidatePath,
      dirname(targetPath),
      targetPath.slice(dirname(targetPath).length + 1),
      String(directory.dev),
      String(directory.ino)
    ]);
  }
  return false;
}
function runVerifiedPublicationHelper(helperPath, expectedSha256, args) {
  const boundPath = `${helperPath}.publish.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  copyFileSync(helperPath, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(boundPath, 448);
  try {
    if (createHash("sha256").update(readFileSync(boundPath)).digest("hex") !== expectedSha256) {
      throw new Error("Conditional action publication helper changed before execution.");
    }
    execFileSync(boundPath, [...args], { stdio: "ignore", timeout: 2e3 });
    return true;
  } catch (error) {
    if (error.status === 10)
      return false;
    throw error;
  } finally {
    unlinkSync(boundPath);
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
    if (existsSync2(candidate))
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
function publishFileIfUnchangedLinux(targetFd, targetPath, candidatePath, expectedPath) {
  if (process.platform !== "linux" || process.arch !== "x64" && process.arch !== "arm64") {
    return false;
  }
  const architecture = process.arch;
  const helperPath = verifiedLinuxPublicationHelper(architecture);
  const target = fstatSync(targetFd);
  if (!target.isFile())
    return false;
  const boundPath = `${helperPath}.publish.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  copyFileSync(helperPath, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(boundPath, 448);
  try {
    if (createHash("sha256").update(readFileSync(boundPath)).digest("hex") !== LINUX_PUBLICATION_HELPER_SHA256[architecture]) {
      throw new Error("Conditional action publication helper changed before execution.");
    }
    execFileSync(boundPath, [
      "--publish-if-unchanged",
      targetPath,
      candidatePath,
      expectedPath,
      String(target.dev),
      String(target.ino)
    ], { stdio: "ignore", timeout: 2e3 });
    return true;
  } catch (error) {
    if (error.status === 10)
      return false;
    throw error;
  } finally {
    unlinkSync(boundPath);
  }
}
function defaultProcessSignalPermission(pid) {
  try {
    process.kill(pid, 0);
    return "permitted";
  } catch (error) {
    const code = error.code;
    if (code === "ESRCH")
      return "absent";
    if (code === "EPERM")
      return "denied";
    return "unknown";
  }
}
function probeProcessBirth(pid, dependencies = {}) {
  const probe = probeRecordedProcessBirth(pid, dependencies);
  if (probe.status !== "unknown")
    return probe;
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return probe;
  if ((dependencies.platform ?? process.platform) === "win32")
    return probe;
  const permission = (dependencies.signalPermission ?? defaultProcessSignalPermission)(pid);
  return permission === "denied" ? { status: "absent", reason: "foreign" } : probe;
}
function probeRecordedProcessBirth(pid, dependencies) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return { status: "unknown" };
  const platform = dependencies.platform ?? process.platform;
  const read = dependencies.read ?? ((path) => readFileSync(path, "utf8"));
  const run = dependencies.run ?? defaultRun;
  const runVerifiedHelper = dependencies.runVerifiedHelper ?? defaultRunVerifiedHelper;
  try {
    if (platform === "darwin") {
      const observed = run("/bin/ps", ["-p", String(pid), "-o", "pid=,state="]).trim();
      if (observed.length === 0)
        return { status: "absent" };
      const observedFields = /^(\d+)(?:\s+(\S+))?$/.exec(observed);
      if (!observedFields || Number(observedFields[1]) !== pid)
        return { status: "unknown" };
      if (observedFields[2]?.startsWith("Z"))
        return { status: "absent" };
      const helper = verifyDarwinProcessBirthHelper(dependencies);
      const processInfo = runVerifiedHelper(helper.path, pid, helper.requirement).trim();
      const processMatch = /^(\d+):(\d+):(\d+)$/.exec(processInfo);
      if (!processMatch || Number(processMatch[1]) !== pid)
        return { status: "unknown" };
      const bootSession = run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]).trim();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootSession)) {
        return { status: "unknown" };
      }
      return {
        status: "present",
        birth: {
          pid,
          source: "darwin-libproc",
          token: token([platform, bootSession.toLowerCase(), processMatch[2], processMatch[3]])
        }
      };
    }
    if (platform === "linux") {
      const boot = read("/proc/sys/kernel/random/boot_id").trim();
      let stat;
      try {
        stat = read(`/proc/${pid}/stat`).trim();
      } catch (error) {
        return error.code === "ENOENT" ? { status: "absent" } : { status: "unknown" };
      }
      const commandEnd = stat.lastIndexOf(")");
      const fields = commandEnd >= 0 ? stat.slice(commandEnd + 1).trim().split(/\s+/) : [];
      if (fields[0] === "Z")
        return { status: "absent" };
      const started = fields[19];
      if (!boot || !started || !/^\d+$/.test(started))
        return { status: "unknown" };
      return {
        status: "present",
        birth: { pid, source: "linux-proc", token: token([platform, boot, started]) }
      };
    }
    if (platform === "win32") {
      const powershell = resolveTrustedSystemExecutable("powershell", platform, dependencies.executableDependencies);
      if (!powershell)
        return { status: "unknown" };
      const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'ABSENT' } else { $p.StartTime.ToUniversalTime().Ticks }`;
      const started = run(powershell, ["-NoProfile", "-NonInteractive", "-Command", script]).trim();
      if (started === "ABSENT")
        return { status: "absent" };
      if (!/^\d+$/.test(started))
        return { status: "unknown" };
      return {
        status: "present",
        birth: { pid, source: "windows-powershell", token: token([platform, started]) }
      };
    }
  } catch {
    return { status: "unknown" };
  }
  return { status: "unknown" };
}
var DARWIN_HELPER_MANIFEST, LINUX_PUBLICATION_HELPER_SHA256, VERIFIED_HELPER_SCRIPT;
var init_process_birth = __esm({
  "packages/rn-dev-agent-core/dist/session/process-birth.js"() {
    "use strict";
    init_trusted_system_executable();
    DARWIN_HELPER_MANIFEST = {
      sourceSha256: "f97feaa1c0434cd2ee31c0dce56c9308eb17f893a6a771ac1333b62fcec8b702",
      recipeSha256: "9617fe093885ac5c1043b39aa467754db8427080b52ebafea6f780535c2b3685",
      stableBinarySha256: "9887a09246c4fc9c7765ef8fee2ae30027bcf0b9227ae408e48682107e4d88b8",
      binarySha256: "49db19d9cd0ca2e7a78379c1e4b9551532d85447c043c51f06c6e03573c104ad",
      cdhashes: [
        "cebd22e7adf08990d4ff69b3156de03962d44b74",
        "e3de1b27f4da23957a3acf60ae8f01c6402bd424"
      ]
    };
    LINUX_PUBLICATION_HELPER_SHA256 = {
      x64: "93bcb6e186470efd2a0944756d7b2de790182b59a5dcb3377334291076ad6032",
      arm64: "1d0f2fc75e9eff675f8fd5ca329eca03950339796d2f339a4f59a85c2f97ba63"
    };
    VERIFIED_HELPER_SCRIPT = `
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
  }
});

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias;
    exports.isCollection = isCollection;
    exports.isDocument = isDocument;
    exports.isMap = isMap;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar;
    exports.isSeq = isSeq;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports.visit = visit;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml2, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml2);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg2 = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg2);
      }
      return true;
    }
    function anchorNames(root2) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root2, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports.anchorIsValid = anchorIsValid;
    exports.anchorNames = anchorNames;
    exports.createNodeAnchors = createNodeAnchors;
    exports.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports.toJS = toJS;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg2 = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg2);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg2 = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg2);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg2 = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg2);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg2 = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg2);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports.Scalar = Scalar;
    exports.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports.Collection = Collection;
    exports.collectionFromPath = collectionFromPath;
    exports.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports.indentComment = indentComment;
    exports.lineComment = lineComment;
    exports.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    exports.FOLD_BLOCK = FOLD_BLOCK;
    exports.FOLD_FLOW = FOLD_FLOW;
    exports.FOLD_QUOTED = FOLD_QUOTED;
    exports.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json2 = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json2;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json2[i]; ch; ch = json2[++i]) {
        if (ch === " " && json2[i + 1] === "\\" && json2[i + 2] === "n") {
          str += json2.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json2[i + 1]) {
            case "u":
              {
                str += json2.slice(start, i);
                const code = json2.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json2.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json2[i + 2] === '"' || json2.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json2.slice(start, i) + "\n\n";
                while (json2[i + 2] === "\\" && json2[i + 3] === "n" && json2[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json2[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json2.slice(start) : json2;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg2 = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg2);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports) {
    "use strict";
    var node_process = __require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports.debug = debug;
    exports.warn = warn;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports.addMergeToJSMap = addMergeToJSMap;
    exports.isMergeKey = isMergeKey;
    exports.merge = merge;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports.Pair = Pair;
    exports.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify2(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add2 = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add2(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add2(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports.YAMLMap = YAMLMap;
    exports.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports.map = map;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports.seq = seq;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports) {
    "use strict";
    var node_buffer = __require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports.createPairs = createPairs;
    exports.pairs = pairs;
    exports.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports.YAMLOMap = YAMLOMap;
    exports.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports.falseTag = falseTag;
    exports.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intBin = intBin;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports.YAMLSet = YAMLSet;
    exports.set = set;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports.floatTime = floatTime;
    exports.intTime = intTime;
    exports.timestamp = timestamp;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports.coreKnownTags = coreKnownTags;
    exports.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json: json2, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json2,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports.YAMLError = YAMLError;
    exports.YAMLParseError = YAMLParseError;
    exports.YAMLWarning = YAMLWarning;
    exports.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token2 of tokens) {
        if (reqSpace) {
          if (token2.type !== "space" && token2.type !== "newline" && token2.type !== "comma")
            onError(token2.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token2.type !== "comment" && token2.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token2.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token2.source.includes("	")) {
              tab = token2;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token2, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token2.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token2.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token2.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token2;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token2, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token2.source.endsWith(":"))
              onError(token2.offset + token2.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token2;
            start ?? (start = token2.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token2, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token2;
            start ?? (start = token2.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token2, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token2.source} indicator`);
            if (found)
              onError(token2, "UNEXPECTED_TOKEN", `Unexpected ${token2.source} in ${flow ?? "collection"}`);
            found = token2;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token2, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token2;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token2, "UNEXPECTED_TOKEN", `Unexpected ${token2.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg2 = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg2, true);
        }
      }
    }
    exports.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep: sep8, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep8?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep8) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep8 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep8, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep8 = "";
        for (const token2 of end) {
          const { source, type } = token2;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token2, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep8 + cb;
              sep8 = "";
              break;
            }
            case "newline":
              if (comment)
                sep8 += source;
              hasSpace = true;
              break;
            default:
              onError(token2, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token2) => token2 && (token2.type === "block-map" || token2.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep: sep8, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep8?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep8 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap && !sep8 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep8, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep8 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep8)
                for (const st of sep8) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep8, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg2 = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg2);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token2, onError, tagName, tag) {
      const coll = token2.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token2, onError, tag) : token2.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token2, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token2, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token2, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg2) => onError(tagToken, "TAG_RESOLVE_FAILED", msg2));
      if (token2.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token2.type === "block-map" ? "map" : token2.type === "block-seq" ? "seq" : token2.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token2, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token2, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token2, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg2) => onError(tagToken, "TAG_RESOLVE_FAILED", msg2), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep8 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep8 + indent.slice(trimIndent) + content;
          sep8 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep8 === " ")
            sep8 = "\n";
          else if (!prevMoreIndented && sep8 === "\n")
            sep8 = "\n\n";
          value += sep8 + indent.slice(trimIndent) + content;
          sep8 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep8 === "\n")
            value += "\n";
          else
            sep8 = "\n";
        } else {
          value += sep8 + content;
          sep8 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token2 = props[i];
        switch (token2.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token2.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token2, "MISSING_CHAR", message);
            }
            length += token2.source.length;
            comment = token2.source.substring(1);
            break;
          case "error":
            onError(token2, "UNEXPECTED_TOKEN", token2.message);
            length += token2.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token2.type}`;
            onError(token2, "UNEXPECTED_TOKEN", message);
            const ts = token2.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg2) => onError(offset + rel, code, msg2);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep8 = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep8 === "\n")
            res += sep8;
          else
            sep8 = "\n";
        } else {
          res += sep8 + match[1];
          sep8 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep8 + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token2, tagToken, onError) {
      const { value, type, comment, range } = token2.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token2, onError) : resolveFlowScalar.resolveFlowScalar(token2, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg2) => onError(tagToken, "TAG_RESOLVE_FAILED", msg2)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token2.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token2, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg2) => onError(tagToken ?? token2, "TAG_RESOLVE_FAILED", msg2), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg2 = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token2, "TAG_RESOLVE_FAILED", msg2);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token2, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg2 = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token2, "TAG_RESOLVE_FAILED", msg2, true);
        }
      }
      return tag;
    }
    exports.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token2, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token2.type) {
        case "alias":
          node = composeAlias(ctx, token2, onError);
          if (anchor || tag)
            onError(token2, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token2, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token2, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token2, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token2.type === "error" ? token2.message : `Unsupported token (type: ${token2.type})`;
          onError(token2, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token2.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg2 = "With stringKeys, all keys must be strings";
        onError(tag ?? token2, "NON_STRING_KEY", msg2);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token2.type === "scalar" && token2.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token2;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token2 = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token2, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports.composeEmptyNode = composeEmptyNode;
    exports.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token2 of tokens)
          yield* this.next(token2);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token2) {
        if (node_process.env.LOG_STREAM)
          console.dir(token2, { depth: null });
        switch (token2.type) {
          case "directive":
            this.directives.add(token2.source, (offset, message, warning) => {
              const pos = getErrorPos(token2);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token2.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token2, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token2, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token2.source);
            break;
          case "error": {
            const msg2 = token2.source ? `${token2.message}: ${JSON.stringify(token2.source)}` : token2.message;
            const error = new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", msg2);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg2 = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", msg2));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token2.end, token2.offset + token2.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", `Unsupported token ${token2.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token2, strict = true, onError) {
      if (token2) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token2.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token2, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token2, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token2, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token2 ? token2.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token2.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token2.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token2, source);
          break;
        case '"':
          setFlowScalarValue(token2, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token2, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token2, source, "scalar");
      }
    }
    function setBlockScalarValue(token2, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token2.type === "block-scalar") {
        const header = token2.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token2.source = body;
      } else {
        const { offset } = token2;
        const indent = "indent" in token2 ? token2.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token2 ? token2.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token2))
          if (key !== "type" && key !== "offset")
            delete token2[key];
        Object.assign(token2, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token2, source, type) {
      switch (token2.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token2.type = type;
          token2.source = source;
          break;
        case "block-scalar": {
          const end = token2.props.slice(1);
          let oa = source.length;
          if (token2.props[0].type === "block-scalar-header")
            oa -= token2.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token2.props;
          Object.assign(token2, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token2.offset + source.length;
          const nl = { type: "newline", offset, indent: token2.indent, source: "\n" };
          delete token2.items;
          Object.assign(token2, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token2 ? token2.indent : -1;
          const end = "end" in token2 && Array.isArray(token2.end) ? token2.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token2))
            if (key !== "type" && key !== "offset")
              delete token2[key];
          Object.assign(token2, { type, indent, source, end });
        }
      }
    }
    exports.createScalarToken = createScalarToken;
    exports.resolveAsScalar = resolveAsScalar;
    exports.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports) {
    "use strict";
    var stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token2) {
      switch (token2.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token2.props)
            res += stringifyToken(tok);
          return res + token2.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token2.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token2.start.source;
          for (const item of token2.items)
            res += stringifyItem(item);
          for (const st of token2.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token2);
          if (token2.end)
            for (const st of token2.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token2.source;
          if ("end" in token2 && token2.end)
            for (const st of token2.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep: sep8, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep8)
        for (const st of sep8)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field, index] of path) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path) => {
      const parent = visit.itemAtPath(cst, path.slice(0, -1));
      const field = path[path.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token2 = item[field];
        if (token2 && "items" in token2) {
          for (let i = 0; i < token2.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field, i]])), token2.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token2.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports.visit = visit;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token2) => !!token2 && "items" in token2;
    var isScalar = (token2) => !!token2 && (token2.type === "scalar" || token2.type === "single-quoted-scalar" || token2.type === "double-quoted-scalar" || token2.type === "block-scalar");
    function prettyToken(token2) {
      switch (token2) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token2);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports.createScalarToken = cstScalar.createScalarToken;
    exports.resolveAsScalar = cstScalar.resolveAsScalar;
    exports.setScalarValue = cstScalar.setScalarValue;
    exports.stringify = cstStringify.stringify;
    exports.visit = cstVisit.visit;
    exports.BOM = BOM;
    exports.DOCUMENT = DOCUMENT;
    exports.FLOW_END = FLOW_END;
    exports.SCALAR = SCALAR;
    exports.isCollection = isCollection;
    exports.isScalar = isScalar;
    exports.prettyToken = prettyToken;
    exports.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports.LineCounter = LineCounter;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token2) {
      switch (token2?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token2 = error ?? this.stack.pop();
        if (!token2) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token2;
        } else {
          const top = this.peek(1);
          if (token2.type === "block-scalar") {
            token2.indent = "indent" in top ? top.indent : 0;
          } else if (token2.type === "flow-collection" && top.type === "document") {
            token2.indent = 0;
          }
          if (token2.type === "flow-collection")
            fixFlowSeqItems(token2);
          switch (top.type) {
            case "document":
              top.value = token2;
              break;
            case "block-scalar":
              top.props.push(token2);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token2, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token2;
              } else {
                Object.assign(it, { key: token2, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token2 });
              else
                it.value = token2;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token2, sep: [] });
              else if (it.sep)
                it.value = token2;
              else
                Object.assign(it, { key: token2, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token2);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token2.type === "block-map" || token2.type === "block-seq")) {
            const last = token2.items[token2.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token2.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token2.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token2.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep8;
          if (scalar.end) {
            sep8 = scalar.end;
            sep8.push(this.sourceToken);
            delete scalar.end;
          } else
            sep8 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep8 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep8 = it.sep;
                  sep8.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep8 }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep8 = fc.end.splice(1, fc.end.length);
            sep8.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep8 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token2) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token2.end)
              token2.end.push(this.sourceToken);
            else
              token2.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports.parse = parse;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument;
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports.Composer = composer.Composer;
    exports.Document = Document.Document;
    exports.Schema = Schema.Schema;
    exports.YAMLError = errors.YAMLError;
    exports.YAMLParseError = errors.YAMLParseError;
    exports.YAMLWarning = errors.YAMLWarning;
    exports.Alias = Alias.Alias;
    exports.isAlias = identity.isAlias;
    exports.isCollection = identity.isCollection;
    exports.isDocument = identity.isDocument;
    exports.isMap = identity.isMap;
    exports.isNode = identity.isNode;
    exports.isPair = identity.isPair;
    exports.isScalar = identity.isScalar;
    exports.isSeq = identity.isSeq;
    exports.Pair = Pair.Pair;
    exports.Scalar = Scalar.Scalar;
    exports.YAMLMap = YAMLMap.YAMLMap;
    exports.YAMLSeq = YAMLSeq.YAMLSeq;
    exports.CST = cst;
    exports.Lexer = lexer.Lexer;
    exports.LineCounter = lineCounter.LineCounter;
    exports.Parser = parser.Parser;
    exports.parse = publicApi.parse;
    exports.parseAllDocuments = publicApi.parseAllDocuments;
    exports.parseDocument = publicApi.parseDocument;
    exports.stringify = publicApi.stringify;
    exports.visit = visit.visit;
    exports.visitAsync = visit.visitAsync;
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-validator.js
import { join as join3, dirname as dirname3, isAbsolute as isAbsolute2, sep as sep2 } from "node:path";
import { readFileSync as readFileSync3, realpathSync as realpathSync3 } from "node:fs";
function isValidBundleId(s) {
  if (typeof s !== "string")
    return false;
  if (s.length === 0 || s.length >= BUNDLE_ID_MAX_LEN)
    return false;
  return BUNDLE_ID_RE.test(s);
}
function assertValidBundleId(s, context) {
  if (!isValidBundleId(s)) {
    const preview = JSON.stringify(s).slice(0, 80);
    throw new MaestroValidationError(`Invalid bundle ID for ${context}: ${preview}`);
  }
}
function isSafeMaestroScalar(s) {
  if (typeof s !== "string")
    return false;
  if (s.length > SCALAR_MAX_LEN)
    return false;
  if (UNSAFE_SCALAR_RE.test(s))
    return false;
  return true;
}
function buildMaestroFlow(opts, commands) {
  if (opts.appId !== void 0) {
    assertValidBundleId(opts.appId, "appId header");
  }
  for (const cmd2 of commands) {
    validateCommand(cmd2);
  }
  const headerYaml = opts.appId ? import_yaml.default.stringify({ appId: opts.appId }) : "";
  const bodyYaml = import_yaml.default.stringify(commands);
  return `${headerYaml}---
${bodyYaml}`;
}
function validateCommand(cmd2) {
  if (cmd2 === null || cmd2 === void 0) {
    throw new MaestroValidationError("Command is null/undefined");
  }
  if (typeof cmd2 === "string") {
    if (!isSafeMaestroScalar(cmd2)) {
      throw new MaestroValidationError(`Unsafe shorthand command: ${JSON.stringify(cmd2).slice(0, 80)}`);
    }
    if (DENIED_COMMANDS.has(cmd2)) {
      throw new MaestroValidationError(`Command not allowed (denied by default): ${cmd2}`);
    }
    if (!ALLOWED_COMMANDS.has(cmd2)) {
      throw new MaestroValidationError(`Command not in allowlist: ${cmd2}`);
    }
    return;
  }
  if (typeof cmd2 !== "object") {
    throw new MaestroValidationError(`Command is not an object or string: ${typeof cmd2}`);
  }
  const keys = Object.keys(cmd2);
  if (keys.length !== 1) {
    throw new MaestroValidationError(`Command must have exactly one root key, got ${keys.length}: ${keys.join(", ")}`);
  }
  const key = keys[0];
  if (DENIED_COMMANDS.has(key)) {
    throw new MaestroValidationError(`Command not allowed (denied by default): ${key}`);
  }
  if (!ALLOWED_COMMANDS.has(key)) {
    throw new MaestroValidationError(`Command not in allowlist: ${key}`);
  }
  if (key === "runFlow") {
    validateRunFlowValue(cmd2[key]);
    return;
  }
  validateValue(cmd2[key]);
}
function validateRunFlowValue(v) {
  if (typeof v === "string") {
    if (!isSafeMaestroScalar(v)) {
      throw new MaestroValidationError(`Unsafe runFlow file ref: ${JSON.stringify(v).slice(0, 80)}`);
    }
    return;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new MaestroValidationError(`runFlow value must be a file string or an object, got ${Array.isArray(v) ? "array" : typeof v}`);
  }
  const obj = v;
  if ("file" in obj && (typeof obj.file !== "string" || !isSafeMaestroScalar(obj.file))) {
    throw new MaestroValidationError(`runFlow.file must be a safe scalar string`);
  }
  if ("when" in obj)
    validateValue(obj.when);
  if ("commands" in obj) {
    if (!Array.isArray(obj.commands)) {
      throw new MaestroValidationError(`runFlow.commands must be an array`);
    }
    for (const c of obj.commands)
      validateCommand(c);
  }
  for (const [k, val] of Object.entries(obj)) {
    if (k === "file" || k === "when" || k === "commands")
      continue;
    if (!isSafeMaestroScalar(k)) {
      throw new MaestroValidationError(`Unsafe runFlow key: ${JSON.stringify(k).slice(0, 80)}`);
    }
    validateValue(val);
  }
}
function validateValue(v) {
  if (v === null || v === void 0)
    return;
  if (typeof v === "boolean" || typeof v === "number")
    return;
  if (typeof v === "string") {
    if (!isSafeMaestroScalar(v)) {
      throw new MaestroValidationError(`Unsafe scalar value: ${JSON.stringify(v).slice(0, 80)}`);
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v)
      validateValue(item);
    return;
  }
  if (typeof v === "object") {
    for (const [key, value] of Object.entries(v)) {
      if (!isSafeMaestroScalar(key)) {
        throw new MaestroValidationError(`Unsafe scalar key: ${JSON.stringify(key).slice(0, 80)}`);
      }
      validateValue(value);
    }
    return;
  }
  throw new MaestroValidationError(`Unsupported value type: ${typeof v}`);
}
function asRunFlow(cmd2) {
  if (!cmd2 || typeof cmd2 !== "object" || Array.isArray(cmd2))
    return null;
  const keys = Object.keys(cmd2);
  if (keys.length !== 1 || keys[0] !== "runFlow")
    return null;
  const v = cmd2.runFlow;
  if (typeof v === "string")
    return { file: v };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v;
    return {
      file: typeof o.file === "string" ? o.file : void 0,
      when: o.when,
      commands: Array.isArray(o.commands) ? o.commands : void 0
    };
  }
  return null;
}
function collectRunFlowFileReferences(yamlText) {
  try {
    const docs = import_yaml.default.parseAllDocuments(yamlText, { strict: true });
    const body = docs.at(-1)?.toJS();
    if (!Array.isArray(body))
      return [];
    const references = /* @__PURE__ */ new Set();
    const visit = (commands) => {
      for (const command of commands) {
        const runFlow = asRunFlow(command);
        if (!runFlow)
          continue;
        if (runFlow.file !== void 0)
          references.add(runFlow.file);
        if (runFlow.commands)
          visit(runFlow.commands);
      }
    };
    visit(body);
    return [...references];
  } catch {
    return [];
  }
}
function resolveRunFlowTarget(file, opts) {
  if (!opts.flowDir || !opts.flowRoot) {
    throw new MaestroValidationError(`runFlow file ref "${file}" requires a flow root context (flowDir + flowRoot)`);
  }
  if (isAbsolute2(file)) {
    throw new MaestroValidationError(`runFlow file ref must be relative, got absolute: ${file}`);
  }
  if (file.split(/[\\/]/).includes("..")) {
    throw new MaestroValidationError(`runFlow file ref must not contain '..': ${file}`);
  }
  if (!/\.ya?ml$/i.test(file)) {
    throw new MaestroValidationError(`runFlow file ref must be a .yaml/.yml file: ${file}`);
  }
  const realpath = opts.realpathFn ?? realpathSync3;
  let resolved;
  let rootReal;
  try {
    resolved = realpath(join3(opts.flowDir, file));
    rootReal = realpath(opts.flowRoot);
  } catch (err) {
    throw new MaestroValidationError(`runFlow file ref "${file}" could not be resolved: ${err.message}`);
  }
  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep2)) {
    throw new MaestroValidationError(`runFlow file ref "${file}" escapes the flow root`);
  }
  return resolved;
}
function expandRunFlows(commands, opts) {
  const out = [];
  for (const cmd2 of commands) {
    const rf = asRunFlow(cmd2);
    if (!rf) {
      out.push(cmd2);
      continue;
    }
    if (rf.file !== void 0) {
      const depth = opts._depth ?? 0;
      const max = opts.maxRunFlowDepth ?? 5;
      if (depth >= max) {
        throw new MaestroValidationError(`runFlow nesting exceeded max depth ${max}`);
      }
      const resolved = resolveRunFlowTarget(rf.file, opts);
      const visited = opts._visited ?? /* @__PURE__ */ new Set();
      if (visited.has(resolved)) {
        throw new MaestroValidationError(`runFlow cycle detected at "${rf.file}"`);
      }
      const readFile = opts.readFileFn ?? ((p) => readFileSync3(p, "utf8"));
      let subText;
      try {
        subText = readFile(resolved);
      } catch (err) {
        throw new MaestroValidationError(`runFlow file "${rf.file}" could not be read: ${err.message}`);
      }
      const sub = parseAndValidateFlow(subText, {
        ...opts,
        rejectHeader: true,
        flowDir: dirname3(resolved),
        _depth: depth + 1,
        _visited: /* @__PURE__ */ new Set([...visited, resolved])
      });
      if (rf.when !== void 0) {
        out.push({ runFlow: { when: rf.when, commands: sub.commands } });
      } else {
        out.push(...sub.commands);
      }
    } else {
      const inner = rf.commands ? expandRunFlows(rf.commands, { ...opts, _depth: (opts._depth ?? 0) + 1 }) : [];
      const wrapped = { commands: inner };
      if (rf.when !== void 0)
        wrapped.when = rf.when;
      out.push({ runFlow: wrapped });
    }
  }
  return out;
}
function parseAndValidateFlow(yamlText, opts = {}) {
  let docs;
  try {
    docs = import_yaml.default.parseAllDocuments(yamlText, { strict: true });
  } catch (err) {
    throw new MaestroValidationError(`YAML parse error: ${err.message}`);
  }
  if (docs.length === 0) {
    throw new MaestroValidationError("Empty Maestro flow");
  }
  let appId;
  let body;
  if (docs.length === 1) {
    body = docs[0].toJS();
  } else {
    const header = docs[0].toJS() ?? {};
    if (header && typeof header === "object" && "appId" in header) {
      if (opts.rejectHeader) {
        throw new MaestroValidationError("Header (appId) not allowed in this context");
      }
      const rawAppId = header.appId;
      assertValidBundleId(rawAppId, "parsed flow header");
      appId = rawAppId;
    }
    body = docs[docs.length - 1].toJS();
  }
  if (body === null || body === void 0) {
    body = [];
  }
  if (!Array.isArray(body)) {
    throw new MaestroValidationError(`Flow body must be an array, got ${typeof body}`);
  }
  const expanded = expandRunFlows(body, opts);
  for (const cmd2 of expanded) {
    validateCommand(cmd2);
  }
  const raw = buildMaestroFlow(appId !== void 0 ? { appId } : {}, expanded);
  return { appId, commands: expanded, raw };
}
var import_yaml, MaestroValidationError, BUNDLE_ID_RE, BUNDLE_ID_MAX_LEN, UNSAFE_SCALAR_RE, SCALAR_MAX_LEN, ALLOWED_COMMANDS, DENIED_COMMANDS;
var init_maestro_validator = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-validator.js"() {
    "use strict";
    import_yaml = __toESM(require_dist(), 1);
    MaestroValidationError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "MaestroValidationError";
      }
    };
    BUNDLE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)+$/;
    BUNDLE_ID_MAX_LEN = 256;
    UNSAFE_SCALAR_RE = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/;
    SCALAR_MAX_LEN = 4096;
    ALLOWED_COMMANDS = /* @__PURE__ */ new Set([
      "launchApp",
      "tapOn",
      "doubleTapOn",
      "longPressOn",
      "assertVisible",
      "assertNotVisible",
      "inputText",
      "eraseText",
      "scroll",
      "scrollUntilVisible",
      "swipe",
      // Multi-LLM review caught these: test-recorder-generators emits the
      // shorthand `- swipeUp` / `- swipeDown` / `- swipeLeft` / `- swipeRight`
      // top-level commands. Without these in the allowlist, every recorded
      // action containing a swipe would be refused at replay time. The
      // deepsec attack vector (newline-injected direction) is already
      // mitigated by isSafeMaestroScalar catching the embedded newline.
      "swipeUp",
      "swipeDown",
      "swipeLeft",
      "swipeRight",
      "back",
      "pressKey",
      "openLink",
      "waitForAnimationToEnd",
      "extendedWaitUntil",
      "hideKeyboard",
      "takeScreenshot",
      "clearState",
      "addMedia",
      "copyTextFrom",
      "pasteText",
      "travel",
      "setLocation",
      "setAirplaneMode",
      "killApp",
      "stopApp",
      "tap",
      // GH #186: runFlow (conditional dialog handling — deep-link "Open in", Expo
      // dev-client picker). Validated specially (validateRunFlowValue) so nested
      // `commands` get full command-level allowlist checks, and {file} refs are
      // securely resolved + expanded inline (expandRunFlows) — they are NOT passed
      // through generic validateValue, which would miss nested denied commands.
      "runFlow"
    ]);
    DENIED_COMMANDS = /* @__PURE__ */ new Set([
      "runScript",
      "evalScript",
      "startRecording",
      "stopRecording"
    ]);
  }
});

// packages/rn-dev-agent-core/dist/logger.js
import { createWriteStream, mkdirSync as mkdirSync5, existsSync as existsSync6 } from "node:fs";
import { join as join7 } from "node:path";
import { tmpdir, homedir as homedir2 } from "node:os";
function resolveLogPath() {
  if (process.argv.includes("--diagnostic-contract-probe"))
    return null;
  if (configuredLevel !== "debug" && configuredLevel !== "info")
    return null;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) {
    try {
      if (!existsSync6(pluginData))
        mkdirSync5(pluginData, { recursive: true });
      return join7(pluginData, "cdp-bridge.log");
    } catch {
    }
  }
  const fallbackDir = join7(homedir2(), ".claude", "logs");
  try {
    if (!existsSync6(fallbackDir))
      mkdirSync5(fallbackDir, { recursive: true });
    return join7(fallbackDir, "rn-dev-agent-cdp-bridge.log");
  } catch {
  }
  return join7(tmpdir(), "rn-dev-agent-cdp-bridge.log");
}
function getLogStream() {
  if (!logFilePath)
    return null;
  if (!logStream) {
    try {
      logStream = createWriteStream(logFilePath, { flags: "a" });
      logStream.on("error", () => {
      });
    } catch {
      return null;
    }
  }
  return logStream;
}
function shouldLog(level) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel];
}
function formatMessage(level, tag, msg2) {
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  return `${ts} [${level.toUpperCase()}] [${tag}] ${msg2}`;
}
function writeLog(level, tag, msg2) {
  if (!shouldLog(level))
    return;
  const formatted = formatMessage(level, tag, msg2);
  if (level === "error" || level === "warn") {
    console.error(formatted);
  } else if (configuredLevel === "debug" || configuredLevel === "info") {
    console.error(formatted);
  }
  const stream = getLogStream();
  if (stream) {
    try {
      stream.write(formatted + "\n");
    } catch {
    }
  }
}
var LEVEL_ORDER, configuredLevel, logFilePath, logStream, logger;
var init_logger = __esm({
  "packages/rn-dev-agent-core/dist/logger.js"() {
    "use strict";
    LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
    configuredLevel = process.env.LOG_LEVEL ?? process.env.RN_DEV_AGENT_LOG_LEVEL ?? "warn";
    logFilePath = resolveLogPath();
    logStream = null;
    logger = {
      debug: (tag, msg2) => writeLog("debug", tag, msg2),
      info: (tag, msg2) => writeLog("info", tag, msg2),
      warn: (tag, msg2) => writeLog("warn", tag, msg2),
      error: (tag, msg2) => writeLog("error", tag, msg2),
      get logFilePath() {
        return logFilePath;
      },
      get level() {
        return configuredLevel;
      }
    };
  }
});

// packages/rn-dev-agent-core/dist/lifecycle/settle-hash.js
var init_settle_hash = __esm({
  "packages/rn-dev-agent-core/dist/lifecycle/settle-hash.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/fast-runner-ref-map.js
var init_fast_runner_ref_map = __esm({
  "packages/rn-dev-agent-core/dist/fast-runner-ref-map.js"() {
    "use strict";
    init_settle_hash();
  }
});

// packages/rn-dev-agent-core/dist/runners/keyboard-guard.js
var init_keyboard_guard = __esm({
  "packages/rn-dev-agent-core/dist/runners/keyboard-guard.js"() {
    "use strict";
    init_utils();
  }
});

// packages/rn-dev-agent-core/dist/util/secure-state-file.js
import { readFileSync as readFileSync10, writeFileSync as writeFileSync4, unlinkSync as unlinkSync6, mkdirSync as mkdirSync8, renameSync as renameSync4, lstatSync as lstatSync9 } from "node:fs";
import { join as join12, dirname as dirname12 } from "node:path";
import { homedir as homedir3 } from "node:os";
function getStateDir() {
  if (process.env.XDG_STATE_HOME) {
    return join12(process.env.XDG_STATE_HOME, "rn-dev-agent");
  }
  if (process.platform === "darwin") {
    return join12(homedir3(), "Library", "Application Support", "rn-dev-agent");
  }
  return join12(homedir3(), ".rn-dev-agent");
}
function runnerStatePath(key) {
  const safe = key.replace(/[^A-Za-z0-9._:-]/g, "_");
  return join12(getStateDir(), "runner-state", `${safe}.json`);
}
function readJsonStateFile(path) {
  try {
    const stat = lstatSync9(path);
    if (stat.isSymbolicLink())
      return null;
    return JSON.parse(readFileSync10(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJsonStateFileAtomic(path, value) {
  mkdirSync8(dirname12(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync4(tmpPath, JSON.stringify(value), { encoding: "utf8", mode: 384 });
  renameSync4(tmpPath, path);
}
function deleteStateFile(path) {
  try {
    unlinkSync6(path);
  } catch {
  }
}
function readLegacyTmpState(kind) {
  return readJsonStateFile(LEGACY_TMP_STATE_FILES[kind]);
}
function cleanupLegacyTmpState() {
  for (const p of Object.values(LEGACY_TMP_STATE_FILES))
    deleteStateFile(p);
}
var LEGACY_TMP_STATE_FILES;
var init_secure_state_file = __esm({
  "packages/rn-dev-agent-core/dist/util/secure-state-file.js"() {
    "use strict";
    LEGACY_TMP_STATE_FILES = {
      ios: "/tmp/rn-fast-runner-state.json",
      android: "/tmp/rn-android-runner-state.json"
    };
  }
});

// packages/rn-dev-agent-core/dist/runners/runtime-paths.js
import { existsSync as existsSync11, statSync as statSync5 } from "node:fs";
import { join as join13 } from "node:path";
function compactUnique(paths) {
  const out = [];
  for (const path of paths) {
    if (!path || out.includes(path))
      continue;
    out.push(path);
  }
  return out;
}
function isDirectory(path) {
  try {
    return statSync5(path).isDirectory();
  } catch {
    return false;
  }
}
function candidateNativeRunnerDirs(runnerName, baseDir = import.meta.dirname) {
  const runnerRoot = process.env.RN_DEV_AGENT_NATIVE_RUNNER_ROOT;
  const repoRoot = process.env.RN_DEV_AGENT_ROOT;
  const codexPluginRoot = process.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT;
  const claudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  return compactUnique([
    runnerRoot ? join13(runnerRoot, runnerName) : void 0,
    repoRoot ? join13(repoRoot, "packages", runnerName) : void 0,
    repoRoot ? join13(repoRoot, "scripts", runnerName) : void 0,
    codexPluginRoot ? join13(codexPluginRoot, "scripts", runnerName) : void 0,
    claudePluginRoot ? join13(claudePluginRoot, "..", runnerName) : void 0,
    claudePluginRoot ? join13(claudePluginRoot, "..", "..", "packages", runnerName) : void 0,
    claudePluginRoot ? join13(claudePluginRoot, "..", "..", "scripts", runnerName) : void 0,
    claudePluginRoot ? join13(claudePluginRoot, "scripts", runnerName) : void 0,
    // Bundled Codex runtime: <plugin>/rn-dev-agent-core/dist.
    join13(baseDir, "..", "..", "scripts", runnerName),
    // Source checkout: packages/rn-dev-agent-core/dist/runners.
    // Also covers the legacy scripts/cdp-bridge/dist/runners layout.
    join13(baseDir, "..", "..", "..", runnerName),
    // Legacy source checkout: packages/rn-dev-agent-core/dist/runners before runner package split.
    join13(baseDir, "..", "..", "..", "..", "scripts", runnerName)
  ]);
}
function resolveNativeRunnerDir(runnerName, baseDir = import.meta.dirname) {
  const candidates = candidateNativeRunnerDirs(runnerName, baseDir);
  return candidates.find(isDirectory) ?? candidates[0];
}
var init_runtime_paths = __esm({
  "packages/rn-dev-agent-core/dist/runners/runtime-paths.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/runners/protocol.js
var init_protocol = __esm({
  "packages/rn-dev-agent-core/dist/runners/protocol.js"() {
    "use strict";
    init_runtime_paths();
  }
});

// packages/rn-dev-agent-core/dist/runners/quiescence.js
var init_quiescence = __esm({
  "packages/rn-dev-agent-core/dist/runners/quiescence.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/runners/runner-artifacts.js
var init_runner_artifacts = __esm({
  "packages/rn-dev-agent-core/dist/runners/runner-artifacts.js"() {
    "use strict";
    init_runtime_paths();
  }
});

// packages/rn-dev-agent-core/dist/runners/transport-recovery.js
var init_transport_recovery = __esm({
  "packages/rn-dev-agent-core/dist/runners/transport-recovery.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/runners/rn-fast-runner-client.js
import { join as join14 } from "node:path";
function resolveReadyTimeoutMs() {
  const raw = Number(process.env.RN_FAST_RUNNER_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3e4;
}
function iosStatePath(deviceId) {
  return runnerStatePath(`ios-${deviceId}`);
}
function parsePersistedRunnerState(raw, pidAlive = defaultProcessAlive) {
  if (!raw || typeof raw !== "object")
    return null;
  const s = raw;
  if (s.schemaVersion !== 1)
    return null;
  if (typeof s.pid !== "number" || typeof s.port !== "number")
    return null;
  if (typeof s.deviceId !== "string" || typeof s.bundleId !== "string")
    return null;
  if (!pidAlive(s.pid))
    return null;
  return s;
}
function parseLegacyRunnerState(raw, pidAlive = defaultProcessAlive) {
  if (!raw || typeof raw !== "object")
    return null;
  const s = raw;
  if (typeof s.pid !== "number" || typeof s.port !== "number")
    return null;
  if (typeof s.deviceId !== "string")
    return null;
  if (!pidAlive(s.pid))
    return null;
  return {
    schemaVersion: 1,
    pid: s.pid,
    port: s.port,
    deviceId: s.deviceId,
    bundleId: typeof s.bundleId === "string" ? s.bundleId : "",
    startedAt: "",
    protocolVersion: 0
  };
}
function adoptPersistedFastRunnerState(deviceId) {
  if (runnerState || !deviceId)
    return;
  const path = iosStatePath(deviceId);
  const raw = readJsonStateFile(path);
  if (raw !== null) {
    const parsed = parsePersistedRunnerState(raw);
    if (!parsed) {
      deleteStateFile(path);
      return;
    }
    runnerState = parsed;
    quiescenceAnnouncementPending = true;
    return;
  }
  const legacy = readLegacyTmpState("ios");
  if (legacy === null)
    return;
  const parsedLegacy = parseLegacyRunnerState(legacy);
  if (!parsedLegacy) {
    cleanupLegacyTmpState();
    return;
  }
  if (parsedLegacy.deviceId === deviceId) {
    runnerState = parsedLegacy;
    quiescenceAnnouncementPending = true;
  }
}
async function stopFastRunner(deviceId, signal) {
  adoptPersistedFastRunnerState(deviceId);
  await reapStaleFastRunner({ signal });
}
async function fastHealthCheck() {
  if (!runnerState)
    return false;
  try {
    const result = await defaultHttpProbe(runnerState.port, 2e3);
    return result.ok && result.status === 200 && result.bodyOk === true;
  } catch {
    return false;
  }
}
async function reapDelay(sleep, ms, signal) {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted)
    return;
  await new Promise((resolve9, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", finish);
      resolve9();
    };
    signal.addEventListener("abort", finish, { once: true });
    sleep(ms).then(finish, (error) => {
      signal.removeEventListener("abort", finish);
      reject(error);
    });
  });
}
function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function defaultHttpProbe(port, timeoutMs, capabilityOverride) {
  const url = `http://127.0.0.1:${port}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const capability = capabilityOverride ?? (runnerState?.port === port ? runnerState.capability : void 0);
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: capability ? { authorization: `Bearer ${capability}` } : {}
    });
    if (!res.ok)
      return { ok: false, status: res.status };
    let bodyOk;
    let protocolVersion;
    let runnerVersion;
    let capabilities;
    let commands;
    let instanceId;
    let sessionId;
    let claimEpoch;
    let deviceId;
    let appId;
    try {
      const body = await res.json();
      bodyOk = body.ok === true;
      if (typeof body.protocolVersion === "number")
        protocolVersion = body.protocolVersion;
      if (typeof body.runnerVersion === "string")
        runnerVersion = body.runnerVersion;
      if (Array.isArray(body.capabilities)) {
        capabilities = body.capabilities.filter((c) => typeof c === "string");
      }
      if (Array.isArray(body.commands)) {
        commands = body.commands.filter((c) => typeof c === "string");
      }
      if (typeof body.instanceId === "string")
        instanceId = body.instanceId;
      if (typeof body.sessionId === "string")
        sessionId = body.sessionId;
      if (typeof body.claimEpoch === "number")
        claimEpoch = body.claimEpoch;
      if (typeof body.deviceId === "string")
        deviceId = body.deviceId;
      if (typeof body.appId === "string")
        appId = body.appId;
    } catch {
      bodyOk = false;
    }
    return {
      ok: true,
      status: res.status,
      bodyOk,
      ...protocolVersion !== void 0 ? { protocolVersion } : {},
      ...runnerVersion !== void 0 ? { runnerVersion } : {},
      ...capabilities !== void 0 ? { capabilities } : {},
      ...commands !== void 0 ? { commands } : {},
      ...instanceId !== void 0 ? { instanceId } : {},
      ...sessionId !== void 0 ? { sessionId } : {},
      ...claimEpoch !== void 0 ? { claimEpoch } : {},
      ...deviceId !== void 0 ? { deviceId } : {},
      ...appId !== void 0 ? { appId } : {}
    };
  } finally {
    clearTimeout(timer);
  }
}
function clearStateFileIfMatches(expected) {
  const identityMatches = (observed) => observed.pid === expected.pid && observed.deviceId === expected.deviceId && observed.processBirth === expected.processBirth;
  const path = iosStatePath(expected.deviceId);
  const persisted = readJsonStateFile(path);
  let clearedCurrent = false;
  if (runnerState && identityMatches(runnerState)) {
    runnerState = null;
    clearedCurrent = true;
  }
  if (runnerProcess?.pid === expected.pid) {
    runnerProcess = null;
    clearedCurrent = true;
  }
  if (persisted && identityMatches(persisted))
    deleteStateFile(path);
  if (clearedCurrent)
    lastKnownCapabilities = [];
}
async function reapStaleFastRunner(deps = {}) {
  const getState = deps.getState ?? (() => runnerState);
  const sendSignal = deps.sendSignal ?? ((pid, sig) => process.kill(pid, sig));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clearState = deps.clearState ?? clearStateFileIfMatches;
  const graceMs = deps.graceMs ?? 500;
  const state = getState();
  if (!state)
    return;
  const expectedBirth = typeof state.processBirth === "string" ? { pid: state.pid, token: state.processBirth } : null;
  if (!expectedBirth) {
    const observed = deps.probeProcessBirth ? deps.probeProcessBirth(state.pid) : deps.processAlive ? deps.processAlive(state.pid) ? { status: "present" } : { status: "absent" } : probeProcessBirth(state.pid);
    if (observed.status === "absent") {
      clearState(state);
      return;
    }
    throw new Error("RUNNER_ADOPTION_REQUIRED: live persisted iOS runner lacks process-birth authority");
  }
  const probeExpected = () => {
    if (deps.probeProcessBirth) {
      const observed2 = deps.probeProcessBirth(expectedBirth.pid);
      if (observed2.status === "unknown")
        return "unknown";
      if (observed2.status === "absent")
        return "gone";
      return observed2.birth.token === expectedBirth.token ? "match" : "gone";
    }
    if (deps.matchesProcessBirth) {
      return deps.matchesProcessBirth(expectedBirth) ? "match" : "gone";
    }
    const observed = probeProcessBirth(expectedBirth.pid);
    if (observed.status === "unknown")
      return "unknown";
    if (observed.status === "absent")
      return "gone";
    return observed.birth.token === expectedBirth.token ? "match" : "gone";
  };
  const initial = probeExpected();
  if (initial === "unknown") {
    throw new Error("RUNNER_ADOPTION_REQUIRED: iOS runner process identity is unproven");
  }
  if (initial === "gone") {
    clearState(state);
    return;
  }
  const spawnedChild = runnerProcess?.pid === state.pid ? runnerProcess : null;
  const spawnedExit = spawnedChild ? new Promise((resolve9) => spawnedChild.once("exit", () => resolve9())) : null;
  try {
    sendSignal(state.pid, "SIGTERM");
  } catch {
  }
  await reapDelay(sleep, graceMs, deps.signal);
  const afterTerm = probeExpected();
  if (afterTerm === "unknown") {
    throw new Error("RUNNER_ADOPTION_REQUIRED: iOS runner termination is unproven");
  }
  if (afterTerm === "gone") {
    clearState(state);
    return;
  }
  try {
    sendSignal(state.pid, "SIGKILL");
  } catch {
  }
  if (spawnedExit) {
    await Promise.race([spawnedExit, sleep(250)]);
  } else {
    await sleep(50);
  }
  const afterKill = probeExpected();
  if (afterKill !== "gone") {
    throw new Error("RUNNER_ADOPTION_REQUIRED: iOS runner termination is unproven");
  }
  clearState(state);
}
var READY_TIMEOUT_MS, FAST_RUNNER_PROJECT, runnerProcess, runnerState, lastKnownCapabilities, quiescenceAnnouncementPending, REBUILD_LOCK_DIR, REBUILD_LOCK_STALE_MS, REBUILD_BUDGET_FILE, fetchImpl;
var init_rn_fast_runner_client = __esm({
  "packages/rn-dev-agent-core/dist/runners/rn-fast-runner-client.js"() {
    "use strict";
    init_utils();
    init_fast_runner_ref_map();
    init_keyboard_guard();
    init_secure_state_file();
    init_protocol();
    init_quiescence();
    init_runner_artifacts();
    init_runtime_paths();
    init_transport_recovery();
    init_process_birth();
    READY_TIMEOUT_MS = resolveReadyTimeoutMs();
    FAST_RUNNER_PROJECT = resolveNativeRunnerDir("rn-fast-runner");
    runnerProcess = null;
    runnerState = null;
    lastKnownCapabilities = [];
    quiescenceAnnouncementPending = false;
    REBUILD_LOCK_DIR = join14(FAST_RUNNER_PROJECT, "build", ".rebuild-lock");
    REBUILD_LOCK_STALE_MS = 15 * 6e4;
    REBUILD_BUDGET_FILE = join14(FAST_RUNNER_PROJECT, "build", "commands-rebuild.json");
    fetchImpl = globalThis.fetch;
  }
});

// packages/rn-dev-agent-core/dist/session/authority-store.js
import { createRequire as createRequire2 } from "node:module";
var require2, INITIALIZATION_WAIT;
var init_authority_store = __esm({
  "packages/rn-dev-agent-core/dist/session/authority-store.js"() {
    "use strict";
    require2 = createRequire2(import.meta.url);
    INITIALIZATION_WAIT = new Int32Array(new SharedArrayBuffer(4));
  }
});

// packages/rn-dev-agent-core/dist/session/cleanup-identity.js
var init_cleanup_identity = __esm({
  "packages/rn-dev-agent-core/dist/session/cleanup-identity.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/session/declared-source-contract.js
var DECLARED_ROOT_ENV, DECLARED_MANIFESTS_ENV, NON_GIT_DECLARATION_NEXT_ACTION;
var init_declared_source_contract = __esm({
  "packages/rn-dev-agent-core/dist/session/declared-source-contract.js"() {
    "use strict";
    DECLARED_ROOT_ENV = "RN_DEV_AGENT_DECLARED_ROOT";
    DECLARED_MANIFESTS_ENV = "RN_DEV_AGENT_DECLARED_MANIFESTS";
    NON_GIT_DECLARATION_NEXT_ACTION = `Declare the non-Git source explicitly: set ${DECLARED_ROOT_ENV} to the exact existing application root, and set ${DECLARED_MANIFESTS_ENV} to a comma-separated list of required existing manifest files inside that root, then restart the supervisor. Neither value is inferred from the working directory or generated.`;
  }
});

// packages/rn-dev-agent-core/dist/nav-graph/storage.js
import { readFileSync as readFileSync11, writeFileSync as writeFileSync5, existsSync as existsSync12, renameSync as renameSync5, readdirSync as readdirSync5, lstatSync as lstatSync10, mkdirSync as mkdirSync9, realpathSync as realpathSync6 } from "node:fs";
import { join as join15, dirname as dirname13 } from "node:path";
function isRnProject(dir) {
  const pkgPath = join15(dir, "package.json");
  if (!existsSync12(pkgPath))
    return false;
  try {
    const pkg = JSON.parse(readFileSync11(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return !!(deps["react-native"] || deps["expo"]);
  } catch {
    return false;
  }
}
function scanForRnProject(rootDir, maxDepth) {
  if (maxDepth < 0)
    return null;
  let entries;
  try {
    entries = readdirSync5(rootDir);
  } catch {
    return null;
  }
  entries.sort();
  const subdirs = [];
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules")
      continue;
    const full = join15(rootDir, name);
    try {
      const stat = lstatSync10(full);
      if (!(stat.isDirectory() || stat.isSymbolicLink()))
        continue;
    } catch {
      continue;
    }
    if (isRnProject(full))
      return full;
    subdirs.push(full);
  }
  if (maxDepth > 0) {
    for (const dir of subdirs) {
      const deeper = scanForRnProject(dir, maxDepth - 1);
      if (deeper)
        return deeper;
    }
  }
  return null;
}
function collectRnProjects(rootDir, maxDepth, out) {
  if (maxDepth < 0)
    return;
  let entries;
  try {
    entries = readdirSync5(rootDir);
  } catch {
    return;
  }
  entries.sort();
  const subdirs = [];
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules")
      continue;
    const full = join15(rootDir, name);
    try {
      const stat = lstatSync10(full);
      if (!(stat.isDirectory() || stat.isSymbolicLink()))
        continue;
    } catch {
      continue;
    }
    if (isRnProject(full)) {
      out.push(full);
    } else {
      subdirs.push(full);
    }
  }
  if (maxDepth > 0) {
    for (const dir of subdirs)
      collectRnProjects(dir, maxDepth - 1, out);
  }
}
function readProjectBundleId(projectRoot) {
  const appJsonPath = join15(projectRoot, "app.json");
  if (!existsSync12(appJsonPath))
    return null;
  try {
    const raw = JSON.parse(readFileSync11(appJsonPath, "utf-8"));
    const iosId = raw.expo?.ios?.bundleIdentifier ?? raw.ios?.bundleIdentifier;
    const androidId = raw.expo?.android?.package ?? raw.android?.package;
    if (typeof iosId === "string" && iosId.length > 0)
      return iosId;
    if (typeof androidId === "string" && androidId.length > 0)
      return androidId;
    return null;
  } catch {
    return null;
  }
}
function findProjectRoot(opts = {}) {
  const targetBundleId = opts.bundleId;
  const envRoot = process.env.RN_PROJECT_ROOT;
  if (envRoot && isRnProject(envRoot))
    return envRoot;
  let walkupHit = null;
  const starts = [process.env.CLAUDE_USER_CWD, process.cwd()].filter(Boolean);
  for (const start of starts) {
    if (isRnProject(start)) {
      if (targetBundleId && readProjectBundleId(start) === targetBundleId)
        return start;
      walkupHit = walkupHit ?? start;
      continue;
    }
    let dir = start;
    for (let i = 0; i < 10; i++) {
      if (isRnProject(dir)) {
        if (targetBundleId && readProjectBundleId(dir) === targetBundleId)
          return dir;
        walkupHit = walkupHit ?? dir;
        break;
      }
      const parent = join15(dir, "..");
      if (parent === dir)
        break;
      dir = parent;
    }
  }
  if (!targetBundleId && walkupHit)
    return walkupHit;
  const cwd = process.cwd();
  const parentOfCwd = join15(cwd, "..");
  if (targetBundleId) {
    const all = [];
    collectRnProjects(cwd, 0, all);
    if (parentOfCwd !== cwd)
      collectRnProjects(parentOfCwd, 1, all);
    for (const candidate of all) {
      if (readProjectBundleId(candidate) === targetBundleId)
        return candidate;
    }
    if (walkupHit)
      return walkupHit;
    return all[0] ?? null;
  }
  const cwdScan = scanForRnProject(cwd, 0);
  if (cwdScan)
    return cwdScan;
  if (parentOfCwd !== cwd) {
    const siblingScan = scanForRnProject(parentOfCwd, 1);
    if (siblingScan)
      return siblingScan;
  }
  return null;
}
var import_yaml2, STRIKE_COOLDOWN_MS;
var init_storage = __esm({
  "packages/rn-dev-agent-core/dist/nav-graph/storage.js"() {
    "use strict";
    import_yaml2 = __toESM(require_dist(), 1);
    STRIKE_COOLDOWN_MS = 5 * 60 * 1e3;
  }
});

// packages/rn-dev-agent-core/dist/cdp/metro-cwd.js
var init_metro_cwd = __esm({
  "packages/rn-dev-agent-core/dist/cdp/metro-cwd.js"() {
    "use strict";
    init_storage();
    init_trusted_system_executable();
  }
});

// packages/rn-dev-agent-core/dist/session/metro-binding.js
var init_metro_binding = __esm({
  "packages/rn-dev-agent-core/dist/session/metro-binding.js"() {
    "use strict";
    init_metro_cwd();
    init_trusted_system_executable();
    init_process_birth();
    init_trusted_system_executable();
  }
});

// packages/rn-dev-agent-core/dist/session/recovery-remedy.js
var SESSION_DOCTOR, HEADLESS_SESSION_RECOVERY_COMMAND, HEADLESS_SESSION_REPORT_COMMAND;
var init_recovery_remedy = __esm({
  "packages/rn-dev-agent-core/dist/session/recovery-remedy.js"() {
    "use strict";
    SESSION_DOCTOR = '"${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}/rn-dev-agent-core/dist/session-doctor.js"';
    HEADLESS_SESSION_RECOVERY_COMMAND = `node ${SESSION_DOCTOR} repair`;
    HEADLESS_SESSION_REPORT_COMMAND = `node ${SESSION_DOCTOR} report`;
  }
});

// packages/rn-dev-agent-core/dist/session/registry.js
var INITIALIZATION_WAIT2, SessionAuthorityError, RECOVERY_HANDLE_TTL_MS;
var init_registry = __esm({
  "packages/rn-dev-agent-core/dist/session/registry.js"() {
    "use strict";
    init_authority_store();
    init_cleanup_identity();
    init_declared_source_contract();
    init_metro_binding();
    init_recovery_remedy();
    INITIALIZATION_WAIT2 = new Int32Array(new SharedArrayBuffer(4));
    SessionAuthorityError = class extends Error {
      code;
      holder;
      supplementalMeta;
      details;
      constructor(code, message, holder, details) {
        super(`${code}: ${message}`);
        this.name = "SessionAuthorityError";
        this.code = code;
        this.holder = holder;
        this.details = details;
      }
      attachMeta(meta) {
        this.supplementalMeta = { ...this.supplementalMeta, ...meta };
      }
      getSupplementalMeta() {
        return { ...this.supplementalMeta };
      }
    };
    RECOVERY_HANDLE_TTL_MS = 5 * 6e4;
  }
});

// packages/rn-dev-agent-core/dist/util/public-diagnostics.js
var init_public_diagnostics = __esm({
  "packages/rn-dev-agent-core/dist/util/public-diagnostics.js"() {
    "use strict";
    init_registry();
  }
});

// packages/rn-dev-agent-core/dist/tools/device-screenshot-raw.js
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync;
var init_device_screenshot_raw = __esm({
  "packages/rn-dev-agent-core/dist/tools/device-screenshot-raw.js"() {
    "use strict";
    init_public_diagnostics();
    execFileAsync = promisify(execFile);
  }
});

// packages/rn-dev-agent-core/dist/lifecycle/no-change-tracker.js
var WEDGED_DISTINCT_TARGETS, WEDGED_RUNTIME_HINT;
var init_no_change_tracker = __esm({
  "packages/rn-dev-agent-core/dist/lifecycle/no-change-tracker.js"() {
    "use strict";
    WEDGED_DISTINCT_TARGETS = 3;
    WEDGED_RUNTIME_HINT = `${WEDGED_DISTINCT_TARGETS} consecutive taps on distinct targets produced no UI change \u2014 the app runtime may be wedged (JS thread paused or touch events swallowed). Run cdp_status (iOS auto-recovers a paused JS thread), then cdp_restart with hardReset=true if it persists.`;
  }
});

// packages/rn-dev-agent-core/dist/observability/mirror/jpeg-stream.js
var SOI, EOI;
var init_jpeg_stream = __esm({
  "packages/rn-dev-agent-core/dist/observability/mirror/jpeg-stream.js"() {
    "use strict";
    SOI = Buffer.from([255, 216]);
    EOI = Buffer.from([255, 217]);
  }
});

// packages/rn-dev-agent-core/dist/observability/mirror/sources.js
var IDB_INSTALL_COMMAND, SIMCTL_HINT, IDB_HINT;
var init_sources = __esm({
  "packages/rn-dev-agent-core/dist/observability/mirror/sources.js"() {
    "use strict";
    init_jpeg_stream();
    IDB_INSTALL_COMMAND = "brew install python@3.13 && brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion && pipx install --python python3.13 --force fb-idb";
    SIMCTL_HINT = `install idb for smoother mirroring (${IDB_INSTALL_COMMAND})`;
    IDB_HINT = `idb not found \u2014 ${IDB_INSTALL_COMMAND}`;
  }
});

// packages/rn-dev-agent-core/dist/project-config.js
import { existsSync as existsSync13, readFileSync as readFileSync12 } from "node:fs";
import { join as join16 } from "node:path";
function readAppId(projectRoot, platform) {
  for (const filename of ["app.json", "app.config.json"]) {
    const p = join16(projectRoot, filename);
    if (!existsSync13(p))
      continue;
    try {
      const raw = JSON.parse(readFileSync12(p, "utf-8"));
      const expo = raw.expo ?? raw;
      const iosBundleId = expo?.ios?.bundleIdentifier;
      const androidPkg = expo?.android?.package;
      if (platform === "android")
        return androidPkg ?? iosBundleId ?? null;
      return iosBundleId ?? androidPkg ?? null;
    } catch {
      continue;
    }
  }
  return null;
}
function resolveBundleId(platform) {
  const projectRoot = findProjectRoot();
  if (!projectRoot)
    return null;
  return readAppId(projectRoot, platform);
}
function readExpoSlug() {
  const projectRoot = findProjectRoot();
  if (!projectRoot)
    return null;
  for (const filename of ["app.json", "app.config.json"]) {
    const p = join16(projectRoot, filename);
    if (!existsSync13(p))
      continue;
    try {
      const raw = JSON.parse(readFileSync12(p, "utf-8"));
      return raw.expo?.slug ?? null;
    } catch {
      continue;
    }
  }
  return null;
}
var init_project_config = __esm({
  "packages/rn-dev-agent-core/dist/project-config.js"() {
    "use strict";
    init_storage();
    init_logger();
    init_sources();
  }
});

// packages/rn-dev-agent-core/dist/agent-device-wrapper.js
import { join as join17 } from "node:path";
import { createHash as createHash3 } from "node:crypto";
function getSessionFilePath() {
  const projectId = createHash3("sha256").update(process.cwd()).digest("hex").slice(0, 12);
  return join17(getStateDir(), `session-${projectId}.json`);
}
function getActiveSession() {
  return activeSession;
}
function getAdbSerial() {
  const session2 = getActiveSession();
  if (session2?.platform === "android" && session2.deviceId)
    return ["-s", session2.deviceId];
  if (process.env.ANDROID_SERIAL)
    return ["-s", process.env.ANDROID_SERIAL];
  return [];
}
var SESSION_FILE, LEGACY_SESSION_FILE, activeSession;
var init_agent_device_wrapper = __esm({
  "packages/rn-dev-agent-core/dist/agent-device-wrapper.js"() {
    "use strict";
    init_utils();
    init_rn_fast_runner_client();
    init_protocol();
    init_device_screenshot_raw();
    init_fast_runner_ref_map();
    init_no_change_tracker();
    init_project_config();
    init_secure_state_file();
    SESSION_FILE = getSessionFilePath();
    LEGACY_SESSION_FILE = "/tmp/rn-dev-agent-session.json";
    activeSession = null;
    activeSession = readJsonStateFile(SESSION_FILE);
    if (!activeSession) {
      const legacy = readJsonStateFile(LEGACY_SESSION_FILE);
      if (legacy) {
        activeSession = legacy;
        try {
          writeJsonStateFileAtomic(SESSION_FILE, legacy);
        } catch {
        }
      }
    }
  }
});

// packages/rn-dev-agent-core/dist/tools/platform-utils.js
import { execFile as execFileCb } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var execFile2;
var init_platform_utils = __esm({
  "packages/rn-dev-agent-core/dist/tools/platform-utils.js"() {
    "use strict";
    init_agent_device_wrapper();
    execFile2 = promisify2(execFileCb);
  }
});

// packages/rn-dev-agent-core/dist/runners/free-port.js
var init_free_port = __esm({
  "packages/rn-dev-agent-core/dist/runners/free-port.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/runners/rn-android-runner-client.js
import { spawn as spawn2, execFile as execFile3 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
import { join as join18 } from "node:path";
function androidStatePath(serial) {
  return runnerStatePath(`android-${serial}`);
}
function defaultProcessAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function parsePersistedAndroidState(raw, pidAlive = defaultProcessAlive2) {
  if (!raw || typeof raw !== "object")
    return null;
  const s = raw;
  if (s.schemaVersion !== 1)
    return null;
  if (typeof s.hostPort !== "number" || typeof s.devicePort !== "number")
    return null;
  if (typeof s.pid !== "number")
    return null;
  if (!pidAlive(s.pid))
    return null;
  return s;
}
function parseLegacyAndroidState(raw, pidAlive = defaultProcessAlive2) {
  if (!raw || typeof raw !== "object")
    return null;
  const s = raw;
  if (typeof s.hostPort !== "number" || typeof s.devicePort !== "number")
    return null;
  if (typeof s.pid !== "number")
    return null;
  if (!pidAlive(s.pid))
    return null;
  return {
    schemaVersion: 1,
    hostPort: s.hostPort,
    devicePort: s.devicePort,
    pid: s.pid,
    ...typeof s.deviceId === "string" ? { deviceId: s.deviceId } : {},
    ...typeof s.bundleId === "string" ? { bundleId: s.bundleId } : {},
    startedAt: "",
    protocolVersion: 0
  };
}
function adoptPersistedAndroidState(serial) {
  if (runnerState2)
    return;
  if (serial) {
    const path = androidStatePath(serial);
    const raw = readJsonStateFile(path);
    if (raw !== null) {
      const parsed = parsePersistedAndroidState(raw);
      if (!parsed) {
        deleteStateFile(path);
        return;
      }
      runnerState2 = parsed;
      return;
    }
  }
  const legacy = readLegacyTmpState("android");
  if (legacy === null)
    return;
  const parsedLegacy = parseLegacyAndroidState(legacy);
  if (!parsedLegacy) {
    cleanupLegacyTmpState();
    return;
  }
  if (!serial || !parsedLegacy.deviceId || parsedLegacy.deviceId === serial) {
    runnerState2 = parsedLegacy;
  }
}
function clearAndroidStateFile() {
  const path = runnerState2?.deviceId ? androidStatePath(runnerState2.deviceId) : null;
  runnerState2 = null;
  runnerProcess2 = null;
  if (path)
    deleteStateFile(path);
}
function adbSerialArgs(deviceId) {
  if (deviceId)
    return ["-s", deviceId];
  if (process.env.ANDROID_SERIAL)
    return ["-s", process.env.ANDROID_SERIAL];
  return [];
}
function buildAdbForwardRemoveArgs(deviceId, hostPort) {
  return [...adbSerialArgs(deviceId), "forward", "--remove", `tcp:${hostPort}`];
}
async function stopAndroidRunner(deviceId, signal) {
  signal?.throwIfAborted();
  adoptPersistedAndroidState(deviceId ?? void 0);
  const stoppedState = runnerState2;
  runnerProcess2?.kill("SIGTERM");
  clearAndroidStateFile();
  if (typeof stoppedState?.hostPort === "number") {
    const resolvedDeviceId = deviceId ?? stoppedState.deviceId;
    try {
      await execFileAsync2("adb", buildAdbForwardRemoveArgs(resolvedDeviceId, stoppedState.hostPort), { timeout: ADB_CLEANUP_TIMEOUT_MS, signal });
    } catch {
    }
  }
}
var execFileAsync2, RN_ANDROID_RUNNER_DIR, GRADLEW, APK_APP, APK_TEST, ANDROID_REBUILD_ROOT, ANDROID_REBUILD_LOCK_DATABASE, ANDROID_REBUILD_LOCK_STALE_MS, ADB_CLEANUP_TIMEOUT_MS, runnerProcess2, runnerState2, fetchImpl2;
var init_rn_android_runner_client = __esm({
  "packages/rn-dev-agent-core/dist/runners/rn-android-runner-client.js"() {
    "use strict";
    init_utils();
    init_fast_runner_ref_map();
    init_free_port();
    init_keyboard_guard();
    init_secure_state_file();
    init_protocol();
    init_runner_artifacts();
    init_runtime_paths();
    init_transport_recovery();
    init_process_birth();
    init_authority_store();
    execFileAsync2 = promisify3(execFile3);
    RN_ANDROID_RUNNER_DIR = resolveNativeRunnerDir("rn-android-runner");
    GRADLEW = join18(RN_ANDROID_RUNNER_DIR, "gradlew");
    APK_APP = join18(RN_ANDROID_RUNNER_DIR, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
    APK_TEST = join18(RN_ANDROID_RUNNER_DIR, "app", "build", "outputs", "apk", "androidTest", "debug", "app-debug-androidTest.apk");
    ANDROID_REBUILD_ROOT = join18(RN_ANDROID_RUNNER_DIR, "app", "build");
    ANDROID_REBUILD_LOCK_DATABASE = join18(ANDROID_REBUILD_ROOT, ".authority-rebuild", "lock.sqlite");
    ANDROID_REBUILD_LOCK_STALE_MS = 15 * 6e4;
    ADB_CLEANUP_TIMEOUT_MS = 5e3;
    runnerProcess2 = null;
    runnerState2 = null;
    fetchImpl2 = globalThis.fetch;
  }
});

// packages/rn-dev-agent-core/dist/tools/runner-leak-recovery.js
var init_runner_leak_recovery = __esm({
  "packages/rn-dev-agent-core/dist/tools/runner-leak-recovery.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/tools/app-lifecycle.js
import { execFile as execFileCb2 } from "node:child_process";
import { promisify as promisify4 } from "node:util";
var execFile4;
var init_app_lifecycle = __esm({
  "packages/rn-dev-agent-core/dist/tools/app-lifecycle.js"() {
    "use strict";
    execFile4 = promisify4(execFileCb2);
  }
});

// packages/rn-dev-agent-core/dist/cdp/recovery.js
function markCdpStale() {
  cdpStale = true;
}
var cdpStale;
var init_recovery = __esm({
  "packages/rn-dev-agent-core/dist/cdp/recovery.js"() {
    "use strict";
    cdpStale = false;
  }
});

// packages/rn-dev-agent-core/dist/runners/external-runner-detect.js
import { execFile as execFile5 } from "node:child_process";
import { promisify as promisify5 } from "node:util";
function executableBasename(command) {
  const executable = command.trimStart().split(/\s+/, 1)[0] ?? "";
  return executable.slice(executable.lastIndexOf("/") + 1);
}
function shellWrappedMaestro(command) {
  const tokens = command.trimStart().split(/\s+/);
  if (!SHELL_WRAPPERS.test(executableBasename(tokens[0] ?? "")))
    return false;
  return tokens.slice(1).some((token2) => token2.startsWith("/") && /^maestro(?:\.\w+)?$/i.test(executableBasename(token2)));
}
function isIosExternalRunnerProcessLine(line) {
  const match = line.match(/^\s*\d+\s+(.+)$/);
  if (!match)
    return false;
  const command = match[1];
  const executable = executableBasename(command);
  if (/^maestro(?:-driver-iosUITests-Runner)?$/i.test(executable))
    return true;
  if (shellWrappedMaestro(command))
    return true;
  if (/^WebDriverAgent(?:Runner)?(?:-Runner)?$/i.test(executable))
    return true;
  if (/^java$/i.test(executable) && /(?:^|\s)maestro\.cli\.[\w.$]+(?:\s|$)/i.test(command)) {
    return true;
  }
  if (/^xcodebuild$/i.test(executable) && /(?:maestro[^\s]*|WebDriverAgent[^\s]*)\.xctestrun(?:\s|$)/i.test(command)) {
    return true;
  }
  return false;
}
async function detectIosExternalRunner(execFileImpl = execFile5, udid) {
  try {
    const opts = { timeout: 2e3, encoding: "utf8" };
    const run = execFileImpl === execFile5 ? promisify5(execFileImpl) : execFileImpl;
    const { stdout } = await run("ps", ["axww", "-o", "pid=,command="], opts);
    const lines = stdout.split("\n").filter((line) => isIosExternalRunnerProcessLine(line)).filter((line) => !RN_FAST_RUNNER_RE.test(line)).filter((line) => udid ? line.includes(udid) : true).map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0)
      return null;
    return {
      platform: "ios",
      code: "IOS_XCUITEST_COMPETITOR",
      message: "A foreign maestro/WebDriverAgent automation session is driving this simulator. Interleaving device_* with it may trigger a re-foreground of your app; CDP reads are unaffected. (If this is your own maestro flow, it is expected.)",
      processLines: lines
    };
  } catch {
    return null;
  }
}
var SHELL_WRAPPERS, RN_FAST_RUNNER_RE;
var init_external_runner_detect = __esm({
  "packages/rn-dev-agent-core/dist/runners/external-runner-detect.js"() {
    "use strict";
    SHELL_WRAPPERS = /^(?:sh|bash|zsh|dash|ksh|env)$/i;
    RN_FAST_RUNNER_RE = /RnFastRunner/i;
  }
});

// packages/rn-dev-agent-core/dist/cdp/discovery.js
var init_discovery = __esm({
  "packages/rn-dev-agent-core/dist/cdp/discovery.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_logger();
    init_maestro_validator();
    init_metro_cwd();
  }
});

// packages/rn-dev-agent-core/dist/runners/ensure-single-runner.js
import { homedir as homedir4 } from "node:os";
import { join as join19 } from "node:path";
var DAEMON_JSON, DAEMON_LOCK;
var init_ensure_single_runner = __esm({
  "packages/rn-dev-agent-core/dist/runners/ensure-single-runner.js"() {
    "use strict";
    init_discovery();
    DAEMON_JSON = join19(homedir4(), ".agent-device", "daemon.json");
    DAEMON_LOCK = join19(homedir4(), ".agent-device", "daemon.lock");
  }
});

// packages/rn-dev-agent-core/dist/runners/suppress-ios-autocorrect.js
import { execFile as execFileCb3 } from "node:child_process";
import { promisify as promisify6 } from "node:util";
var execFile6;
var init_suppress_ios_autocorrect = __esm({
  "packages/rn-dev-agent-core/dist/runners/suppress-ios-autocorrect.js"() {
    "use strict";
    execFile6 = promisify6(execFileCb3);
  }
});

// packages/rn-dev-agent-core/dist/lifecycle/foreign-flow-gate.js
var ForeignFlowGate, foreignFlowGate;
var init_foreign_flow_gate = __esm({
  "packages/rn-dev-agent-core/dist/lifecycle/foreign-flow-gate.js"() {
    "use strict";
    init_external_runner_detect();
    ForeignFlowGate = class {
      detect;
      ttlMs;
      now;
      cachedAt = -Infinity;
      cachedUdid = null;
      cached = null;
      inFlight = null;
      inFlightUdid = null;
      _lastActive = false;
      constructor(deps = {}) {
        this.detect = deps.detect ?? ((udid) => detectIosExternalRunner(void 0, udid));
        this.ttlMs = deps.ttlMs ?? 5e3;
        this.now = deps.now ?? Date.now;
      }
      get lastActive() {
        return this._lastActive;
      }
      async check(udid) {
        const t = this.now();
        if (this.cachedUdid === udid && t - this.cachedAt < this.ttlMs) {
          return { active: this.cached !== null, warning: this.cached, fromCache: true, scanMs: 0 };
        }
        if (this.inFlight && this.inFlightUdid === udid)
          return this.inFlight;
        this.inFlightUdid = udid;
        const scan = (async () => {
          const started = this.now();
          let warning = null;
          try {
            warning = await this.detect(udid);
          } catch {
            warning = null;
          }
          this.cached = warning;
          this.cachedUdid = udid;
          this.cachedAt = this.now();
          this._lastActive = warning !== null;
          return { active: warning !== null, warning, fromCache: false, scanMs: this.now() - started };
        })();
        this.inFlight = scan;
        try {
          return await scan;
        } finally {
          if (this.inFlight === scan) {
            this.inFlight = null;
            this.inFlightUdid = null;
          }
        }
      }
    };
    foreignFlowGate = new ForeignFlowGate();
  }
});

// packages/rn-dev-agent-core/dist/lifecycle/device-arbiter.js
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
var DeviceSessionArbiter, arbiter, activeLease;
var init_device_arbiter = __esm({
  "packages/rn-dev-agent-core/dist/lifecycle/device-arbiter.js"() {
    "use strict";
    init_utils();
    init_foreign_flow_gate();
    init_public_diagnostics();
    DeviceSessionArbiter = class {
      flowLeaseHeldBy = null;
      ops = /* @__PURE__ */ new Map();
      nextOpId = 1;
      now;
      constructor(now = Date.now) {
        this.now = now;
      }
      tryAcquire(plane, tool) {
        if (plane === "flow") {
          if (this.flowLeaseHeldBy !== null || this.ops.size > 0) {
            return { ok: false, code: "BUSY_FLOW_ACTIVE", holder: this.describeBlocker() };
          }
          return this.grant(plane, tool, true);
        }
        if (this.flowLeaseHeldBy !== null) {
          return { ok: false, code: "BUSY_FLOW_ACTIVE", holder: this.describeBlocker() };
        }
        return this.grant(plane, tool, false);
      }
      /** Promote only the currently held interaction lease when it is the sole op.
       * Ordinary interactions remain interactions and therefore do not start the
       * pinned post-flow grace window. Inline Maestro escalates lazily at dispatch. */
      promoteToFlow(lease) {
        const info = this.ops.get(lease.opId);
        if (!info || info.plane === "introspection") {
          return { ok: false, code: "BUSY_FLOW_ACTIVE", holder: this.describeBlocker() };
        }
        if (this.flowLeaseHeldBy === lease.opId) {
          return { ok: true, lease: { plane: "flow", opId: lease.opId } };
        }
        if (this.flowLeaseHeldBy !== null || this.ops.size !== 1) {
          return { ok: false, code: "BUSY_FLOW_ACTIVE", holder: this.describeBlocker() };
        }
        info.plane = "flow";
        this.flowLeaseHeldBy = lease.opId;
        return { ok: true, lease: { plane: "flow", opId: lease.opId } };
      }
      grant(plane, tool, isFlow) {
        const opId = this.nextOpId++;
        this.ops.set(opId, { plane, tool, startedAtMs: this.now() });
        if (isFlow)
          this.flowLeaseHeldBy = opId;
        return { ok: true, lease: { plane, opId } };
      }
      describeBlocker() {
        const id = this.flowLeaseHeldBy ?? this.oldestOpId();
        if (id === null)
          return null;
        const info = this.ops.get(id);
        return info ? { plane: info.plane, tool: info.tool, opId: id } : null;
      }
      oldestOpId() {
        let oldest = null;
        let oldestAt = Infinity;
        for (const [id, info] of this.ops) {
          if (info.startedAtMs < oldestAt) {
            oldestAt = info.startedAtMs;
            oldest = id;
          }
        }
        return oldest;
      }
      /** GH#186: set when a FLOW lease releases. Our own maestro driver (argv
       * carries the udid) keeps tearing down WDA for seconds after release and
       * matches the foreign detector — taps inside this window must not scan. */
      lastFlowReleasedAt = -Infinity;
      get msSinceFlowReleased() {
        return this.now() - this.lastFlowReleasedAt;
      }
      release(lease) {
        this.ops.delete(lease.opId);
        if (this.flowLeaseHeldBy === lease.opId) {
          this.flowLeaseHeldBy = null;
          this.lastFlowReleasedAt = this.now();
        }
      }
      reset(reason) {
        const clearedOps = this.ops.size;
        const hadFlow = this.flowLeaseHeldBy !== null;
        this.ops.clear();
        this.flowLeaseHeldBy = null;
        return { clearedOps, hadFlow, reason };
      }
      get snapshot() {
        return {
          flowLeaseHeldBy: this.flowLeaseHeldBy,
          activeOps: this.ops.size,
          ops: [...this.ops.entries()].map(([opId, i]) => ({ opId, plane: i.plane, tool: i.tool }))
        };
      }
      /** #210: true while a flow (Maestro) owns the device. Flow-fallback tools consult this to take an OS-level path. */
      get flowActive() {
        return this.flowLeaseHeldBy !== null;
      }
    };
    arbiter = new DeviceSessionArbiter();
    activeLease = new AsyncLocalStorage2();
  }
});

// packages/rn-dev-agent-core/dist/cdp/recover-wedge.js
import { execFile as execFileCb4 } from "node:child_process";
import { promisify as promisify7 } from "node:util";
var execFile7;
var init_recover_wedge = __esm({
  "packages/rn-dev-agent-core/dist/cdp/recover-wedge.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_rn_fast_runner_client();
    init_device_arbiter();
    init_recovery();
    execFile7 = promisify7(execFileCb4);
  }
});

// packages/rn-dev-agent-core/dist/cdp/app-installed-probe.js
import { execFile as execFileCb5 } from "node:child_process";
import { promisify as promisify8 } from "node:util";
var execFile8;
var init_app_installed_probe = __esm({
  "packages/rn-dev-agent-core/dist/cdp/app-installed-probe.js"() {
    "use strict";
    execFile8 = promisify8(execFileCb5);
  }
});

// packages/rn-dev-agent-core/dist/cdp/recover-detached.js
import { execFile as execFileCb6 } from "node:child_process";
import { promisify as promisify9 } from "node:util";
var execFile9;
var init_recover_detached = __esm({
  "packages/rn-dev-agent-core/dist/cdp/recover-detached.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_rn_fast_runner_client();
    init_device_arbiter();
    init_recovery();
    init_app_installed_probe();
    init_maestro_validator();
    execFile9 = promisify9(execFileCb6);
  }
});

// packages/rn-dev-agent-core/dist/lifecycle/device-lock.js
var init_device_lock = __esm({
  "packages/rn-dev-agent-core/dist/lifecycle/device-lock.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/tools/device-session-close.js
var init_device_session_close = __esm({
  "packages/rn-dev-agent-core/dist/tools/device-session-close.js"() {
    "use strict";
    init_utils();
  }
});

// packages/rn-dev-agent-core/dist/domain/foreground-surface-remedy.js
var init_foreground_surface_remedy = __esm({
  "packages/rn-dev-agent-core/dist/domain/foreground-surface-remedy.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/tools/expo-dev-menu.js
var RESOLVE_EXPO_DEV_MENU, HIDE_EXPO_DEV_MENU_EXPRESSION, SYSTEM_CHROME_REGION_IDENTIFIERS, SYSTEM_CHROME_IDENTIFIERS;
var init_expo_dev_menu = __esm({
  "packages/rn-dev-agent-core/dist/tools/expo-dev-menu.js"() {
    "use strict";
    RESOLVE_EXPO_DEV_MENU = `(function () {
  try { var e = globalThis.expo; if (e && e.modules && e.modules.ExpoDevMenu) return e.modules.ExpoDevMenu; } catch (e0) {}
  try { var nm = require("react-native").NativeModules; if (nm && nm.ExpoDevMenu) return nm.ExpoDevMenu; } catch (e1) {}
  try { if (typeof __turboModuleProxy === "function") { var t = __turboModuleProxy("ExpoDevMenu"); if (t) return t; } } catch (e2) {}
  try { if (typeof globalThis.nativeModuleProxy !== "undefined") { var p = globalThis.nativeModuleProxy.ExpoDevMenu; if (p) return p; } } catch (e3) {}
  return null;
})()`;
    HIDE_EXPO_DEV_MENU_EXPRESSION = `(function () {
  var m = ${RESOLVE_EXPO_DEV_MENU};
  if (!m) return "no_module";
  var method = null;
  var close = null;
  try {
    if (typeof m.hideMenu === "function") { method = "hideMenu"; close = m.hideMenu; }
    else if (typeof m.closeMenu === "function") { method = "closeMenu"; close = m.closeMenu; }
    if (!method) return "no_method_available";
  } catch (e) { return "resolution_error:" + (e && e.message ? e.message : String(e)); }
  try {
    var pending = Promise.resolve(close.call(m)).then(function () { return "ok:" + method; }, function (e) { return "error:" + method + ":" + (e && e.message ? e.message : String(e)); });
    return { __rnAgentStartValue: "sent:" + method, then: function (resolve, reject) { return pending.then(resolve, reject); } };
  } catch (e) { return "error:" + method + ":" + (e && e.message ? e.message : String(e)); }
})()`;
    SYSTEM_CHROME_REGION_IDENTIFIERS = /* @__PURE__ */ new Set([
      "status_bar",
      "status_bar_container",
      "navigation_bar_frame",
      "nav_bar_background",
      "taskbar_container",
      "navbuttons_view"
    ]);
    SYSTEM_CHROME_IDENTIFIERS = /* @__PURE__ */ new Set([
      ...SYSTEM_CHROME_REGION_IDENTIFIERS,
      "status_bar_launch_animation_container",
      "status_bar_contents",
      "status_bar_start_side_container",
      "status_bar_start_side_content",
      "status_bar_start_side_except_heads_up",
      "status_bar_end_side_container",
      "status_bar_end_side_content",
      "clock",
      "notification_icon_area",
      "notificationicons",
      "cutout_space_view",
      "system_icons",
      "statusicons",
      "wifi_combo",
      "wifi_group",
      "wifi_signal",
      "mobile_combo",
      "mobile_group",
      "mobile_signal",
      "battery",
      "taskbar_scrim",
      "start_contextual_buttons",
      "end_contextual_buttons",
      "end_nav_buttons",
      "taskbar_bubbles_container",
      "back",
      "home",
      "recent_apps",
      "recents",
      "overview",
      "home_handle"
    ]);
  }
});

// packages/rn-dev-agent-core/dist/tools/device-session.js
import { execFile as execFileCb7 } from "node:child_process";
import { promisify as promisify10 } from "node:util";
var execFile10;
var init_device_session = __esm({
  "packages/rn-dev-agent-core/dist/tools/device-session.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_rn_fast_runner_client();
    init_rn_android_runner_client();
    init_app_lifecycle();
    init_recovery();
    init_external_runner_detect();
    init_ensure_single_runner();
    init_suppress_ios_autocorrect();
    init_recover_wedge();
    init_recover_detached();
    init_utils();
    init_project_config();
    init_maestro_validator();
    init_logger();
    init_runner_leak_recovery();
    init_device_lock();
    init_device_arbiter();
    init_device_session_close();
    init_foreground_surface_remedy();
    init_expo_dev_menu();
    execFile10 = promisify10(execFileCb7);
  }
});

// packages/rn-dev-agent-core/dist/tools/fill-verify.js
var init_fill_verify = __esm({
  "packages/rn-dev-agent-core/dist/tools/fill-verify.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/tools/device-interact.js
import { execFile as execFileCb8 } from "node:child_process";
import { promisify as promisify11 } from "node:util";
var execFile11;
var init_device_interact = __esm({
  "packages/rn-dev-agent-core/dist/tools/device-interact.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_rn_fast_runner_client();
    init_rn_android_runner_client();
    init_keyboard_guard();
    init_project_config();
    init_maestro_validator();
    init_utils();
    init_utils();
    init_runner_leak_recovery();
    init_device_session();
    init_fast_runner_ref_map();
    init_fill_verify();
    execFile11 = promisify11(execFileCb8);
  }
});

// packages/rn-dev-agent-core/dist/session/target-device-authority.js
var init_target_device_authority = __esm({
  "packages/rn-dev-agent-core/dist/session/target-device-authority.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/session/metro-origin.js
var init_metro_origin = __esm({
  "packages/rn-dev-agent-core/dist/session/metro-origin.js"() {
    "use strict";
    init_discovery();
    init_registry();
    init_target_device_authority();
  }
});

// packages/rn-dev-agent-core/dist/session/install-authority.js
var init_install_authority = __esm({
  "packages/rn-dev-agent-core/dist/session/install-authority.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/session/install-reissue.js
var init_install_reissue = __esm({
  "packages/rn-dev-agent-core/dist/session/install-reissue.js"() {
    "use strict";
    init_install_authority();
    init_registry();
  }
});

// packages/rn-dev-agent-core/dist/session/tool-profiles.js
function facetsOf(groups, narrowing = {}) {
  const facets = new Set(groups.flatMap((group) => [...groupFacets[group]]));
  for (const facet of narrowing.overlay ?? [])
    facets.add(facet);
  for (const facet of narrowing.without ?? [])
    facets.delete(facet);
  return facetOrder.filter((facet) => facets.has(facet));
}
function add(names, profile) {
  for (const name of names) {
    if (profiles.has(name))
      throw new Error(`DUPLICATE_AUTHORITY_PROFILE: ${name}`);
    profiles.set(name, profile);
  }
}
var groupFacets, facetOrder, session, osScoped, nativeControl, throughRuntime, allGroups, diagnostic, transition, sourceState, nativeRead, nativeVerdict, nativeMutation, managedNativeMutation, hybridMutation, optionalHybridMutation, nativeDiagnostic, cdpRead, pickerRecovery, cdpMutation, observe, proof, profiles;
var init_tool_profiles = __esm({
  "packages/rn-dev-agent-core/dist/session/tool-profiles.js"() {
    "use strict";
    groupFacets = {
      session: ["C", "S"],
      target: ["D", "I"],
      runtime: ["M", "B", "A"],
      automation: ["R"]
    };
    facetOrder = ["C", "S", "I", "M", "A", "B", "D", "R", "P"];
    session = ["session"];
    osScoped = ["session", "target"];
    nativeControl = ["session", "target", "automation"];
    throughRuntime = ["session", "target", "runtime"];
    allGroups = ["session", "target", "runtime", "automation"];
    diagnostic = ["cdp_status", "cdp_targets", "device_list"];
    transition = ["rn_session", "cdp_connect", "cdp_disconnect"];
    sourceState = [
      "cdp_nav_graph",
      "cdp_record_test_generate",
      "cdp_record_test_list",
      "cdp_record_test_load",
      "cdp_record_test_save",
      "cdp_record_test_save_as_action",
      "maestro_generate"
    ];
    nativeRead = ["device_find", "device_screenshot", "device_snapshot"];
    nativeVerdict = ["cross_platform_verify"];
    nativeMutation = [
      "device_accept_system_dialog",
      "device_back",
      "device_batch",
      "device_deeplink",
      "device_dismiss_system_dialog",
      "device_fill",
      "device_focus_next",
      "device_longpress",
      "device_permission",
      "device_pick_date",
      "device_pick_value",
      "device_pinch",
      "device_press",
      "device_record",
      "device_reset_state",
      "device_scroll",
      "device_scrollintoview",
      "device_swipe"
    ];
    managedNativeMutation = [
      "cdp_lock_e2e_test",
      "cdp_repair_action",
      "maestro_run",
      "maestro_test_all"
    ];
    hybridMutation = ["cdp_auto_login", "cdp_run_e2e_suite"];
    optionalHybridMutation = ["cdp_login_prologue", "cdp_run_action"];
    nativeDiagnostic = ["cdp_native_errors"];
    cdpRead = [
      "cdp_component_state",
      "cdp_component_tree",
      "cdp_console_log",
      "cdp_cpu_profile",
      "cdp_diagnostic_renderers",
      "cdp_error_log",
      "cdp_heap_usage",
      "cdp_metro_events",
      "cdp_navigation_state",
      "cdp_network_body",
      "cdp_network_log",
      "cdp_object_inspect",
      "cdp_open_devtools",
      "cdp_store_state",
      "cdp_wait_for_network",
      "collect_logs",
      "expect_redux",
      "expect_route",
      "expect_text",
      "expect_visible_by_testid"
    ];
    pickerRecovery = ["cdp_dismiss_dev_client_picker"];
    cdpMutation = [
      "cdp_dev_settings",
      "cdp_dispatch",
      "cdp_evaluate",
      "cdp_exception_breakpoint",
      "cdp_interact",
      "cdp_mmkv",
      "cdp_navigate",
      "cdp_record_test_annotate",
      "cdp_record_test_start",
      "cdp_record_test_stop",
      "cdp_reload",
      "cdp_restart",
      "cdp_set_shared_value"
    ];
    observe = ["observe"];
    proof = ["proof_capture", "proof_step"];
    profiles = /* @__PURE__ */ new Map();
    add(diagnostic, {
      kind: "diagnostic",
      groups: [],
      axes: [],
      mutation: false,
      liveBundleProbe: false
    });
    add(transition, {
      kind: "transition",
      groups: session,
      axes: facetsOf(session),
      mutation: true,
      liveBundleProbe: false
    });
    add(sourceState, {
      kind: "authoritative",
      groups: session,
      axes: facetsOf(session),
      mutation: true,
      liveBundleProbe: false
    });
    add(nativeRead, {
      kind: "authoritative",
      groups: nativeControl,
      axes: facetsOf(nativeControl),
      nativeOrigin: "optional",
      mutation: false,
      liveBundleProbe: false
    });
    add(nativeVerdict, {
      kind: "authoritative",
      groups: allGroups,
      axes: facetsOf(allGroups, { without: ["B"] }),
      nativeOrigin: "required",
      mutation: false,
      liveBundleProbe: false
    });
    add(nativeMutation, {
      kind: "authoritative",
      groups: nativeControl,
      axes: facetsOf(nativeControl),
      nativeOrigin: "optional",
      mutation: true,
      liveBundleProbe: false
    });
    add(managedNativeMutation, {
      kind: "authoritative",
      groups: allGroups,
      axes: facetsOf(allGroups, { without: ["B"] }),
      nativeOrigin: "required",
      mutation: true,
      liveBundleProbe: false
    });
    add(hybridMutation, {
      kind: "authoritative",
      groups: allGroups,
      axes: facetsOf(allGroups, { without: ["A"] }),
      mutation: true,
      liveBundleProbe: true
    });
    add(optionalHybridMutation, {
      kind: "authoritative",
      groups: allGroups,
      axes: facetsOf(allGroups, { without: ["A", "B"] }),
      optionalAxes: ["B"],
      managedOrigin: true,
      managedRunnerPark: true,
      managedInstallReissue: true,
      mutation: true,
      liveBundleProbe: true
    });
    add(nativeDiagnostic, {
      kind: "authoritative",
      groups: osScoped,
      axes: facetsOf(osScoped),
      mutation: false,
      liveBundleProbe: false
    });
    add(cdpRead, {
      kind: "authoritative",
      groups: throughRuntime,
      axes: facetsOf(throughRuntime, { without: ["A"] }),
      mutation: false,
      liveBundleProbe: true
    });
    add(cdpMutation, {
      kind: "authoritative",
      groups: throughRuntime,
      axes: facetsOf(throughRuntime, { without: ["A"] }),
      mutation: true,
      liveBundleProbe: true
    });
    add(pickerRecovery, {
      kind: "authoritative",
      groups: throughRuntime,
      axes: facetsOf(throughRuntime, { without: ["A", "B"] }),
      managedOrigin: true,
      mutation: true,
      liveBundleProbe: false
    });
    add(observe, {
      kind: "authoritative",
      groups: session,
      axes: facetsOf(session),
      mutation: false,
      liveBundleProbe: false
    });
    add(proof, {
      kind: "authoritative",
      groups: allGroups,
      axes: facetsOf(allGroups, { overlay: ["P"] }),
      nativeOrigin: "required",
      mutation: true,
      liveBundleProbe: true
    });
  }
});

// packages/rn-dev-agent-core/dist/session/authority-gate.js
async function claimManagedNativeOriginAuthority(args) {
  const authority = args[managedNativeOrigin];
  if (!authority) {
    throw new SessionAuthorityError("METRO_ORIGIN_MISMATCH", "managed native origin authority is unavailable");
  }
  await authority.claim();
}
async function completeManagedNativeOriginAuthority(args, targetExpected, signal) {
  const authority = args[managedNativeOrigin];
  if (!authority) {
    throw new SessionAuthorityError("METRO_ORIGIN_MISMATCH", "managed native origin authority is unavailable");
  }
  await authority.complete(targetExpected, signal);
}
async function relaunchManagedNativeOriginApp(args, stopApp) {
  const authority = args[managedNativeOrigin];
  if (!authority) {
    throw new SessionAuthorityError("METRO_ORIGIN_MISMATCH", "managed native origin relaunch authority is unavailable");
  }
  await authority.relaunch(stopApp);
}
async function reproveManagedNativeOrigin(args, options) {
  const authority = args[managedNativeOrigin];
  if (!authority) {
    throw new SessionAuthorityError("METRO_ORIGIN_MISMATCH", "managed native origin re-prove authority is unavailable");
  }
  await authority.reprove(options);
}
async function reissueManagedInstallAuthority(args) {
  const reissue = args[managedInstallReissue];
  if (!reissue) {
    throw new SessionAuthorityError("APP_INSTALL_IDENTITY_CHANGED", "managed install re-issue authority is unavailable");
  }
  await reissue();
}
function hasManagedNativeOriginAuthority(args) {
  return args[managedNativeOrigin] !== void 0;
}
function hasManagedInstallReissueAuthority(args) {
  return typeof args[managedInstallReissue] === "function";
}
async function completeManagedRunnerParkAuthority(args, signal) {
  const complete = args[managedRunnerPark];
  if (!complete) {
    throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "managed runner parking authority is unavailable");
  }
  await complete(signal);
}
var managedNativeOrigin, managedRunnerPark, managedInstallReissue;
var init_authority_gate = __esm({
  "packages/rn-dev-agent-core/dist/session/authority-gate.js"() {
    "use strict";
    init_utils();
    init_registry();
    init_metro_origin();
    init_install_reissue();
    init_tool_profiles();
    managedNativeOrigin = /* @__PURE__ */ Symbol("managedNativeOrigin");
    managedRunnerPark = /* @__PURE__ */ Symbol("managedRunnerPark");
    managedInstallReissue = /* @__PURE__ */ Symbol("managedInstallReissue");
  }
});

// packages/rn-dev-agent-core/dist/tools/dev-client-picker.js
var init_dev_client_picker = __esm({
  "packages/rn-dev-agent-core/dist/tools/dev-client-picker.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_platform_utils();
    init_utils();
    init_device_interact();
    init_authority_gate();
  }
});

// packages/rn-dev-agent-core/dist/utils.js
function okResult(data, opts) {
  const envelope = { ok: true, data };
  if (opts?.truncated)
    envelope.truncated = true;
  if (opts?.meta)
    envelope.meta = opts.meta;
  return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
}
function failResult(error, metaOrCode, maybeMeta) {
  const envelope = { ok: false, error };
  if (typeof metaOrCode === "string") {
    envelope.code = metaOrCode;
    if (maybeMeta)
      envelope.meta = maybeMeta;
  } else if (metaOrCode) {
    envelope.meta = metaOrCode;
  }
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: true
  };
}
function warnResult(data, warning, meta) {
  const envelope = { ok: true, data, meta: { ...meta, warning } };
  return { content: [{ type: "text", text: JSON.stringify(envelope) }] };
}
var init_utils = __esm({
  "packages/rn-dev-agent-core/dist/utils.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_dev_client_picker();
    init_recovery();
  }
});

// packages/rn-dev-agent-core/dist/runners/release-android-slot.js
import { execFile as execFileCb9 } from "node:child_process";
import { promisify as promisify12 } from "node:util";
import { existsSync as existsSync15, readFileSync as readFileSync13, unlinkSync as unlinkSync7 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join21 } from "node:path";
function isProtectedPid(pid, selfPid, parentPid) {
  return pid === selfPid || pid === parentPid;
}
function defaultDeps() {
  return {
    stopOwnRunner: (deviceId, signal) => stopAndroidRunner(deviceId, signal),
    adbForceStop: async (pkg, serial, signal) => {
      await execFile12("adb", [...serial, "shell", "am", "force-stop", pkg], {
        timeout: ADB_TIMEOUT_MS,
        encoding: "utf8",
        signal
      });
    },
    resolveSerial: (deviceId) => deviceId ? ["-s", deviceId] : getAdbSerial(),
    readDaemonPid: () => {
      try {
        const parsed = JSON.parse(readFileSync13(DAEMON_JSON2, "utf8"));
        return typeof parsed.pid === "number" ? parsed.pid : null;
      } catch {
        return null;
      }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    protectedPids: () => ({ selfPid: process.pid, parentPid: process.ppid }),
    kill: (pid, sig) => process.kill(pid, sig),
    fileExists: (p) => existsSync15(p),
    removeFile: (p) => unlinkSync7(p),
    delay: (ms) => new Promise((resolve9) => setTimeout(resolve9, ms)),
    killLegacy: () => process.env.RN_DEVICE_KILL_LEGACY !== "0",
    now: () => Date.now()
  };
}
function resolveExactSerialArgs(deps, deviceId) {
  try {
    return deps.resolveSerial(deviceId);
  } catch (err) {
    throw new ExactAndroidDeviceRequiredError(err);
  }
}
function exactSerial(deviceId, serialArgs) {
  const serial = serialArgs.length === 2 && serialArgs[0] === "-s" ? serialArgs[1] : void 0;
  if (!serial || deviceId !== void 0 && serial !== deviceId || serial.length > 256 || /\s/.test(serial)) {
    throw new ExactAndroidDeviceRequiredError();
  }
  return serial;
}
async function releaseAndroidInteractionSlot(opts = {}, deps = defaultDeps()) {
  opts.signal?.throwIfAborted();
  const serialArgs = resolveExactSerialArgs(deps, opts.deviceId);
  const deviceId = exactSerial(opts.deviceId, serialArgs);
  const timings = {};
  const warnings = [];
  const forceStoppedPackages = [];
  const killedDaemonPids = [];
  const removedFiles = [];
  let stoppedOwnRunner = false;
  const tStop = deps.now();
  try {
    await deps.stopOwnRunner(deviceId, opts.signal);
    opts.signal?.throwIfAborted();
    stoppedOwnRunner = true;
  } catch (err) {
    opts.signal?.throwIfAborted();
    warnings.push(`stopping the Android runner failed: ${msg(err)}`);
  }
  timings.stopOwnRunner = deps.now() - tStop;
  const tForceStop = deps.now();
  for (const pkg of OWNED_PACKAGES) {
    opts.signal?.throwIfAborted();
    try {
      await deps.adbForceStop(pkg, serialArgs, opts.signal);
      opts.signal?.throwIfAborted();
      forceStoppedPackages.push(pkg);
    } catch (err) {
      opts.signal?.throwIfAborted();
      warnings.push(`am force-stop ${pkg} failed: ${msg(err)}`);
    }
  }
  timings.forceStop = deps.now() - tForceStop;
  const tLegacy = deps.now();
  if (opts.includeLegacy !== false && deps.killLegacy()) {
    try {
      const pid = deps.readDaemonPid();
      let keepFiles = false;
      if (pid !== null && deps.isAlive(pid)) {
        const { selfPid, parentPid } = deps.protectedPids();
        if (isProtectedPid(pid, selfPid, parentPid)) {
          warnings.push(`Refusing to kill agent-device daemon PID ${pid} \u2014 it is our own process/parent.`);
          keepFiles = true;
        } else {
          try {
            deps.kill(pid, "SIGTERM");
            await deps.delay(SIGKILL_GRACE_MS);
            if (deps.isAlive(pid))
              deps.kill(pid, "SIGKILL");
            killedDaemonPids.push(pid);
          } catch (err) {
            warnings.push(`kill daemon ${pid} failed: ${msg(err)}`);
            keepFiles = true;
          }
        }
      }
      if (!keepFiles) {
        for (const f of DAEMON_FILES) {
          if (!deps.fileExists(f))
            continue;
          try {
            deps.removeFile(f);
            removedFiles.push(f);
          } catch (err) {
            warnings.push(`rm ${f} failed: ${msg(err)}`);
          }
        }
      }
    } catch (err) {
      warnings.push(`legacy daemon cleanup failed: ${msg(err)}`);
    }
  }
  timings.legacyDaemon = deps.now() - tLegacy;
  return {
    deviceId,
    stoppedOwnRunner,
    forceStoppedPackages,
    killedDaemonPids,
    removedFiles,
    warnings,
    meta: { timings_ms: timings }
  };
}
function msg(err) {
  return err instanceof Error ? err.message : String(err);
}
var execFile12, DAEMON_JSON2, DAEMON_LOCK2, DAEMON_FILES, SIGKILL_GRACE_MS, ADB_TIMEOUT_MS, OWNED_PACKAGES, ExactAndroidDeviceRequiredError;
var init_release_android_slot = __esm({
  "packages/rn-dev-agent-core/dist/runners/release-android-slot.js"() {
    "use strict";
    init_rn_android_runner_client();
    init_agent_device_wrapper();
    execFile12 = promisify12(execFileCb9);
    DAEMON_JSON2 = join21(homedir5(), ".agent-device", "daemon.json");
    DAEMON_LOCK2 = join21(homedir5(), ".agent-device", "daemon.lock");
    DAEMON_FILES = [DAEMON_JSON2, DAEMON_LOCK2];
    SIGKILL_GRACE_MS = 500;
    ADB_TIMEOUT_MS = 5e3;
    OWNED_PACKAGES = [
      "dev.lykhoyda.rndevagent.androidrunner.test",
      "dev.lykhoyda.rndevagent.androidrunner"
    ];
    ExactAndroidDeviceRequiredError = class extends Error {
      code = "EXACT_ANDROID_DEVICE_REQUIRED";
      constructor(cause) {
        super("Refusing to release the Android interaction slot without an exact serial. When multiple adb targets are attached, open or bind a session to the intended device, pass deviceId, or set ANDROID_SERIAL, then retry. No device was mutated.", cause === void 0 ? void 0 : { cause });
        this.name = "ExactAndroidDeviceRequiredError";
      }
    };
  }
});

// packages/rn-dev-agent-core/dist/maestro-runner-pin.js
import { spawnSync as spawnSync3 } from "node:child_process";
import { existsSync as existsSync18 } from "node:fs";
import { dirname as dirname15, join as join24, resolve as resolve8 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// packages/rn-dev-agent-core/dist/domain/engine-pin.js
init_process_birth();
import { spawnSync } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { accessSync, chmodSync as chmodSync2, constants as constants2, copyFileSync as copyFileSync2, cpSync, existsSync as existsSync3, lstatSync as lstatSync2, mkdirSync, mkdtempSync, readFileSync as readFileSync2, readdirSync, readlinkSync, realpathSync as realpathSync2, renameSync, rmSync, symlinkSync, unlinkSync as unlinkSync2, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname as dirname2, isAbsolute, join as join2, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

// packages/rn-dev-agent-core/dist/experience/runner-diagnostics.js
import { AsyncLocalStorage } from "node:async_hooks";
import { performance as performance2 } from "node:perf_hooks";
var RUNNER_DIAGNOSTICS_MAX_EVENTS = 200;
var storage = new AsyncLocalStorage();
var TERMINAL_EVENT_TYPES = /* @__PURE__ */ new Set([
  "typed-failure",
  "cleanup",
  "tool-outcome"
]);
function retainRunnerDiagnosticEvents(events, maximum) {
  if (maximum <= 0)
    return [];
  const retained = [...events];
  while (retained.length > maximum) {
    const counts = /* @__PURE__ */ new Map();
    for (const event of retained)
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    let removeAt = retained.findIndex((event) => !TERMINAL_EVENT_TYPES.has(event.type) && (counts.get(event.type) ?? 0) > 1);
    if (removeAt < 0) {
      removeAt = retained.findIndex((event) => !TERMINAL_EVENT_TYPES.has(event.type));
    }
    if (removeAt < 0) {
      removeAt = retained.findIndex((event) => (counts.get(event.type) ?? 0) > 1);
    }
    retained.splice(removeAt < 0 ? 0 : removeAt, 1);
  }
  return retained;
}
function recordRunnerDiagnostic(type, detail = {}) {
  const state = storage.getStore();
  if (!state)
    return;
  const event = {
    sequence: ++state.nextSequence,
    monotonicMs: Math.max(0, Math.round((performance2.now() - state.startedAt) * 1e3) / 1e3),
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    type,
    detail
  };
  const retained = retainRunnerDiagnosticEvents([...state.events, event], RUNNER_DIAGNOSTICS_MAX_EVENTS);
  if (retained.length < state.events.length + 1) {
    state.truncated = true;
  }
  state.events = retained;
}

// packages/rn-dev-agent-core/dist/domain/maestro-runner-pin.json
var maestro_runner_pin_default = {
  version: "1.1.24",
  sha256: {
    "darwin-arm64": "170f12521de83322823dd5fc0ce16e48abeba9952cdbb242670592566c2fd1f3",
    "darwin-x64": "af7f5ea044afc72ea780c835f05b32203e443d2e26d310a864bfb2bc84959bf6",
    "linux-x64": "e9bdef6f08f855ca1a884f99b54a519a1eae0a342917181a53eb414a5b00d6d8",
    "linux-arm64": "8d8a6483ad04da2109636b7192398750657801b8a8d512688d1be3b033a105b8"
  },
  archiveSha256: {
    "darwin-arm64": "0b5b0f087815c5ff348e74a6dd7df260ed50a5588d5ff3e224c66a60d948c936",
    "darwin-x64": "2ecc5c55d9437ee820691faf43097b5ba8d1ff797db49da9c96ac2631aac03c5",
    "linux-x64": "f1963b7e3f8bf598d3b14f998fef3dc690e579906f340636cfd9350dea1d67b0",
    "linux-arm64": "605db5645b161b610e999bcf8235650d41aac8929bbd0f818a592d13b958f148"
  },
  knownQuirks: [
    {
      id: "android-pre-o-unsupported",
      ref: "GH #741",
      note: "bundled UiAutomator2 server APK declares minSdk 26; API 23-25 installs fail with INSTALL_FAILED_OLDER_SDK"
    }
  ]
};

// packages/rn-dev-agent-core/dist/domain/engine-pin.js
var MAESTRO_RUNNER_PIN = Object.freeze({
  version: maestro_runner_pin_default.version,
  sha256: Object.freeze({ ...maestro_runner_pin_default.sha256 }),
  archiveSha256: Object.freeze({ ...maestro_runner_pin_default.archiveSha256 }),
  knownQuirks: Object.freeze(maestro_runner_pin_default.knownQuirks.map((quirk) => Object.freeze({ ...quirk })))
});
var TRUSTED_DRIFT_SHA256 = Object.freeze({
  "1.0.9": Object.freeze({
    "darwin-arm64": "7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923",
    "darwin-x64": "36f8a973c3231b6b8125db4a3e131b8c3193aec6774145584b18070be979fd5f",
    "linux-arm64": "a8e8197c63502fba874ce69b908174d46a47c6539025184e3003e70576d9451e",
    "linux-x64": "bf7e9ef297c35712e9fad0ad56a65b7fd94e1f30168733cf09459b4ea80c4c3e"
  })
});
var ACTION_ENGINE_PIN = `maestro-runner@${MAESTRO_RUNNER_PIN.version}`;
var ACTION_ENGINE_PIN_RE = /^maestro-runner@(\d+(?:\.\d+)*)$/;
function parseActionEnginePinVersion(enginePin) {
  const match = ACTION_ENGINE_PIN_RE.exec(enginePin.trim());
  return match?.[1] ?? null;
}
var HOST_PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}";
var PINNED_RUNNER_INSTALL_HINT = `bash ${HOST_PLUGIN_ROOT}/scripts/ensure-maestro-runner.sh`;
var PINNED_RUNNER_DIAGNOSE_HINT = `node ${HOST_PLUGIN_ROOT}/rn-dev-agent-core/dist/maestro-runner-pin.js diagnose`;
var MAESTRO_RUNNER_MIN_ANDROID_API = 26;
var PRE_O_REMEDY = "Action replay / E2E via the maestro engine is unsupported on this device; the direct device_* interaction tier still works (rn-android-runner supports API 23+), except for the few device_* paths that fall back to maestro (dev-client picker and system dialogs), which hit this same limit.";
function engineLabel(_runner) {
  return `the pinned maestro-runner ${MAESTRO_RUNNER_PIN.version}`;
}
function preOAndroidApiRefusal(apiLevel) {
  if (apiLevel >= MAESTRO_RUNNER_MIN_ANDROID_API)
    return null;
  return `maestro_run refused: Android API ${apiLevel} is below API ${MAESTRO_RUNNER_MIN_ANDROID_API}, the minimum the pinned maestro-runner ${MAESTRO_RUNNER_PIN.version} can drive \u2014 its bundled UiAutomator2 server APK declares minSdk ${MAESTRO_RUNNER_MIN_ANDROID_API}, so the install fails with INSTALL_FAILED_OLDER_SDK. ${PRE_O_REMEDY}`;
}
var OLDER_SDK_TOKEN = /INSTALL_FAILED_OLDER_SDK/g;
var INSTALL_REJECT_CONTEXT = /\b(?:adb|install|installing|failure|uiautomator2)\b|\.apk\b/i;
function isOlderSdkInstallFailure(output) {
  return output.split(/\r?\n/).some((line) => line.includes("INSTALL_FAILED_OLDER_SDK") && INSTALL_REJECT_CONTEXT.test(line.replace(OLDER_SDK_TOKEN, " ")));
}
function olderSdkInstallDiagnosis(runner = "maestro-runner") {
  return `The device rejected the bundled UiAutomator2 server APK with INSTALL_FAILED_OLDER_SDK: ${engineLabel(runner)} requires Android API ${MAESTRO_RUNNER_MIN_ANDROID_API}+ and this device is below it. ${PRE_O_REMEDY}`;
}
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y)
      return 1;
    if (x < y)
      return -1;
  }
  return 0;
}
function meetsMaestroRunnerFloor(version) {
  return /^\d+(?:\.\d+)*$/.test(version) && compareVersions(version, MAESTRO_RUNNER_PIN.version) >= 0;
}
function pinCacheRoot(home = homedir()) {
  const override = process.env.RN_DEV_AGENT_RUNNER_CACHE;
  const base = override && override.length > 0 ? override : join2(home, ".cache", "rn-dev-agent");
  return resolve(base, "maestro-runner", MAESTRO_RUNNER_PIN.version);
}
function pinnedRunnerBinPath(home) {
  return join2(pinCacheRoot(home), "bin", "maestro-runner");
}
function isPinCacheMetadataPath(relPath) {
  return relPath.split(/[/\\]/).some((part) => part.startsWith("._") || part === "PaxHeader" || part.startsWith("PaxHeaders."));
}
function tarText(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end >= offset && end < offset + length ? end : offset + length).toString();
}
function expectedPayloadEntries(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 1024 * 1024 * 1024 });
  const raw = [];
  let offset = 0;
  let longPath = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0))
      break;
    const prefix = tarText(header, 345, 155);
    const name = tarText(header, 0, 100);
    const sizeText = tarText(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      return null;
    const type = String.fromCharCode(header[156] || 48);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    const archivePath = longPath ?? [prefix, name].filter(Boolean).join("/");
    longPath = null;
    if (type === "L") {
      longPath = data.toString().split("\0")[0].trim();
    } else if (type === "0" || type === "\0" || type === "2" || type === "5") {
      raw.push({ path: archivePath, type, data, link: tarText(header, 157, 100) });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const runner = raw.find((entry) => (entry.type === "0" || entry.type === "\0") && (entry.path === "bin/maestro-runner" || entry.path.endsWith("/bin/maestro-runner")));
  if (!runner)
    return null;
  const rootPrefix = runner.path.slice(0, -"bin/maestro-runner".length);
  const expected = /* @__PURE__ */ new Map();
  for (const entry of raw) {
    if (!entry.path.startsWith(rootPrefix) || entry.type === "5")
      continue;
    const path = entry.path.slice(rootPrefix.length).replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.split("/").some((part) => part === ".."))
      return null;
    if (isPinCacheMetadataPath(path))
      continue;
    if (entry.type === "2") {
      expected.set(path, { kind: "symlink", target: entry.link });
    } else {
      expected.set(path, {
        kind: "file",
        sha256: createHash2("sha256").update(entry.data).digest("hex")
      });
    }
  }
  return expected;
}
function payloadMatchesPinnedArchive(root2, archive, expectedArchiveSha256) {
  if (createHash2("sha256").update(archive).digest("hex") !== expectedArchiveSha256)
    return false;
  const expected = expectedPayloadEntries(archive);
  if (!expected)
    return false;
  const seen = /* @__PURE__ */ new Set();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join2(directory, entry.name);
      const rel = relative(root2, path).split(sep).join("/");
      if (rel === ".payload.tar.gz" || isPinCacheMetadataPath(rel))
        continue;
      if (entry.isDirectory()) {
        if (!visit(path))
          return false;
        continue;
      }
      const wanted = expected.get(rel);
      if (!wanted)
        return false;
      seen.add(rel);
      if (entry.isSymbolicLink()) {
        if (wanted.kind !== "symlink" || readlinkSync(path) !== wanted.target)
          return false;
        continue;
      }
      if (!entry.isFile() || wanted.kind !== "file")
        return false;
      const sha2562 = createHash2("sha256").update(readFileSync2(path)).digest("hex");
      if (sha2562 !== wanted.sha256)
        return false;
    }
    return true;
  };
  return visit(root2) && seen.size === expected.size;
}
function installedPayloadMatchesPin(platformKey, root2 = pinCacheRoot()) {
  try {
    const expectedArchiveSha = pinnedArchiveSha256(platformKey);
    if (!expectedArchiveSha)
      return false;
    const archive = readFileSync2(join2(root2, ".payload.tar.gz"));
    return payloadMatchesPinnedArchive(root2, archive, expectedArchiveSha);
  } catch {
    return false;
  }
}
function isRegularPinCacheBinary(path) {
  try {
    const stat = lstatSync2(path);
    const ancestors = [dirname2(path), dirname2(dirname2(path)), dirname2(dirname2(dirname2(path)))];
    const contained2 = ancestors.every((ancestor) => {
      const ancestorStat = lstatSync2(ancestor);
      return ancestorStat.isDirectory() && !ancestorStat.isSymbolicLink();
    });
    accessSync(path, constants2.X_OK);
    return contained2 && stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
function getMaestroRunnerPath() {
  const path = pinnedRunnerBinPath();
  return isRegularPinCacheBinary(path) ? path : null;
}
function runnerCacheVersionsRoot() {
  return dirname2(pinCacheRoot());
}
function pinCacheVersionForPath(path) {
  if (!isRegularPinCacheBinary(path) || basename(path) !== "maestro-runner")
    return null;
  const versionDir = dirname2(dirname2(resolve(path)));
  if (dirname2(versionDir) !== resolve(runnerCacheVersionsRoot()))
    return null;
  const version = basename(versionDir);
  return /^\d+(?:\.\d+)*$/.test(version) ? version : null;
}
function getMaestroRunnerDetectionPath() {
  const exact = getMaestroRunnerPath();
  if (exact)
    return exact;
  const root2 = runnerCacheVersionsRoot();
  try {
    const candidates = readdirSync(root2, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)*$/.test(entry.name)).map((entry) => ({
      version: entry.name,
      path: join2(root2, entry.name, "bin", "maestro-runner")
    })).filter((candidate) => isRegularPinCacheBinary(candidate.path)).sort((left, right) => compareVersions(right.version, left.version));
    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}
function nodePlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}
function pinArchiveCoords(platformKey) {
  switch (platformKey) {
    case "darwin-arm64":
      return { os: "darwin", arch: "arm64" };
    case "darwin-x64":
      return { os: "darwin", arch: "amd64" };
    case "linux-x64":
      return { os: "linux", arch: "amd64" };
    case "linux-arm64":
      return { os: "linux", arch: "arm64" };
    default:
      return null;
  }
}
function buildReplayEngineStatus(cls, version, _cliPresent, extras = {}) {
  const engine = cls === "pinned-ok" ? "maestro-runner" : "none";
  return {
    engine,
    version,
    pin: { pinned: MAESTRO_RUNNER_PIN.version, status: cls },
    quirks: MAESTRO_RUNNER_PIN.knownQuirks.map((q) => q.id),
    selectedPath: extras.selectedPath ?? null,
    provenance: extras.provenance ?? (cls === "not-installed" ? "none" : "pin-cache")
  };
}
function enginePinCaveat(status) {
  const cls = status.pin.status;
  if (cls === "drift-newer" || cls === "drift-older") {
    return `maestro-runner ${status.version} differs from the tested pin ${status.pin.pinned} (untested drift \u2014 B223-class behavior changes arrive silently; see the upgrade ritual in engine-pin.ts)`;
  }
  if (cls === "checksum-mismatch") {
    return `maestro-runner pin-cache binary checksum does not match the ${status.pin.pinned} manifest \u2014 possible corruption or tampering; reinstall via ensure-maestro-runner.sh`;
  }
  return null;
}
var REGEX_METACHARACTERS = /* @__PURE__ */ new Set([
  ".",
  "^",
  "$",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|"
]);
function isRegexShapedSelector(value) {
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "\\")
      return true;
    if (REGEX_METACHARACTERS.has(ch))
      return true;
  }
  return false;
}
var TEXT_SELECTOR_KEYS = /* @__PURE__ */ new Set([
  "tapOn",
  "doubleTapOn",
  "longPressOn",
  "assertVisible",
  "assertNotVisible",
  "copyTextFrom"
]);
var RELATIVE_SELECTOR_KEYS = /* @__PURE__ */ new Set([
  "above",
  "below",
  "leftOf",
  "rightOf",
  "childOf",
  "containsChild",
  "containsDescendants"
]);
function selectorTextValues(value, found) {
  if (typeof value === "string") {
    if (isRegexShapedSelector(value))
      found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value)
      selectorTextValues(entry, found);
    return;
  }
  if (!value || typeof value !== "object")
    return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "text" || RELATIVE_SELECTOR_KEYS.has(key)) {
      selectorTextValues(nested, found);
    }
  }
}
function conditionTextValues(value, found) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "visible" || key === "notVisible")
      selectorTextValues(nested, found);
  }
}
function findRegexTextSelectors(commands) {
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value)
        visit(entry);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        if (TEXT_SELECTOR_KEYS.has(key))
          selectorTextValues(nested, found);
        if (key === "scrollUntilVisible" && nested && typeof nested === "object") {
          selectorTextValues(nested.element, found);
        }
        if (key === "extendedWaitUntil")
          conditionTextValues(nested, found);
        if (key === "when")
          conditionTextValues(nested, found);
        visit(nested);
      }
    }
  };
  visit(commands);
  return found;
}
function pinCorrection(status, platformKey = nodePlatformKey()) {
  const cls = status.pin.status;
  const pinned = status.pin.pinned;
  const installed = status.version ?? "unknown";
  const install2 = `Install attested ${pinned} (floor >= ${pinned}) via ${PINNED_RUNNER_INSTALL_HINT} (session pin-cache; do not use PATH or brew maestro).`;
  if (pinArchiveCoords(platformKey) === null) {
    return `maestro-runner is unsupported on ${platformKey}. Supported platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64. ${install2}`;
  }
  switch (cls) {
    case "not-installed":
      return `Session maestro-runner ${pinned} is not installed. ${install2}`;
    case "drift-older":
      return `Session maestro-runner ${installed} is older than the required pin ${pinned}. ${install2}`;
    case "drift-newer":
      return `Session maestro-runner ${installed} is newer than the attested default ${pinned} and is not executed without attestation. ${install2}`;
    case "checksum-mismatch":
      return `Session maestro-runner binary checksum does not match the ${pinned} pin manifest. ${install2}`;
    case "unknown-version":
      return `Session maestro-runner version could not be read. ${install2}`;
    case "unverified":
      if (status.version && compareVersions(status.version, pinned) > 0) {
        return `UNVERIFIED_NEWER_DRIFT: Session pin-cache contains an unverified newer maestro-runner entry ${installed}; its directory name is not trusted binary evidence and it will not be executed. ${install2}`;
      }
      return `Session maestro-runner ${installed} could not be checksum-verified on ${platformKey}. ${install2}`;
    case "pinned-ok":
      return `Session maestro-runner ${pinned} is selected from the pin-cache.`;
  }
}
function exactPinRefusal(status, platformKey = nodePlatformKey()) {
  if (!status) {
    return `maestro_run refused: session runner ${MAESTRO_RUNNER_PIN.version} could not be detected. ${pinCorrection(buildReplayEngineStatus("not-installed", null, false), platformKey)}`;
  }
  if (status.pin.status === "pinned-ok")
    return null;
  return `maestro_run refused: ${pinCorrection(status, platformKey)}`;
}
async function immediateRunnerPinRefusal(runnerPath, resolveStatus = () => getEngineStatus().catch(() => null)) {
  const status = await resolveStatus();
  const refusal = exactPinRefusal(status);
  if (refusal)
    return `RUNNER_PIN_CHANGED: ${refusal}`;
  const canonicalPath = getMaestroRunnerPath();
  if (!canonicalPath || !status?.selectedPath) {
    return "RUNNER_PIN_CHANGED: verified runner path disappeared before execution.";
  }
  if (resolve(canonicalPath) !== resolve(runnerPath) || resolve(status.selectedPath) !== resolve(runnerPath)) {
    return "RUNNER_PIN_CHANGED: verified runner path changed before execution.";
  }
  return null;
}
function copyPayloadTree(source, destination) {
  const sourceStat = lstatSync2(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`RUNNER_PIN_CHANGED: payload directory changed before execution.`);
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join2(source, entry.name);
    const destinationPath = join2(destination, entry.name);
    const stat = lstatSync2(sourcePath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      copyPayloadTree(sourcePath, destinationPath);
      chmodSync2(destinationPath, stat.mode & 511);
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
      copyFileSync2(sourcePath, destinationPath, constants2.COPYFILE_EXCL | constants2.COPYFILE_FICLONE);
      chmodSync2(destinationPath, stat.mode & 511);
    } else if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(sourcePath), destinationPath);
    } else {
      throw new Error(`RUNNER_PIN_CHANGED: unsupported payload entry ${sourcePath}.`);
    }
  }
}
var RunnerCacheUnavailableError = class extends Error {
  relativePath;
  errno;
  code = "RUNNER_CACHE_UNAVAILABLE";
  constructor(relativePath, errno) {
    super(`RUNNER_CACHE_UNAVAILABLE: ${relativePath}: ${errno}`);
    this.relativePath = relativePath;
    this.errno = errno;
    this.name = "RunnerCacheUnavailableError";
  }
};
function runnerCacheBootstrapFailure(error) {
  return `WDA bootstrap could not provision its authority-bound runner cache: ${error.message}. No foreign cache path was changed; any cache directory created by this spawn was removed. Verify the runner cache parent is writable, then retry the exact replay.`;
}
function cacheErrno(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "UNKNOWN";
}
function expectedRunnerCacheRoot(snapshotRoot) {
  const snapshotName = basename(snapshotRoot);
  const prefix = `.spawn-${MAESTRO_RUNNER_PIN.version}-`;
  if (!snapshotName.startsWith(prefix) || dirname2(snapshotRoot) !== runnerCacheVersionsRoot()) {
    throw new RunnerCacheUnavailableError("cache", "UNBOUND_SNAPSHOT");
  }
  return join2(runnerCacheVersionsRoot(), `.wda-cache-${MAESTRO_RUNNER_PIN.version}-${snapshotName.slice(prefix.length)}`);
}
function assertRunnerSnapshotCacheBinding(snapshotRoot, cacheRoot) {
  try {
    const expectedCacheRoot = expectedRunnerCacheRoot(snapshotRoot);
    if (resolve(cacheRoot) !== resolve(expectedCacheRoot)) {
      throw new RunnerCacheUnavailableError("cache", "FOREIGN_PATH");
    }
    const cacheStat = lstatSync2(cacheRoot);
    if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) {
      throw new RunnerCacheUnavailableError("cache", "INVALID_TARGET");
    }
    if ((cacheStat.mode & 511) !== 448) {
      throw new RunnerCacheUnavailableError("cache", "UNSAFE_MODE");
    }
    const cacheLink = join2(snapshotRoot, "cache");
    if (!lstatSync2(cacheLink).isSymbolicLink()) {
      throw new RunnerCacheUnavailableError("cache", "NOT_LINKED");
    }
    if (realpathSync2(cacheLink) !== realpathSync2(cacheRoot)) {
      throw new RunnerCacheUnavailableError("cache", "FOREIGN_PATH");
    }
  } catch (error) {
    if (error instanceof RunnerCacheUnavailableError)
      throw error;
    throw new RunnerCacheUnavailableError("cache", cacheErrno(error));
  }
}
var testWdaToolchainFingerprint;
function wdaToolchainFingerprint() {
  if (testWdaToolchainFingerprint !== void 0)
    return testWdaToolchainFingerprint;
  try {
    const probe = spawnSync("xcodebuild", ["-version"], { encoding: "utf8", timeout: 15e3 });
    const match = /Xcode\s+(\S+)[\s\S]*Build version\s+(\S+)/.exec(probe.stdout ?? "");
    return probe.status === 0 && match && /^[\w.]+$/.test(match[1]) && /^[\w.]+$/.test(match[2]) ? `xcode-${match[1]}-${match[2]}` : null;
  } catch {
    return null;
  }
}
function persistentWdaStoreBuildsRoot(platformKey = nodePlatformKey(), fingerprint = wdaToolchainFingerprint()) {
  if (!fingerprint || !pinArchiveCoords(platformKey))
    return null;
  const versionsRoot = runnerCacheVersionsRoot();
  const components = [
    join2(versionsRoot, `.wda-store-${MAESTRO_RUNNER_PIN.version}`),
    join2(versionsRoot, `.wda-store-${MAESTRO_RUNNER_PIN.version}`, platformKey),
    join2(versionsRoot, `.wda-store-${MAESTRO_RUNNER_PIN.version}`, platformKey, fingerprint),
    join2(versionsRoot, `.wda-store-${MAESTRO_RUNNER_PIN.version}`, platformKey, fingerprint, "wda-builds")
  ];
  for (const component of components) {
    try {
      const stat = lstatSync2(component);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        return null;
    } catch {
      break;
    }
  }
  return components[3];
}
var testWdaPlutil;
function runWdaPlutil(args) {
  if (process.platform !== "darwin" && !testWdaPlutil)
    return null;
  try {
    const result = testWdaPlutil ? testWdaPlutil(args) : spawnSync("plutil", [...args], { encoding: "utf8", timeout: 15e3 });
    return result.status === 0 ? result.stdout ?? "" : null;
  } catch {
    return null;
  }
}
function readWdaXctestrun(xctestrunPath) {
  const json2 = runWdaPlutil(["-convert", "json", "-o", "-", xctestrunPath]);
  if (json2 === null)
    return null;
  try {
    const plist = JSON.parse(json2);
    return plist !== null && typeof plist === "object" && !Array.isArray(plist) ? plist : null;
  } catch {
    return null;
  }
}
function asWdaPlistRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function forEachWdaTestTarget(plist, visit) {
  const configurations = plist.TestConfigurations;
  if (Array.isArray(configurations)) {
    for (const configuration of configurations) {
      const configurationRecord = asWdaPlistRecord(configuration);
      if (!configurationRecord)
        continue;
      const targets = configurationRecord.TestTargets;
      if (!Array.isArray(targets))
        continue;
      for (const target of targets) {
        const targetRecord = asWdaPlistRecord(target);
        if (targetRecord)
          visit(targetRecord);
      }
    }
    return;
  }
  for (const [key, target] of Object.entries(plist)) {
    const targetRecord = asWdaPlistRecord(target);
    if (key !== "__xctestrun_metadata__" && targetRecord)
      visit(targetRecord);
  }
}
function findWdaTestTarget(plist) {
  const configurations = plist.TestConfigurations;
  if (Array.isArray(configurations)) {
    for (const configuration of configurations) {
      const targets = asWdaPlistRecord(configuration)?.TestTargets;
      if (!Array.isArray(targets))
        continue;
      for (const target of targets) {
        const targetRecord = asWdaPlistRecord(target);
        if (targetRecord && (targetRecord.TestTargetName === "WebDriverAgentRunner" || targetRecord.BlueprintName === "WebDriverAgentRunner")) {
          return targetRecord;
        }
      }
    }
    return null;
  }
  return asWdaPlistRecord(plist.WebDriverAgentRunner);
}
function hasInjectedWdaPort(plist) {
  let found = false;
  forEachWdaTestTarget(plist, (target) => {
    const environment = target.EnvironmentVariables;
    if (environment !== null && typeof environment === "object" && !Array.isArray(environment) && Object.hasOwn(environment, "USE_PORT")) {
      found = true;
    }
  });
  return found;
}
function isWithinWdaKey(keyDir, candidate) {
  const path = relative(keyDir, candidate);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function isContainedWdaProductTree(keyDir, products) {
  const lexicalKey = resolve(keyDir);
  const realKey = realpathSync2(keyDir);
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join2(directory, entry.name);
      const stat = lstatSync2(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target) || !isWithinWdaKey(lexicalKey, resolve(directory, target)) || !isWithinWdaKey(realKey, realpathSync2(path))) {
          return false;
        }
      } else if (stat.isDirectory() && !visit(path)) {
        return false;
      }
    }
    return true;
  };
  return visit(products);
}
function resolveWdaProductReference(reference, products, testHost) {
  if (typeof reference !== "string")
    return null;
  if (reference.startsWith("__TESTROOT__/")) {
    return resolve(products, reference.slice("__TESTROOT__/".length));
  }
  if (testHost && reference.startsWith("__TESTHOST__/")) {
    return resolve(testHost, reference.slice("__TESTHOST__/".length));
  }
  return null;
}
function readCompleteWdaBuildManifest(keyDir) {
  try {
    const derivedData = join2(keyDir, "DerivedData");
    const build = join2(derivedData, "Build");
    const products = join2(build, "Products");
    if (!isRealDirectory(keyDir) || !isRealDirectory(derivedData) || !isRealDirectory(build) || !isRealDirectory(products) || !isContainedWdaProductTree(keyDir, products)) {
      return null;
    }
    const selected = readdirSync(products, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".xctestrun")).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)[0];
    if (!selected?.isFile())
      return null;
    const selectedXctestrun = join2(products, selected.name);
    const plist = readWdaXctestrun(selectedXctestrun);
    const target = plist && findWdaTestTarget(plist);
    if (!target)
      return null;
    const testHost = resolveWdaProductReference(target.TestHostPath, products);
    if (!testHost)
      return null;
    const hostPath = relative(products, testHost).split(sep);
    if (hostPath.length !== 2 || hostPath[1] !== "WebDriverAgentRunner-Runner.app" || !isRealDirectory(join2(products, hostPath[0])) || !isRealDirectory(testHost)) {
      return null;
    }
    const executable = lstatSync2(join2(testHost, "WebDriverAgentRunner-Runner"));
    if (!executable.isFile() || executable.isSymbolicLink() || (executable.mode & 73) === 0) {
      return null;
    }
    const testBundle = resolveWdaProductReference(target.TestBundlePath, products, testHost);
    if (!testBundle || !isWithinWdaKey(resolve(keyDir), testBundle) || !isRealDirectory(testBundle)) {
      return null;
    }
    const bundleExecutable = lstatSync2(join2(testBundle, "WebDriverAgentRunner"));
    if (!bundleExecutable.isFile() || bundleExecutable.isSymbolicLink() || (bundleExecutable.mode & 73) === 0) {
      return null;
    }
    return { products, selectedXctestrun };
  } catch {
    return null;
  }
}
function isCompleteWdaBuild(keyDir) {
  return readCompleteWdaBuildManifest(keyDir) !== null;
}
function removeInjectedWdaPort(xctestrunPath) {
  const plist = readWdaXctestrun(xctestrunPath);
  if (!plist)
    return false;
  forEachWdaTestTarget(plist, (target) => {
    const environment = target.EnvironmentVariables;
    if (environment !== null && typeof environment === "object" && !Array.isArray(environment)) {
      delete environment.USE_PORT;
    }
  });
  writeFileSync(xctestrunPath, JSON.stringify(plist, null, 2));
  return runWdaPlutil(["-convert", "xml1", xctestrunPath]) !== null;
}
function isRealDirectory(path) {
  try {
    const stat = lstatSync2(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
function copyReusableWdaBuild(sourceKey, stagedKey) {
  const manifest = readCompleteWdaBuildManifest(sourceKey);
  if (!manifest)
    return false;
  const sourceProducts = manifest.products;
  const stagedProducts = join2(stagedKey, "DerivedData", "Build", "Products");
  mkdirSync(dirname2(stagedProducts), { recursive: true });
  cpSync(sourceProducts, stagedProducts, {
    recursive: true,
    mode: constants2.COPYFILE_FICLONE,
    verbatimSymlinks: true
  });
  for (const entry of readdirSync(stagedProducts, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".xctestrun") && !removeInjectedWdaPort(join2(stagedProducts, entry.name))) {
      return false;
    }
  }
  return isCompleteWdaBuild(stagedKey);
}
function isReusableStoredWdaBuild(keyDir) {
  try {
    if (!isCompleteWdaBuild(keyDir))
      return false;
    const keyEntries = readdirSync(keyDir, { withFileTypes: true });
    const derivedData = keyEntries[0];
    if (keyEntries.length !== 1 || derivedData?.name !== "DerivedData" || !derivedData.isDirectory()) {
      return false;
    }
    const derivedDataEntries = readdirSync(join2(keyDir, "DerivedData"), { withFileTypes: true });
    const build = derivedDataEntries[0];
    if (derivedDataEntries.length !== 1 || build?.name !== "Build" || !build.isDirectory()) {
      return false;
    }
    const buildEntries = readdirSync(join2(keyDir, "DerivedData", "Build"), {
      withFileTypes: true
    });
    const productsEntry = buildEntries[0];
    if (buildEntries.length !== 1 || productsEntry?.name !== "Products" || !productsEntry.isDirectory()) {
      return false;
    }
    const products = join2(keyDir, "DerivedData", "Build", "Products");
    return readdirSync(products, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".xctestrun")).every((entry) => {
      if (!entry.isFile())
        return false;
      const plist = readWdaXctestrun(join2(products, entry.name));
      return plist !== null && !hasInjectedWdaPort(plist);
    });
  } catch {
    return false;
  }
}
function seedRunnerSnapshotCacheFromStore(cacheRoot, fingerprint) {
  let seeded = 0;
  try {
    const storeBuilds = persistentWdaStoreBuildsRoot(nodePlatformKey(), fingerprint);
    if (!storeBuilds)
      return 0;
    const target = join2(cacheRoot, "wda-builds");
    for (const entry of readdirSync(storeBuilds, { withFileTypes: true })) {
      if (!entry.isDirectory())
        continue;
      const sourceKey = join2(storeBuilds, entry.name);
      if (!isCompleteWdaBuild(sourceKey))
        continue;
      mkdirSync(target, { recursive: true });
      const stagedKey = join2(target, `.seed-${entry.name}`);
      try {
        if (copyReusableWdaBuild(sourceKey, stagedKey)) {
          renameSync(stagedKey, join2(target, entry.name));
          seeded += 1;
        } else {
          rmSync(stagedKey, { recursive: true, force: true });
        }
      } catch {
        try {
          rmSync(stagedKey, { recursive: true, force: true });
        } catch {
        }
      }
    }
  } catch {
  }
  return seeded;
}
function publishRunnerSnapshotCacheToStore(cacheRoot, fingerprint) {
  let published = 0;
  try {
    const spawnBuilds = join2(cacheRoot, "wda-builds");
    const storeBuilds = persistentWdaStoreBuildsRoot(nodePlatformKey(), fingerprint);
    if (!storeBuilds)
      return 0;
    for (const entry of readdirSync(spawnBuilds, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("."))
        continue;
      const sourceKey = join2(spawnBuilds, entry.name);
      if (!isCompleteWdaBuild(sourceKey))
        continue;
      const storeKey = join2(storeBuilds, entry.name);
      if (isReusableStoredWdaBuild(storeKey))
        continue;
      mkdirSync(storeBuilds, { recursive: true, mode: 448 });
      const stage = mkdtempSync(join2(storeBuilds, ".stage-"));
      try {
        const stagedKey = join2(stage, entry.name);
        if (copyReusableWdaBuild(sourceKey, stagedKey)) {
          if (existsSync3(storeKey)) {
            const evicted = join2(stage, "evicted");
            renameSync(storeKey, evicted);
          }
          renameSync(stagedKey, storeKey);
          published += 1;
        }
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
  } catch {
  }
  return published;
}
function provisionRunnerSnapshotCache(snapshotRoot, testHooks = {}, setOwnedCacheRoot = () => {
}) {
  const cacheRoot = expectedRunnerCacheRoot(snapshotRoot);
  let ownsCacheRoot = false;
  try {
    testHooks.beforeCacheProvision?.(cacheRoot);
    mkdirSync(cacheRoot, { mode: 448 });
    ownsCacheRoot = true;
    setOwnedCacheRoot(cacheRoot);
    chmodSync2(cacheRoot, 448);
    testHooks.beforeCacheBinding?.(cacheRoot);
    symlinkSync(cacheRoot, join2(snapshotRoot, "cache"), "dir");
    assertRunnerSnapshotCacheBinding(snapshotRoot, cacheRoot);
    return cacheRoot;
  } catch (error) {
    const failure = error instanceof RunnerCacheUnavailableError ? error : new RunnerCacheUnavailableError("cache", cacheErrno(error));
    if (ownsCacheRoot) {
      try {
        rmSync(cacheRoot, { recursive: true, force: true });
        setOwnedCacheRoot(null);
      } catch (cleanupError) {
        throw new RunnerCacheUnavailableError("cache", `${failure.errno}_CLEANUP_${cacheErrno(cleanupError)}`);
      }
    }
    throw failure;
  }
}
function removeRunnerSnapshotAndCache(snapshotRoot, cacheRoot) {
  let cleanupError;
  try {
    rmSync(snapshotRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (cacheRoot) {
    try {
      rmSync(cacheRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  recordRunnerDiagnostic("cleanup", {
    snapshotRemoved: !existsSync3(snapshotRoot),
    cacheRemoved: cacheRoot === null || !existsSync3(cacheRoot)
  });
  if (cleanupError)
    throw cleanupError;
}
async function withImmediatePinnedRunner(runnerPath, resolveStatus, execute, platform, testHooks = {}) {
  const refusal = await immediateRunnerPinRefusal(runnerPath, resolveStatus);
  if (refusal)
    throw new Error(refusal);
  const expectedSha256 = pinnedSha256(nodePlatformKey());
  if (!expectedSha256) {
    throw new Error("RUNNER_PIN_CHANGED: runner checksum is unavailable for this platform.");
  }
  const wdaStoreFingerprint = platform === "ios" ? wdaToolchainFingerprint() : null;
  const snapshotRoot = mkdtempSync(join2(runnerCacheVersionsRoot(), `.spawn-${MAESTRO_RUNNER_PIN.version}-`));
  let cacheRoot = null;
  recordRunnerDiagnostic("spawn-begin", {
    snapshotId: basename(snapshotRoot),
    runnerPinVersion: MAESTRO_RUNNER_PIN.version
  });
  try {
    copyPayloadTree(pinCacheRoot(), snapshotRoot);
    const snapshotRunner = join2(snapshotRoot, "bin", "maestro-runner");
    const snapshotStat = lstatSync2(snapshotRunner);
    if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink() || !installedPayloadMatchesPin(nodePlatformKey(), snapshotRoot) || createHash2("sha256").update(readFileSync2(snapshotRunner)).digest("hex") !== expectedSha256) {
      recordRunnerDiagnostic("payload-verify", { result: "failed" });
      throw new Error("RUNNER_PIN_CHANGED: payload content changed before execution.");
    }
    recordRunnerDiagnostic("payload-verify", {
      result: "passed",
      runnerPinVersion: MAESTRO_RUNNER_PIN.version,
      provenance: "pin-cache",
      payloadShaPrefix: expectedSha256.slice(0, 12)
    });
    const helper = verifiedNativePublicationHelper();
    const snapshotHelper = join2(snapshotRoot, ".runner-exec");
    copyFileSync2(helper.path, snapshotHelper, constants2.COPYFILE_EXCL | constants2.COPYFILE_FICLONE);
    chmodSync2(snapshotHelper, 320);
    if (createHash2("sha256").update(readFileSync2(snapshotHelper)).digest("hex") !== helper.sha256) {
      throw new Error("RUNNER_PIN_CHANGED: execution binding changed before execution.");
    }
    if (platform === "ios") {
      try {
        cacheRoot = provisionRunnerSnapshotCache(snapshotRoot, testHooks, (ownedCacheRoot) => {
          cacheRoot = ownedCacheRoot;
        });
        recordRunnerDiagnostic("cache-provision", {
          result: "passed",
          variant: "symlink",
          resolvedPath: "../" + basename(cacheRoot)
        });
      } catch (error) {
        const failure = error instanceof RunnerCacheUnavailableError ? error : new RunnerCacheUnavailableError("cache", cacheErrno(error));
        recordRunnerDiagnostic("cache-provision", {
          result: "failed",
          variant: "symlink",
          resolvedPath: "cache",
          errno: failure.errno
        });
        recordRunnerDiagnostic("typed-failure", {
          code: failure.code,
          errno: failure.errno,
          path: failure.relativePath
        });
        throw failure;
      }
    }
    for (const entry of readdirSync(snapshotRoot, { recursive: true, withFileTypes: true })) {
      const entryPath = join2(entry.parentPath, entry.name);
      if (entry.isSymbolicLink())
        continue;
      if (entry.isDirectory())
        chmodSync2(entryPath, 320);
      else if (entry.isFile()) {
        chmodSync2(entryPath, entryPath === snapshotRunner || entryPath === snapshotHelper ? 320 : 256);
      }
    }
    chmodSync2(snapshotRoot, 320);
    if (cacheRoot) {
      assertRunnerSnapshotCacheBinding(snapshotRoot, cacheRoot);
      recordRunnerDiagnostic("cache-seed", {
        seededBuilds: seedRunnerSnapshotCacheFromStore(cacheRoot, wdaStoreFingerprint)
      });
    }
    const openedRunner = lstatSync2(snapshotRunner);
    recordRunnerDiagnostic("runner-exec-begin", { runnerPinVersion: MAESTRO_RUNNER_PIN.version });
    if (platform === "ios") {
      recordRunnerDiagnostic("wda-bootstrap-begin", { cachePath: "cache" });
    }
    return await execute(snapshotHelper, [
      "--exec-file",
      snapshotRunner,
      String(openedRunner.dev),
      String(openedRunner.ino),
      "--"
    ]);
  } finally {
    if (cacheRoot) {
      const currentWdaFingerprint = platform === "ios" ? wdaToolchainFingerprint() : null;
      recordRunnerDiagnostic("cache-publish", {
        publishedBuilds: wdaStoreFingerprint !== null && currentWdaFingerprint === wdaStoreFingerprint ? publishRunnerSnapshotCacheToStore(cacheRoot, wdaStoreFingerprint) : 0
      });
    }
    try {
      chmodSync2(snapshotRoot, 448);
      for (const entry of readdirSync(snapshotRoot, { recursive: true, withFileTypes: true })) {
        const entryPath = join2(entry.parentPath, entry.name);
        if (entry.isSymbolicLink())
          continue;
        if (entry.isDirectory())
          chmodSync2(entryPath, 448);
        else if (entry.isFile())
          chmodSync2(entryPath, 384);
      }
    } catch {
    }
    removeRunnerSnapshotAndCache(snapshotRoot, cacheRoot);
  }
}
function doctorPinnedRunner(status, platformKey = nodePlatformKey()) {
  const platformStatus = pinArchiveCoords(platformKey) === null ? "unsupported" : "supported";
  const ok = status.pin.status === "pinned-ok" && platformStatus === "supported";
  return {
    ok,
    status: status.pin.status,
    platformStatus,
    platformKey,
    pinned: status.pin.pinned,
    installedVersion: status.version,
    selectedPath: status.selectedPath ?? null,
    provenance: status.provenance ?? (status.pin.status === "not-installed" ? "none" : "pin-cache"),
    correction: ok ? null : pinCorrection(status, platformKey),
    iosProofPolicy: {
      exactTestId: "react-tree",
      nativeSurface: "xctest-native",
      nativeBlindRefusal: "NATIVE_SURFACE_BLIND",
      runtimeVersionHeuristicIsProof: false
    }
  };
}
var testStatus;
var testAttestation;
function pinnedSha256(platformKey) {
  return testAttestation?.sha256 ?? MAESTRO_RUNNER_PIN.sha256[platformKey];
}
function pinnedArchiveSha256(platformKey) {
  return testAttestation?.archiveSha256 ?? MAESTRO_RUNNER_PIN.archiveSha256[platformKey];
}
function _resetEngineStatusForTest() {
  testStatus = void 0;
  testAttestation = void 0;
}
function defaultHashFile(bin) {
  return createHash2("sha256").update(readFileSync2(bin)).digest("hex");
}
async function detect(resolvers) {
  const binPath = (resolvers.binPath ?? getMaestroRunnerDetectionPath)();
  const platformKey = resolvers.platformKey ?? nodePlatformKey();
  if (!binPath) {
    return buildReplayEngineStatus("not-installed", null, false, {
      selectedPath: null,
      provenance: "none"
    });
  }
  const cacheVersion = pinCacheVersionForPath(binPath);
  if (cacheVersion && cacheVersion !== MAESTRO_RUNNER_PIN.version) {
    let sha2563 = null;
    try {
      sha2563 = (resolvers.hashFile ?? defaultHashFile)(binPath);
    } catch {
      sha2563 = null;
    }
    const expectedSha2562 = TRUSTED_DRIFT_SHA256[cacheVersion]?.[platformKey];
    if (!sha2563) {
      return buildReplayEngineStatus("unverified", null, false, {
        selectedPath: binPath,
        provenance: "pin-cache"
      });
    }
    const comparison = compareVersions(cacheVersion, MAESTRO_RUNNER_PIN.version);
    if (!expectedSha2562) {
      return buildReplayEngineStatus("unverified", cacheVersion, false, {
        selectedPath: binPath,
        provenance: "pin-cache"
      });
    }
    if (sha2563 !== expectedSha2562) {
      return buildReplayEngineStatus("checksum-mismatch", null, false, {
        selectedPath: binPath,
        provenance: "pin-cache"
      });
    }
    const cls = comparison < 0 ? "drift-older" : comparison > 0 ? "drift-newer" : "unknown-version";
    return buildReplayEngineStatus(cls, cacheVersion, false, {
      selectedPath: binPath,
      provenance: "pin-cache"
    });
  }
  let sha2562 = null;
  try {
    sha2562 = (resolvers.hashFile ?? defaultHashFile)(binPath);
  } catch {
    sha2562 = null;
  }
  const expectedSha256 = MAESTRO_RUNNER_PIN.sha256[platformKey];
  if (!expectedSha256 || !sha2562) {
    return buildReplayEngineStatus("unverified", null, false, {
      selectedPath: binPath,
      provenance: "pin-cache"
    });
  }
  if (sha2562 !== expectedSha256) {
    return buildReplayEngineStatus("checksum-mismatch", null, false, {
      selectedPath: binPath,
      provenance: "pin-cache"
    });
  }
  if (!resolvers.binPath && !resolvers.hashFile && !installedPayloadMatchesPin(platformKey)) {
    return buildReplayEngineStatus("checksum-mismatch", null, false, {
      selectedPath: binPath,
      provenance: "pin-cache"
    });
  }
  return buildReplayEngineStatus("pinned-ok", MAESTRO_RUNNER_PIN.version, false, {
    selectedPath: binPath,
    provenance: "pin-cache"
  });
}
function getEngineStatus(resolvers) {
  if (testStatus)
    return Promise.resolve(testStatus);
  return detect(resolvers ?? {}).catch(() => buildReplayEngineStatus("unknown-version", null, false));
}

// packages/rn-dev-agent-core/dist/domain/action-engine-compat.js
import { existsSync as existsSync10, lstatSync as lstatSync8, readdirSync as readdirSync4, realpathSync as realpathSync5 } from "node:fs";
import { basename as basename5, dirname as dirname10, join as join11, resolve as resolve6 } from "node:path";
init_maestro_validator();

// packages/rn-dev-agent-core/dist/domain/reusable-action.js
function freshRuntimeState(now = () => /* @__PURE__ */ new Date(), mtimeMs = 0) {
  const ts = now().toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    updatedAt: ts,
    lastSeenMtimeMs: mtimeMs,
    runHistory: [],
    repairHistory: [],
    stats: {
      totalRuns: 0,
      successCount: 0,
      failureCount: 0,
      avgDurationMs: 0
    }
  };
}
function parseM7Header(yamlText, fallbackId) {
  const lines = yamlText.split("\n");
  const meta = {};
  let inComment = false;
  for (const line of lines) {
    if (line.startsWith("#")) {
      inComment = true;
      const stripped = line.replace(/^#\s?/, "").trim();
      if (!stripped)
        continue;
      const kv = stripped.match(/^([a-zA-Z][\w-]*)\s*:\s*(.+)$/);
      if (!kv)
        continue;
      const key = kv[1];
      const raw = kv[2].trim();
      if (key === "tags") {
        meta.tags = raw.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean);
      } else if (key === "mutates") {
        meta.mutates = /^true$/i.test(raw);
      } else if (key === "params") {
        meta.params = raw.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean);
      } else if (key === "produces") {
        meta.produces = parseProducesMap(raw);
      } else if (key === "expectedRouteSequence") {
        meta.expectedRouteSequence = raw.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean);
      } else if (key === "id" || key === "intent" || key === "status" || key === "appId" || key === "createdAt" || key === "author" || key === "enginePin") {
        meta[key] = raw;
      }
    } else if (inComment && line.trim() === "") {
      if (Object.keys(meta).length > 0)
        break;
    } else if (inComment) {
      break;
    }
  }
  const id = meta.id ?? fallbackId;
  const intent = meta.intent;
  if (!id || !intent)
    return null;
  const status = meta.status ?? "experimental";
  return {
    id,
    intent,
    tags: meta.tags,
    mutates: meta.mutates,
    status,
    params: meta.params,
    appId: meta.appId,
    createdAt: meta.createdAt,
    author: meta.author,
    produces: meta.produces,
    expectedRouteSequence: meta.expectedRouteSequence,
    enginePin: meta.enginePin
  };
}
function parseProducesMap(raw) {
  const inner = raw.trim().replace(/^\{|\}$/g, "").trim();
  if (!inner)
    return void 0;
  const result = {};
  for (const part of inner.split(",")) {
    const kv = part.match(/^\s*([a-zA-Z_][\w.-]*)\s*:\s*(.+?)\s*$/);
    if (!kv)
      return void 0;
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
  return Object.keys(result).length ? result : void 0;
}

// packages/rn-dev-agent-core/dist/domain/action-store.js
import { existsSync as existsSync9, lstatSync as lstatSync7, readFileSync as readFileSync8, statSync as statSync4, unlinkSync as unlinkSync5 } from "node:fs";
import { basename as basename4, dirname as dirname9, isAbsolute as isAbsolute5, join as join10, relative as relative3, resolve as resolve5, sep as sep6 } from "node:path";

// packages/rn-dev-agent-core/dist/domain/sidecar-io.js
import { existsSync as existsSync4, readFileSync as readFileSync4, writeFileSync as writeFileSync2, mkdirSync as mkdirSync3, statSync } from "node:fs";
import { join as join5, dirname as dirname4 } from "node:path";

// packages/rn-dev-agent-core/dist/session/runtime-paths.js
import { chmodSync as chmodSync3, lstatSync as lstatSync3, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join4, resolve as resolve2 } from "node:path";
function privateDirectory(path) {
  mkdirSync2(path, { recursive: true, mode: 448 });
  const stat = lstatSync3(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("SESSION_RUNTIME_ROOT_UNSAFE: runtime root must be a real directory");
  }
  chmodSync3(path, 448);
  return path;
}
function sessionRuntimeRoot(projectRoot) {
  const configured = process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT;
  return configured ? privateDirectory(resolve2(configured)) : join4(resolve2(projectRoot), ".rn-agent");
}
function sessionStateDirectory(projectRoot) {
  const path = join4(sessionRuntimeRoot(projectRoot), "state");
  return process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT ? privateDirectory(path) : path;
}

// packages/rn-dev-agent-core/dist/domain/sidecar-io.js
function sidecarPathFor(yamlFilePath) {
  const dir = dirname4(yamlFilePath);
  const parent = dirname4(dir);
  const filename = yamlFilePath.replace(/\.ya?ml$/i, ".state.json");
  const base = filename.split(/[\\/]/).pop();
  const stateDirectory = process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT ? sessionStateDirectory(dirname4(parent)) : join5(parent, "state");
  return join5(stateDirectory, base);
}
function loadOrInitSidecar(yamlFilePath, now = () => /* @__PURE__ */ new Date()) {
  const path = sidecarPathFor(yamlFilePath);
  if (existsSync4(path)) {
    try {
      const text = readFileSync4(path, "utf8");
      const parsed = JSON.parse(text);
      if (parsed && parsed.schemaVersion === 1 && typeof parsed.revision === "number" && typeof parsed.updatedAt === "string" && Array.isArray(parsed.runHistory) && Array.isArray(parsed.repairHistory) && typeof parsed.stats === "object") {
        if (typeof parsed.lastSeenMtimeMs !== "number") {
          try {
            parsed.lastSeenMtimeMs = statSync(yamlFilePath).mtimeMs;
          } catch {
            parsed.lastSeenMtimeMs = 0;
          }
        }
        return parsed;
      }
    } catch {
    }
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(yamlFilePath).mtimeMs;
  } catch {
  }
  return freshRuntimeState(now, mtimeMs);
}

// packages/rn-dev-agent-core/dist/domain/atomic-writer.js
init_process_birth();
import { writeFileSync as writeFileSync3, renameSync as renameSync2, statSync as statSync2, mkdirSync as mkdirSync4, existsSync as existsSync5, unlinkSync as unlinkSync3, readdirSync as readdirSync2, openSync as openSync2, closeSync as closeSync2, chmodSync as chmodSync4, fstatSync as fstatSync2, lstatSync as lstatSync4, readFileSync as readFileSync5, linkSync, constants as constants3 } from "node:fs";
import { dirname as dirname5, basename as basename2 } from "node:path";
var FUTURE_MTIME_BUFFER_MS = 1e3;
var ORPHAN_MAX_AGE_MS = 5 * 60 * 1e3;
function generateTmpStamp() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${process.pid}.${Date.now().toString(36)}.${rand}`;
}
var ACTION_WRITE_LOCK_TIMEOUT_MS = 5e3;
var lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
var ACTION_WRITE_PRECONDITION = /* @__PURE__ */ Symbol("action-write-precondition");
var localLockOwner = null;
var heldWriteLocks = /* @__PURE__ */ new Set();
function actionWriteLockPath(yamlPath) {
  return `${yamlPath.replace(/\.yml$/i, ".yaml")}.write.lock`;
}
function currentLockOwner() {
  if (localLockOwner)
    return localLockOwner;
  const observed = probeProcessBirth(process.pid);
  if (observed.status !== "present") {
    throw new Error("Could not establish action writer process identity.");
  }
  localLockOwner = { pid: process.pid, birth: observed.birth.token };
  return localLockOwner;
}
function readLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync5(lockPath, "utf8"));
    if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 || !parsed.birth)
      return null;
    return { pid: Number(parsed.pid), birth: parsed.birth };
  } catch {
    return null;
  }
}
function lockOwnerIsGone(owner) {
  const observed = probeProcessBirth(owner.pid);
  return observed.status === "absent" || observed.status === "present" && observed.birth.token !== owner.birth;
}
function withPairWriteLock(yamlPath, operation, acquisitionPrecondition) {
  if (acquisitionPrecondition && !acquisitionPrecondition())
    throw ACTION_WRITE_PRECONDITION;
  ensureDir(yamlPath);
  const lockPath = actionWriteLockPath(yamlPath);
  if (heldWriteLocks.has(lockPath))
    return operation();
  const ownerPath = `${dirname5(yamlPath)}/.rn-action-write-owner.${generateTmpStamp()}`;
  const owner = currentLockOwner();
  const lockFd = openSync2(ownerPath, "wx", 384);
  writeFileSync3(lockFd, `${JSON.stringify(owner)}
`, "utf8");
  const deadline = Date.now() + ACTION_WRITE_LOCK_TIMEOUT_MS;
  let acquired = false;
  let identity = null;
  try {
    while (!acquired) {
      try {
        if (acquisitionPrecondition && !acquisitionPrecondition()) {
          throw ACTION_WRITE_PRECONDITION;
        }
        linkSync(ownerPath, lockPath);
        acquired = true;
      } catch (err) {
        if (err.code !== "EEXIST")
          throw err;
        let lockStat;
        try {
          lockStat = lstatSync4(lockPath);
        } catch (statError) {
          if (statError.code === "ENOENT")
            continue;
          throw statError;
        }
        if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
          throw new Error(`Refusing invalid action write lock at ${lockPath}.`);
        }
        const existingOwner = readLockOwner(lockPath);
        if (existingOwner && lockOwnerIsGone(existingOwner)) {
          try {
            const current = lstatSync4(lockPath);
            if (current.dev === lockStat.dev && current.ino === lockStat.ino)
              unlinkSync3(lockPath);
          } catch (unlinkError) {
            if (unlinkError.code !== "ENOENT")
              throw unlinkError;
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for action write lock at ${lockPath}.`);
        }
        Atomics.wait(lockWaitBuffer, 0, 0, 10);
      }
    }
    unlinkSync3(ownerPath);
    identity = fstatSync2(lockFd);
    heldWriteLocks.add(lockPath);
    try {
      return operation();
    } finally {
      heldWriteLocks.delete(lockPath);
    }
  } finally {
    if (identity) {
      try {
        const current = lstatSync4(lockPath);
        if (current.dev === identity.dev && current.ino === identity.ino)
          unlinkSync3(lockPath);
      } catch {
      }
    }
    closeSync2(lockFd);
    try {
      unlinkSync3(ownerPath);
    } catch {
    }
  }
}
function pairWriteImpl(yamlPath, yamlContent, sidecarPath, state, publicationPrecondition, yamlPublicationPrecondition, expectedYamlContent, createExclusive = false) {
  if (publicationPrecondition && !publicationPrecondition())
    return null;
  ensureDir(yamlPath);
  ensureDir(sidecarPath);
  let yamlMode;
  if (expectedYamlContent !== void 0) {
    let targetFd;
    try {
      targetFd = openSync2(yamlPath, constants3.O_RDONLY | constants3.O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      const target = fstatSync2(targetFd);
      if (!target.isFile() || readFileSync5(targetFd, "utf8") !== expectedYamlContent)
        return null;
      yamlMode = target.mode & 4095;
    } finally {
      closeSync2(targetFd);
    }
  } else if (createExclusive) {
    yamlMode = 384;
  }
  let sidecarMode = 384;
  try {
    const sidecarFd = openSync2(sidecarPath, constants3.O_RDONLY | constants3.O_NOFOLLOW);
    try {
      const sidecar = fstatSync2(sidecarFd);
      if (!sidecar.isFile())
        return null;
      sidecarMode = sidecar.mode & 4095;
    } finally {
      closeSync2(sidecarFd);
    }
  } catch (error) {
    if (error.code !== "ENOENT")
      return null;
  }
  const stamp = generateTmpStamp();
  const yamlTmp = `${yamlPath}.tmp.${stamp}`;
  const sidecarTmp = `${sidecarPath}.tmp.${stamp}`;
  const projectedMtimeMs = Date.now() + FUTURE_MTIME_BUFFER_MS;
  const projectedState = {
    ...state,
    lastSeenMtimeMs: projectedMtimeMs
  };
  if (publicationPrecondition && !publicationPrecondition())
    return null;
  atomicWriter._writeFileWithMode(sidecarTmp, JSON.stringify(projectedState, null, 2) + "\n", sidecarMode);
  if (publicationPrecondition && !publicationPrecondition()) {
    atomicWriter._unlink(sidecarTmp);
    return null;
  }
  const priorSidecarExisted = publicationPrecondition ? atomicWriter._exists(sidecarPath) : false;
  const priorSidecar = priorSidecarExisted ? readFileSync5(sidecarPath, "utf8") : null;
  function restorePriorSidecar() {
    if (priorSidecar === null) {
      atomicWriter._unlink(sidecarPath);
    } else {
      atomicWriter._writeFileWithMode(sidecarTmp, priorSidecar, sidecarMode);
      atomicWriter._rename(sidecarTmp, sidecarPath);
    }
  }
  function writeYamlTmp() {
    if (yamlMode === void 0)
      atomicWriter._writeFile(yamlTmp, yamlContent);
    else
      atomicWriter._writeFileWithMode(yamlTmp, yamlContent, yamlMode);
  }
  if (createExclusive) {
    try {
      writeYamlTmp();
    } catch (error) {
      try {
        atomicWriter._unlink(sidecarTmp);
      } catch {
      }
      try {
        atomicWriter._unlink(yamlTmp);
      } catch {
      }
      throw error;
    }
    if (publicationPrecondition && !publicationPrecondition()) {
      atomicWriter._unlink(sidecarTmp);
      atomicWriter._unlink(yamlTmp);
      return null;
    }
    const yamlPublished = (!publicationPrecondition || publicationPrecondition()) && atomicWriter._linkIfAbsent(yamlTmp, yamlPath, publicationPrecondition);
    if (!yamlPublished) {
      atomicWriter._unlink(sidecarTmp);
      atomicWriter._unlink(yamlTmp);
      return null;
    }
    atomicWriter._rename(sidecarTmp, sidecarPath);
    atomicWriter._unlink(yamlTmp);
  } else {
    if (publicationPrecondition && !publicationPrecondition()) {
      atomicWriter._unlink(sidecarTmp);
      return null;
    }
    atomicWriter._rename(sidecarTmp, sidecarPath);
    try {
      writeYamlTmp();
    } catch (error) {
      try {
        atomicWriter._unlink(yamlTmp);
      } catch {
      }
      throw error;
    }
    const yamlPublished = expectedYamlContent === void 0 ? !yamlPublicationPrecondition || yamlPublicationPrecondition() : atomicWriter._publishIfUnchanged(yamlTmp, yamlPath, expectedYamlContent, stamp, yamlPublicationPrecondition);
    if (!yamlPublished) {
      if (yamlPublicationPrecondition && !yamlPublicationPrecondition()) {
        try {
          const candidate = lstatSync4(yamlTmp);
          if (!candidate.isFile() || candidate.isSymbolicLink())
            return null;
        } catch {
          return null;
        }
      }
      restorePriorSidecar();
      atomicWriter._unlink(yamlTmp);
      return null;
    }
    if (expectedYamlContent === void 0)
      atomicWriter._rename(yamlTmp, yamlPath);
  }
  const actualMtimeMs = atomicWriter._statMtimeMs(yamlPath);
  const finalMtimeMs = Math.max(actualMtimeMs, projectedMtimeMs);
  const finalState = {
    ...state,
    lastSeenMtimeMs: finalMtimeMs
  };
  atomicWriter._writeFileWithMode(sidecarTmp, JSON.stringify(finalState, null, 2) + "\n", sidecarMode);
  atomicWriter._rename(sidecarTmp, sidecarPath);
  return { yamlPath, sidecarPath, finalMtimeMs, refreshedSidecar: true };
}
function ensureDir(filePath) {
  const dir = dirname5(filePath);
  if (!atomicWriter._exists(dir))
    atomicWriter._mkdir(dir);
}
function cleanupOrphans(yamlPath, sidecarPath) {
  const now = Date.now();
  for (const targetPath of [yamlPath, sidecarPath]) {
    const dir = dirname5(targetPath);
    const prefix = `${basename2(targetPath)}.tmp.`;
    let entries;
    try {
      entries = atomicWriter._readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix))
        continue;
      const orphanPath = `${dir}/${entry}`;
      try {
        const mtimeMs = atomicWriter._statMtimeMs(orphanPath);
        if (now - mtimeMs < ORPHAN_MAX_AGE_MS)
          continue;
        atomicWriter._unlink(orphanPath);
      } catch {
      }
    }
  }
}
var atomicWriter = {
  /** Underlying `fs.writeFileSync(path, content, 'utf8')`. */
  _writeFile(path, content) {
    writeFileSync3(path, content, "utf8");
  },
  _writeFileWithMode(path, content, mode) {
    const fd = openSync2(path, "wx", mode);
    try {
      writeFileSync3(fd, content, "utf8");
    } finally {
      closeSync2(fd);
    }
  },
  /** Underlying `fs.renameSync(from, to)`. */
  _rename(from, to) {
    renameSync2(from, to);
  },
  /** Underlying `fs.statSync(path).mtimeMs`. */
  _statMtimeMs(path) {
    return statSync2(path).mtimeMs;
  },
  /** Underlying `fs.existsSync(path)`. Routed through the seam so test
   *  cases for ensureDir / cleanupOrphans can simulate exotic failures
   *  (PR #109 review). */
  _exists(path) {
    return existsSync5(path);
  },
  /** Underlying `fs.mkdirSync(path, { recursive: true })`. */
  _mkdir(path) {
    mkdirSync4(path, { recursive: true });
  },
  /** Underlying `fs.unlinkSync(path)`. Used by orphan-cleanup. */
  _unlink(path) {
    unlinkSync3(path);
  },
  /** Underlying `fs.readdirSync(path)`. Used by GH #111 prefix-scan cleanup. */
  _readdir(path) {
    return readdirSync2(path);
  },
  _linkIfAbsent(candidatePath, targetPath, publicationPrecondition) {
    if (publicationPrecondition && !publicationPrecondition())
      return false;
    let directoryFd;
    try {
      directoryFd = openSync2(dirname5(targetPath), constants3.O_RDONLY | constants3.O_NOFOLLOW | constants3.O_DIRECTORY);
    } catch {
      return false;
    }
    try {
      const directory = fstatSync2(directoryFd);
      if (!directory.isDirectory() || publicationPrecondition && !publicationPrecondition()) {
        return false;
      }
      return atomicWriter._linkIntoVerifiedDirectory(directoryFd, candidatePath, targetPath);
    } finally {
      closeSync2(directoryFd);
    }
  },
  _linkIntoVerifiedDirectory(directoryFd, candidatePath, targetPath) {
    return linkFileIntoVerifiedDirectory(directoryFd, candidatePath, targetPath);
  },
  _publishIfUnchanged(candidatePath, targetPath, expectedContent, stamp, publicationPrecondition) {
    let targetFd;
    try {
      targetFd = openSync2(targetPath, constants3.O_RDONLY | constants3.O_NOFOLLOW);
    } catch {
      return false;
    }
    try {
      const opened = fstatSync2(targetFd);
      const current = lstatSync4(targetPath);
      if (!opened.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || readFileSync5(targetFd, "utf8") !== expectedContent || publicationPrecondition && !publicationPrecondition()) {
        return false;
      }
      const expectedPath = `${candidatePath}.expected.${stamp}`;
      chmodSync4(candidatePath, opened.mode & 4095);
      atomicWriter._writeFileWithMode(expectedPath, expectedContent, opened.mode & 4095);
      try {
        return publishFileIfUnchangedDarwin(targetFd, targetPath, candidatePath, expectedPath);
      } finally {
        atomicWriter._unlink(expectedPath);
      }
    } catch {
      return false;
    } finally {
      closeSync2(targetFd);
    }
  },
  withLock(yamlPath, operation) {
    return withPairWriteLock(yamlPath, operation);
  },
  writeTextCreateExclusive(yamlPath, content, precondition) {
    try {
      return withPairWriteLock(yamlPath, () => {
        if (!precondition())
          return false;
        const candidatePath = `${dirname5(yamlPath)}/.rn-action-create.${generateTmpStamp()}`;
        atomicWriter._writeFileWithMode(candidatePath, content, 384);
        try {
          return atomicWriter._linkIfAbsent(candidatePath, yamlPath, precondition);
        } finally {
          try {
            atomicWriter._unlink(candidatePath);
          } catch {
          }
        }
      }, precondition);
    } catch (error) {
      if (error === ACTION_WRITE_PRECONDITION)
        return false;
      throw error;
    }
  },
  /**
   * Atomic pair-write. Cleans up any orphaned `.tmp` files before
   * starting. Throws on the first failed step — caller decides whether
   * to surface or recover.
   */
  pairWrite(yamlPath, yamlContent, sidecarPath, state) {
    return withPairWriteLock(yamlPath, () => {
      cleanupOrphans(yamlPath, sidecarPath);
      const result = pairWriteImpl(yamlPath, yamlContent, sidecarPath, state);
      if (!result)
        throw new Error(`Unconditional pair write refused for ${yamlPath}.`);
      return result;
    });
  },
  pairWriteCreateExclusive(yamlPath, yamlContent, sidecarPath, state, precondition) {
    try {
      return withPairWriteLock(yamlPath, () => {
        if (precondition && !precondition())
          return null;
        cleanupOrphans(yamlPath, sidecarPath);
        return pairWriteImpl(yamlPath, yamlContent, sidecarPath, state, precondition, precondition, void 0, true);
      }, precondition);
    } catch (error) {
      if (error === ACTION_WRITE_PRECONDITION)
        return null;
      throw error;
    }
  },
  pairWriteConditional(yamlPath, yamlContent, sidecarPath, state, precondition, yamlPublicationPrecondition, expectedYamlContent) {
    try {
      return withPairWriteLock(yamlPath, () => {
        if (!precondition())
          return null;
        cleanupOrphans(yamlPath, sidecarPath);
        return pairWriteImpl(yamlPath, yamlContent, sidecarPath, state, precondition, yamlPublicationPrecondition, expectedYamlContent);
      }, precondition);
    } catch (error) {
      if (error === ACTION_WRITE_PRECONDITION)
        return null;
      throw error;
    }
  }
};

// packages/rn-dev-agent-core/dist/domain/path-safety.js
import { resolve as resolve3, sep as sep3 } from "node:path";
var PathTraversalError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PathTraversalError";
  }
};
var ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
var ACTION_ID_MAX_LEN = 64;
function isValidActionId(s) {
  if (typeof s !== "string")
    return false;
  if (s.length === 0 || s.length > ACTION_ID_MAX_LEN)
    return false;
  if (s.includes(".."))
    return false;
  return ACTION_ID_RE.test(s);
}
function assertValidActionId(s, context) {
  if (!isValidActionId(s)) {
    const preview = JSON.stringify(s).slice(0, 80);
    throw new PathTraversalError(`Invalid action ID for ${context}: ${preview}`);
  }
}
function assertWithinDir(child, baseDir) {
  const resolvedBase = resolve3(baseDir);
  const resolvedChild = resolve3(baseDir, child);
  if (resolvedChild === resolvedBase)
    return;
  const baseWithSep = resolvedBase.endsWith(sep3) ? resolvedBase : resolvedBase + sep3;
  if (!resolvedChild.startsWith(baseWithSep)) {
    throw new PathTraversalError(`Path "${child}" escapes containment dir "${baseDir}" (resolved to ${resolvedChild})`);
  }
}

// packages/rn-dev-agent-core/dist/domain/unfollowed-file.js
init_process_birth();
import { execFileSync as execFileSync2 } from "node:child_process";
import { lstatSync as lstatSync5 } from "node:fs";
import { isAbsolute as isAbsolute3, join as join6 } from "node:path";
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
function identityFromStat(path, stat) {
  return {
    path,
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
      const path = join6(snapshot.directoryPath, relativePath);
      const stat = lstatSync5(path, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("changed");
      const captured = identityFromStat(path, stat);
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
      const stat = lstatSync5(identity.path, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile() || !sameIdentity(identity, identityFromStat(identity.path, stat))) {
        throw new Error("changed");
      }
    }
  } catch {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
}
function selectExistingUnfollowedSnapshotFiles(snapshot, relativePaths) {
  assertUnfollowedFileSnapshotUnchanged(snapshot);
  const existing = [];
  try {
    for (const relativePath of relativePaths) {
      const path = join6(snapshot.directoryPath, relativePath);
      let stat;
      try {
        stat = lstatSync5(path, { bigint: true });
      } catch (err) {
        if (err.code === "ENOENT")
          continue;
        throw err;
      }
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("changed");
      const captured = identityFromStat(path, stat);
      const selected = snapshot.fileIdentities.get(relativePath);
      if (selected && !sameIdentity(selected, captured))
        throw new Error("changed");
      snapshot.fileIdentities.set(relativePath, selected ?? captured);
      existing.push(relativePath);
    }
  } catch {
    throw new Error(`Refusing replaced learned-action corpus at ${snapshot.directoryPath}.`);
  }
  assertUnfollowedFileSnapshotUnchanged(snapshot);
  return existing;
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
      if (isAbsolute3(relativePath) || relativePath.split("/").some((component) => !component || component === "." || component === "..")) {
        throw new Error(`Invalid relative path: ${relativePath}.`);
      }
      if (expectedIdentities) {
        const selected = expectedIdentities[index];
        if (!selected || selected.path !== join6(directoryPath, relativePath)) {
          throw new Error(`Selected file identity did not match ${relativePath}.`);
        }
        return { relativePath, identity: selected };
      }
      const path = join6(directoryPath, relativePath);
      try {
        const stat = lstatSync5(path, { bigint: true });
        return {
          relativePath,
          identity: stat.isSymbolicLink() || !stat.isFile() ? null : identityFromStat(path, stat)
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

// packages/rn-dev-agent-core/dist/domain/action-store.js
init_maestro_validator();

// packages/rn-dev-agent-core/dist/domain/action-state-store.js
init_logger();
import { basename as basename3, dirname as dirname7, sep as sep4 } from "node:path";

// packages/rn-dev-agent-core/dist/domain/action-db.js
import { createRequire } from "node:module";
import { existsSync as existsSync7, mkdirSync as mkdirSync6, readdirSync as readdirSync3, readFileSync as readFileSync6 } from "node:fs";
import { dirname as dirname6, join as join8 } from "node:path";
var _require = createRequire(import.meta.url);
var SCHEMA = `
PRAGMA busy_timeout=5000;
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS actions_index (
  id             TEXT PRIMARY KEY,
  app_id         TEXT,
  path           TEXT,
  content_hash   TEXT,
  status         TEXT,
  revision       INTEGER,
  created_at     INTEGER,
  updated_at     INTEGER,
  mtime_baseline INTEGER,
  stats_json     TEXT
);

CREATE TABLE IF NOT EXISTS run_records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id       TEXT,
  ts              TEXT,
  trigger         TEXT,
  status          TEXT,
  failure_code    TEXT,
  failure_detail  TEXT,
  transport       TEXT,
  auto_repair_json TEXT,
  duration_ms     INTEGER,
  device_id       TEXT,
  blind_probe_json TEXT,
  trailing_verification_json TEXT
);

CREATE TABLE IF NOT EXISTS repair_records (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id        TEXT,
  ts               TEXT,
  failure_code     TEXT,
  diff_json        TEXT,
  duration_ms      INTEGER,
  agent_reasoning  TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_action    ON run_records(action_id);
CREATE INDEX IF NOT EXISTS idx_repair_action ON repair_records(action_id);
CREATE INDEX IF NOT EXISTS idx_index_app     ON actions_index(app_id);
`;
function loadSqlite() {
  try {
    const mod = _require("node:sqlite");
    return mod.DatabaseSync ?? null;
  } catch {
    return null;
  }
}
function openActionDb(projectRoot, opts = {}) {
  const Ctor = opts.sqliteCtor === void 0 ? loadSqlite() : opts.sqliteCtor;
  if (!Ctor)
    return null;
  try {
    const dbPath = join8(sessionStateDirectory(projectRoot), "actions.db");
    mkdirSync6(dirname6(dbPath), { recursive: true });
    const db = new Ctor(dbPath);
    db.exec(SCHEMA);
    for (const alter of [
      "ALTER TABLE run_records ADD COLUMN device_id TEXT",
      "ALTER TABLE run_records ADD COLUMN blind_probe_json TEXT",
      "ALTER TABLE run_records ADD COLUMN trailing_verification_json TEXT"
    ]) {
      try {
        db.exec(alter);
      } catch (e) {
        if (!String(e).includes("duplicate column name"))
          throw e;
      }
    }
    const handle = {
      db,
      close: () => db.close(),
      insertRunRecord(actionId, record) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const dup = db.prepare("SELECT 1 FROM run_records WHERE action_id = ? AND ts = ? LIMIT 1").get(actionId, record.timestamp);
          if (dup) {
            db.exec("COMMIT");
            return;
          }
          db.prepare(`INSERT INTO run_records
               (action_id, ts, trigger, status, failure_code, failure_detail,
                transport, auto_repair_json, duration_ms, device_id, blind_probe_json,
                trailing_verification_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(actionId, record.timestamp, record.trigger, record.status, record.failureCode ?? null, record.failureDetail ?? null, record.transport ?? null, record.autoRepair ? JSON.stringify(record.autoRepair) : null, record.durationMs, record.deviceId ?? null, record.blindProbe ? JSON.stringify(record.blindProbe) : null, record.trailingVerification ? JSON.stringify(record.trailingVerification) : null);
          db.prepare(`DELETE FROM run_records
             WHERE action_id = ?
               AND id NOT IN (
                 SELECT id FROM run_records
                 WHERE action_id = ?
                 ORDER BY id DESC
                 LIMIT ${RUN_HISTORY_MAX}
               )`).run(actionId, actionId);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      insertRepairRecord(actionId, record) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const dup = db.prepare("SELECT 1 FROM repair_records WHERE action_id = ? AND ts = ? LIMIT 1").get(actionId, record.timestamp);
          if (dup) {
            db.exec("COMMIT");
            return;
          }
          db.prepare(`INSERT INTO repair_records
               (action_id, ts, failure_code, diff_json, duration_ms, agent_reasoning)
             VALUES (?,?,?,?,?,?)`).run(actionId, record.timestamp, record.failureCode, JSON.stringify(record.diff ?? {}), record.durationMs, record.agentReasoning ?? null);
          db.prepare(`DELETE FROM repair_records
             WHERE action_id = ?
               AND id NOT IN (
                 SELECT id FROM repair_records
                 WHERE action_id = ?
                 ORDER BY id DESC
                 LIMIT ${REPAIR_HISTORY_MAX}
               )`).run(actionId, actionId);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      upsertIndex(actionId, fields) {
        db.prepare(`INSERT INTO actions_index
             (id, app_id, path, content_hash, status, revision,
              created_at, updated_at, mtime_baseline, stats_json)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             app_id         = COALESCE(excluded.app_id,         actions_index.app_id),
             path           = COALESCE(excluded.path,           actions_index.path),
             content_hash   = COALESCE(excluded.content_hash,   actions_index.content_hash),
             status         = COALESCE(excluded.status,         actions_index.status),
             revision       = COALESCE(excluded.revision,       actions_index.revision),
             updated_at     = COALESCE(excluded.updated_at,     actions_index.updated_at),
             mtime_baseline = COALESCE(excluded.mtime_baseline, actions_index.mtime_baseline),
             stats_json     = COALESCE(excluded.stats_json,     actions_index.stats_json)`).run(actionId, fields.appId ?? null, fields.path ?? null, fields.contentHash ?? null, fields.status ?? null, fields.revision ?? null, fields.updatedAt ?? null, fields.updatedAt ?? null, fields.mtimeBaseline ?? null, fields.statsJson ?? null);
      },
      loadState(actionId) {
        const idx = db.prepare("SELECT * FROM actions_index WHERE id = ?").get(actionId);
        if (!idx)
          return null;
        const runRows = db.prepare("SELECT * FROM run_records WHERE action_id = ? ORDER BY id ASC").all(actionId);
        const repairRows = db.prepare("SELECT * FROM repair_records WHERE action_id = ? ORDER BY id ASC").all(actionId);
        const runHistory = runRows.map((r) => {
          const rec = {
            timestamp: String(r.ts),
            durationMs: Number(r.duration_ms),
            status: r.status,
            trigger: r.trigger
          };
          if (r.failure_code)
            rec.failureCode = r.failure_code;
          if (r.failure_detail)
            rec.failureDetail = String(r.failure_detail);
          if (r.transport === "cdp-js")
            rec.transport = "cdp-js";
          if (r.auto_repair_json)
            rec.autoRepair = JSON.parse(String(r.auto_repair_json));
          if (r.device_id)
            rec.deviceId = String(r.device_id);
          if (r.blind_probe_json) {
            try {
              rec.blindProbe = JSON.parse(String(r.blind_probe_json));
            } catch {
            }
          }
          if (r.trailing_verification_json) {
            rec.trailingVerification = JSON.parse(String(r.trailing_verification_json));
          }
          return rec;
        });
        const repairHistory = repairRows.map((r) => {
          const rec = {
            timestamp: String(r.ts),
            failureCode: r.failure_code,
            diff: r.diff_json ? JSON.parse(String(r.diff_json)) : {},
            durationMs: Number(r.duration_ms)
          };
          if (r.agent_reasoning)
            rec.agentReasoning = String(r.agent_reasoning);
          return rec;
        });
        const stats = idx.stats_json ? JSON.parse(String(idx.stats_json)) : { totalRuns: 0, successCount: 0, failureCount: 0, avgDurationMs: 0 };
        return {
          schemaVersion: 1,
          revision: Number(idx.revision) || 1,
          updatedAt: String(idx.updated_at ?? (/* @__PURE__ */ new Date(0)).toISOString()),
          lastSeenMtimeMs: Number(idx.mtime_baseline) || 0,
          runHistory,
          repairHistory,
          stats
        };
      },
      recentRepairCount(actionId, sinceIso) {
        const row = db.prepare(`SELECT COUNT(*) as cnt FROM repair_records
           WHERE action_id = ? AND ts >= ?`).get(actionId, sinceIso);
        return row.cnt;
      },
      migrateSidecars() {
        const stateDir = join8(projectRoot, ".rn-agent", "state");
        if (!existsSync7(stateDir))
          return { migrated: 0 };
        let migrated = 0;
        for (const f of readdirSync3(stateDir)) {
          if (!f.endsWith(".state.json"))
            continue;
          const id = f.replace(/\.state\.json$/, "");
          const exists = db.prepare("SELECT 1 FROM actions_index WHERE id = ?").get(id);
          if (exists)
            continue;
          try {
            const parsed = JSON.parse(readFileSync6(join8(stateDir, f), "utf8"));
            if (parsed?.schemaVersion !== 1)
              continue;
            if (!Array.isArray(parsed.runHistory) || !Array.isArray(parsed.repairHistory)) {
              continue;
            }
            for (const r of parsed.runHistory) {
              handle.insertRunRecord(id, r);
            }
            for (const r of parsed.repairHistory) {
              handle.insertRepairRecord(id, r);
            }
            handle.upsertIndex(id, {
              revision: parsed.revision,
              statsJson: JSON.stringify(parsed.stats),
              mtimeBaseline: parsed.lastSeenMtimeMs,
              updatedAt: parsed.updatedAt
            });
            migrated++;
          } catch {
          }
        }
        return { migrated };
      }
    };
    return handle;
  } catch {
    return null;
  }
}
var RUN_HISTORY_MAX = 50;
var REPAIR_HISTORY_MAX = 25;

// packages/rn-dev-agent-core/dist/domain/action-state-store.js
var TAG = "action-state-store";
var sqliteCtorOverride;
var dbCache = /* @__PURE__ */ new Map();
function dbFor(projectRoot) {
  if (dbCache.has(projectRoot))
    return dbCache.get(projectRoot) ?? null;
  const handle = sqliteCtorOverride === void 0 ? openActionDb(projectRoot) : openActionDb(projectRoot, { sqliteCtor: sqliteCtorOverride });
  if (handle) {
    try {
      handle.migrateSidecars();
    } catch (err) {
      logger.debug(TAG, `migrateSidecars failed for ${projectRoot}: ${String(err)}`);
    }
  }
  dbCache.set(projectRoot, handle);
  return handle;
}
var idOf = (yamlFilePath) => basename3(yamlFilePath).replace(/\.ya?ml$/i, "");
function mirrorToDb(opts) {
  const { yamlFilePath, state, newRunRecord, newRepairRecord, meta } = opts;
  try {
    const projectRoot = opts.projectRoot ?? projectRootFromYaml(yamlFilePath);
    if (!projectRoot)
      return;
    const handle = dbFor(projectRoot);
    if (!handle)
      return;
    const actionId = idOf(yamlFilePath);
    handle.upsertIndex(actionId, {
      appId: meta?.appId,
      path: meta?.path,
      contentHash: meta?.contentHash,
      status: meta?.status,
      revision: state.revision,
      statsJson: JSON.stringify(state.stats),
      mtimeBaseline: state.lastSeenMtimeMs,
      updatedAt: state.updatedAt
    });
    if (newRunRecord)
      handle.insertRunRecord(actionId, newRunRecord);
    if (newRepairRecord)
      handle.insertRepairRecord(actionId, newRepairRecord);
  } catch (err) {
    logger.debug(TAG, `DB mirror failed for ${idOf(yamlFilePath)} (authoritative write succeeded): ${String(err)}`);
  }
}
function projectRootFromYaml(yamlFilePath) {
  const actionsDir = dirname7(yamlFilePath);
  const rnAgentDir = dirname7(actionsDir);
  const root2 = dirname7(rnAgentDir);
  if (basename3(actionsDir) !== "actions" || basename3(rnAgentDir) !== ".rn-agent") {
    return null;
  }
  if (!root2 || root2 === sep4)
    return null;
  return root2;
}

// packages/rn-dev-agent-core/dist/session/worktree-inheritance.js
import { spawnSync as spawnSync2 } from "node:child_process";
import { closeSync as closeSync3, constants as constants4, existsSync as existsSync8, fstatSync as fstatSync3, lstatSync as lstatSync6, mkdirSync as mkdirSync7, openSync as openSync3, readFileSync as readFileSync7, readlinkSync as readlinkSync2, realpathSync as realpathSync4, renameSync as renameSync3, statSync as statSync3, symlinkSync as symlinkSync2, unlinkSync as unlinkSync4 } from "node:fs";
import { dirname as dirname8, isAbsolute as isAbsolute4, join as join9, relative as relative2, resolve as resolve4, sep as sep5 } from "node:path";

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
  const result = spawnSync2("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0)
    return { ok: false, stdout: "" };
  return { ok: true, stdout: (result.stdout ?? "").replace(/\n$/, "") };
}
function canonical(path) {
  try {
    return realpathSync4(path);
  } catch {
    return null;
  }
}
function contained(parent, child) {
  if (parent === child)
    return true;
  const rel = relative2(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep5}`) && rel !== ".." && !isAbsolute4(rel);
}
function toPosix(path) {
  return sep5 === "/" ? path : path.split(sep5).join("/");
}
function isRnAppRoot(directory) {
  const manifest = join9(directory, "package.json");
  try {
    const parsed = JSON.parse(readFileSync7(manifest, "utf8"));
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
  const path = header.slice("worktree ".length);
  if (!path)
    return null;
  return {
    path,
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
  const appRootInput = canonical(input.appRoot ? resolve4(input.appRoot) : cwd);
  if (!appRootInput)
    return { refusal: "NOT_RN_APP" };
  if (!contained(worktreeRoot, appRootInput))
    return { refusal: "APP_OUTSIDE_WORKTREE" };
  if (!input.allowNonRnApp && !isRnAppRoot(appRootInput))
    return { refusal: "NOT_RN_APP" };
  const appRelative = worktreeRoot === appRootInput ? "." : toPosix(relative2(worktreeRoot, appRootInput));
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
  const primaryAppRoot = appRelative === "." ? primaryRoot : join9(primaryRoot, appRelative);
  if (!contained(primaryRoot, primaryAppRoot))
    return { ...base, refusal: "PRIMARY_APP_MISSING" };
  let primaryAppReal = null;
  try {
    if (lstatSync6(primaryAppRoot).isDirectory())
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
function classifySource(path, type, boundary) {
  const rel = relative2(boundary, path);
  if (rel === ".." || rel.startsWith(`..${sep5}`) || isAbsolute4(rel)) {
    return { state: "WRONG_TYPE" };
  }
  const paths = [boundary];
  let cursor = boundary;
  for (const component of rel.split(sep5).filter(Boolean)) {
    cursor = join9(cursor, component);
    paths.push(cursor);
  }
  const inspect = () => {
    const evidence = [];
    for (let index = 0; index < paths.length; index += 1) {
      let node;
      try {
        node = lstatSync6(paths[index], { bigint: true });
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
    const resolved = canonical(path);
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
function classifyDestination(path, sourcePath, type) {
  let link;
  try {
    link = lstatSync6(path, { bigint: true });
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
  const resolved = canonical(path);
  if (!resolved)
    return { state: "LINK_STALE", evidence };
  const expected = sourcePath ? canonical(sourcePath) : null;
  if (!expected || resolved !== expected)
    return { state: "LINK_FOREIGN", evidence };
  try {
    const stats = statSync3(resolved);
    const typeOk = type === "directory" ? stats.isDirectory() : stats.isFile();
    return { state: typeOk ? "LINK_VALID" : "LINK_FOREIGN", evidence };
  } catch {
    return { state: "LINK_STALE", evidence };
  }
}
function identityOf(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function lstatIfPresent(path) {
  try {
    return lstatSync6(path, { bigint: true });
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
function directoryIdentityUnchanged(path, expected) {
  const current = lstatIfPresent(path);
  return Boolean(current && !current.isSymbolicLink() && current.isDirectory() && String(current.dev) === expected.dev && String(current.ino) === expected.ino);
}
function openUnfollowedDirectory(path, expected) {
  let fd;
  try {
    fd = openSync3(path, constants4.O_RDONLY | constants4.O_NOFOLLOW | constants4.O_DIRECTORY);
  } catch {
    return false;
  }
  try {
    const opened = fstatSync3(fd, { bigint: true });
    return opened.isDirectory() && String(opened.dev) === expected.dev && String(opened.ino) === expected.ino;
  } finally {
    closeSync3(fd);
  }
}
function resolveReadableActionCorpus(projectRoot, dependencies = {}) {
  const root2 = canonical(projectRoot) ?? resolve4(projectRoot);
  const projectRootEntry = captureDirectoryIdentity(root2);
  if (!projectRootEntry)
    return { status: "absent" };
  const projectRootIdentity = projectRootEntry.identity;
  const rnAgentDir = join9(root2, ".rn-agent");
  const actionsDir = join9(rnAgentDir, "actions");
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
    if (!directoryIdentityUnchanged(root2, projectRootIdentity)) {
      return refuseReplacedActions(actionsDir);
    }
    return {
      status: "owned-directory",
      projectRoot: root2,
      projectRootIdentity,
      rnAgentDir,
      rnAgentIdentity,
      actionsDir,
      identity
    };
  }
  const layout = resolveWorktreeLayout({ cwd: root2, appRoot: root2 });
  if (!("kind" in layout) || layout.kind !== "linked" || layout.refusal || !layout.primaryRoot || !layout.primaryAppRoot) {
    return refuseForeignActions(actionsDir);
  }
  const primaryIdentity = layout[repositoryIdentityEvidence];
  if (!primaryIdentity)
    return refuseReplacedActions(actionsDir);
  const linkedIdentity = captureLinkedRepositoryIdentity(layout);
  if (!linkedIdentity)
    return refuseReplacedActions(actionsDir);
  const primaryRnAgentDir = join9(layout.primaryAppRoot, ".rn-agent");
  const primaryActionsDir = join9(primaryRnAgentDir, "actions");
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
  if (plannedAfter.state !== "LINK_VALID_SAFE" || !plannedAfter.evidence || plannedAfter.evidence.dev !== planned.evidence.dev || plannedAfter.evidence.ino !== planned.evidence.ino || plannedAfter.sourceState !== "AVAILABLE" || !sameSourceEvidence(planned.sourceEvidence, plannedAfter.sourceEvidence) || !sourceLeafMatchesIdentity(planned.sourceEvidence, targetIdentity) || !sourceLeafMatchesIdentity(plannedAfter.sourceEvidence, targetIdentity) || !directoryIdentityUnchanged(root2, projectRootIdentity) || !directoryIdentityUnchanged(rnAgentDir, rnAgentIdentity) || !linkedRepositoryIdentityUnchanged(linkedIdentity) || !repositoryIdentityUnchanged(primaryIdentity)) {
    return refuseReplacedActions(actionsDir);
  }
  return {
    status: "approved-inherited",
    projectRoot: root2,
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
function readableActionsSnapshot(corpus) {
  if (corpus.status === "owned-directory") {
    return { directory: corpus.actionsDir, identity: corpus.identity };
  }
  if (corpus.status === "approved-inherited") {
    return { directory: corpus.targetDir, identity: corpus.targetIdentity };
  }
  return null;
}
var readableActionOperationSequence = 0;
function freezeIdentity(identity) {
  return Object.freeze({ ...identity });
}
function captureDirectoryIdentity(path) {
  const stat = lstatIfPresent(path);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory())
    return null;
  return Object.freeze({ path, identity: freezeIdentity(identityOf(stat)) });
}
function captureFileIdentity(path) {
  const stat = lstatIfPresent(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile())
    return null;
  return Object.freeze({ path, identity: freezeIdentity(identityOf(stat)) });
}
function captureLinkedRepositoryIdentity(layout) {
  const worktreeRoot = captureDirectoryIdentity(layout.worktreeRoot);
  const gitEntry = captureFileIdentity(join9(layout.worktreeRoot, ".git"));
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
function currentIdentityMatches(path, expected, kind) {
  const current = lstatIfPresent(path);
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
  const result = spawnSync2("git", ["check-ignore", "--no-index", "-q", "--", relativePath], {
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
  const destination = join9(anchor.local, resource.path);
  const destinationRel = destinationRelative(layout, resource);
  const source = anchor.source ? join9(anchor.source, resource.path) : void 0;
  const sourceBoundary = layout.primaryRoot;
  const sourceBefore = source && sourceBoundary ? classifySource(source, resource.type, sourceBoundary) : { state: "MISSING" };
  const { state: destinationState, evidence } = classifyDestination(destination, sourceBefore.state === "AVAILABLE" ? source : void 0, resource.type);
  const sourceAfter = source && sourceBoundary ? classifySource(source, resource.type, sourceBoundary) : { state: "MISSING" };
  const sourceStable = sourceBefore.state === sourceAfter.state && sameSourceEvidence(sourceBefore.evidence, sourceAfter.evidence);
  const sourceState2 = sourceStable ? sourceAfter.state : "WRONG_TYPE";
  const sourceEvidence = sourceStable ? sourceAfter.evidence : void 0;
  const linkedParent = resource.parent !== void 0 ? classifyLegacyParent(layout, anchor.local, resource.parent) : null;
  const parentRelative = resource.parent === void 0 ? void 0 : toPosix(layout.appRelative === "." ? resource.parent : `${layout.appRelative}/${resource.parent}`);
  const ignoreSafe = isIgnoreSafe(layout.worktreeRoot, destinationRel) || linkedParent !== null && parentRelative !== void 0 && (isIgnoreSafe(layout.worktreeRoot, parentRelative) || isIgnoreSafe(layout.worktreeRoot, `${parentRelative}/`));
  const base = {
    id: resource.id,
    label: resource.label,
    destination: toPosix(destinationRel),
    sourceState: sourceState2,
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
  const regime = sourceState2 === "AVAILABLE" ? "PRIVATE_SOURCE_AVAILABLE" : "NO_SOURCE";
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
    if (sourceState2 !== "AVAILABLE") {
      return {
        ...base,
        regime,
        state: sourceState2 === "WRONG_TYPE" ? "SOURCE_WRONG_TYPE" : "SOURCE_MISSING",
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
  if (destinationState === "PERMISSION_DENIED" || sourceState2 === "PERMISSION_DENIED") {
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
    if (sourceState2 !== "AVAILABLE") {
      return {
        ...base,
        regime,
        state: sourceState2 === "WRONG_TYPE" ? "SOURCE_WRONG_TYPE" : "SOURCE_MISSING",
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
    if (sourceState2 !== "AVAILABLE") {
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
  if (sourceState2 === "MISSING") {
    return {
      ...base,
      regime,
      state: "SOURCE_MISSING",
      action: "none",
      remediation: "No canonical source in the primary worktree; nothing to inherit."
    };
  }
  if (sourceState2 === "WRONG_TYPE") {
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
  const localParent = join9(localAnchor, parent);
  let stats;
  try {
    stats = lstatSync6(localParent);
  } catch {
    return null;
  }
  if (!stats.isSymbolicLink())
    return null;
  const resolved = canonical(localParent);
  const expected = layout.primaryAppRoot ? canonical(join9(layout.primaryAppRoot, parent)) : null;
  return resolved && expected && resolved === expected ? "expected" : "foreign";
}

// packages/rn-dev-agent-core/dist/domain/action-store.js
function assertOwnedActionCorpus(projectRoot) {
  for (const path of [join10(projectRoot, ".rn-agent"), join10(projectRoot, ".rn-agent", "actions")]) {
    const stat = lstatIfPresent2(path);
    if (stat?.isSymbolicLink()) {
      throw new Error(`Refusing learned-action corpus symlink at ${path}.`);
    }
  }
}
function assertReadableActionLoadContextStable(context) {
  assertReadableActionOperationUnchanged(context.operation);
  assertUnfollowedFileSnapshotUnchanged(context.fileSnapshot);
}
function lstatIfPresent2(path) {
  try {
    return lstatSync7(path);
  } catch (err) {
    if (err.code === "ENOENT")
      return null;
    throw err;
  }
}
function actionFileExists(path) {
  const stat = lstatIfPresent2(path);
  if (!stat)
    return false;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing inherited action symlink at ${path}.`);
  }
  return true;
}
function referencedActionPath(parentFile, reference) {
  if (isAbsolute5(reference) || reference.split(/[\\/]/).includes("..") || !/\.ya?ml$/i.test(reference)) {
    return null;
  }
  const child = join10(dirname9(parentFile), reference);
  if (child === ".." || child.startsWith(`..${sep6}`) || isAbsolute5(child))
    return null;
  return child;
}
function prefetchRunFlowFiles(initial, readFiles, fileSnapshot) {
  const fileContents = new Map(initial);
  let frontier = [...fileContents.entries()];
  for (let depth = 0; depth < 5 && frontier.length > 0; depth += 1) {
    const pending = /* @__PURE__ */ new Set();
    for (const [parentFile, text] of frontier) {
      for (const reference of collectRunFlowFileReferences(text)) {
        const child = referencedActionPath(parentFile, reference);
        if (child && !fileContents.has(child))
          pending.add(child);
      }
    }
    const paths = selectExistingUnfollowedSnapshotFiles(fileSnapshot, [...pending].sort());
    if (paths.length === 0)
      break;
    const contents = readUnfollowedSnapshotFiles(fileSnapshot, paths, readFiles);
    frontier = [];
    paths.forEach((path, index) => {
      const text = contents[index];
      fileContents.set(path, text);
      frontier.push([path, text]);
    });
  }
  return fileContents;
}
function openReadableActionLoadContext(projectRoot, dependencies = {}) {
  const corpus = resolveReadableActionCorpus(projectRoot);
  if (corpus.status === "refused")
    throw new Error(corpus.reason);
  if (corpus.status !== "owned-directory" && corpus.status !== "approved-inherited")
    return null;
  const snapshot = readableActionsSnapshot(corpus);
  const operation = captureReadableActionOperationSnapshot(corpus);
  if (!snapshot || !operation)
    return null;
  const files = listUnfollowedDirectory(snapshot.directory, snapshot.identity);
  const requestedFiles = dependencies.actionId ? [`${dependencies.actionId}.yaml`, `${dependencies.actionId}.yml`] : files;
  const readableFiles = requestedFiles.filter((file) => /\.ya?ml$/.test(file) && files.includes(file));
  const readFiles = dependencies.readFiles ?? readUnfollowedFiles;
  const fileSnapshot = createUnfollowedFileSnapshot(snapshot.directory, snapshot.identity);
  const contents = readUnfollowedSnapshotFiles(fileSnapshot, readableFiles, readFiles);
  const fileContents = /* @__PURE__ */ new Map();
  readableFiles.forEach((file, index) => {
    fileContents.set(file, contents[index]);
  });
  const completeFileContents = dependencies.includeRunFlowFiles ? prefetchRunFlowFiles(fileContents, readFiles, fileSnapshot) : fileContents;
  assertReadableActionOperationUnchanged(operation);
  assertUnfollowedFileSnapshotUnchanged(fileSnapshot);
  return {
    projectRoot,
    corpus,
    snapshot,
    operation,
    files,
    fileContents: completeFileContents,
    fileSnapshot
  };
}
function actionTextFromContext(context, fileName) {
  const text = context.fileContents.get(fileName);
  if (text !== void 0)
    return text;
  throw new Error(`Refusing inherited action symlink at ${context.snapshot.directory}/${fileName}.`);
}
function resolveActionFileNameFromContext(actionId, context) {
  const fileName = `${actionId}.yaml`;
  assertWithinDir(fileName, context.corpus.actionsDir);
  assertWithinDir(fileName, context.snapshot.directory);
  const yamlExists = context.files.includes(fileName);
  const ymlFileName = fileName.replace(/\.yaml$/, ".yml");
  const ymlExists = context.files.includes(ymlFileName);
  if (yamlExists && ymlExists) {
    throw new Error(`Action ${actionId} is ambiguous because both ${actionId}.yaml and ${actionId}.yml exist; keep exactly one file before replay.`);
  }
  if (yamlExists)
    return fileName;
  if (ymlExists)
    return ymlFileName;
  return null;
}
function resolveActionPath(projectRoot, actionId) {
  assertValidActionId(actionId, "resolveActionPath");
  const context = openReadableActionLoadContext(projectRoot, {
    actionId,
    includeRunFlowFiles: false
  });
  if (!context)
    return null;
  const fileName = resolveActionFileNameFromContext(actionId, context);
  if (!fileName)
    return null;
  actionTextFromContext(context, fileName);
  assertReadableActionLoadContextStable(context);
  return join10(context.corpus.actionsDir, fileName);
}
function splitYaml(text) {
  const allLines = text.split("\n");
  let separatorIdx = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].trim() === "---") {
      separatorIdx = i;
      break;
    }
  }
  if (separatorIdx === -1) {
    const headerLines2 = [];
    const bodyLines2 = [];
    let inBody = false;
    let seenAnyContent = false;
    for (const line of allLines) {
      if (!inBody && !seenAnyContent && line.trim() === "") {
        continue;
      }
      if (!inBody && line.startsWith("#")) {
        seenAnyContent = true;
        headerLines2.push(line);
      } else if (!inBody && line.trim() === "" && headerLines2.length > 0) {
        inBody = true;
        bodyLines2.push(line);
      } else {
        seenAnyContent = true;
        inBody = true;
        bodyLines2.push(line);
      }
    }
    return { topSection: "", headerLines: headerLines2, bodyLines: bodyLines2 };
  }
  const topSection = allLines.slice(0, separatorIdx).join("\n");
  const afterSep = allLines.slice(separatorIdx + 1);
  const headerLines = [];
  const bodyLines = [];
  let stillHeader = true;
  for (const line of afterSep) {
    if (stillHeader && (line.startsWith("#") || line.trim() === "")) {
      headerLines.push(line);
    } else {
      stillHeader = false;
      bodyLines.push(line);
    }
  }
  return { topSection, headerLines, bodyLines };
}
function joinYaml(parts) {
  const out = [];
  if (parts.topSection) {
    out.push(parts.topSection);
    out.push("---");
  }
  for (const h of parts.headerLines)
    out.push(h);
  for (const b of parts.bodyLines)
    out.push(b);
  return out.join("\n");
}
function captureActionFromContext(context, actionId) {
  assertValidActionId(actionId, "loadAction");
  assertReadableActionLoadContextStable(context);
  const fileName = resolveActionFileNameFromContext(actionId, context);
  if (!fileName)
    return null;
  const { corpus, snapshot } = context;
  const filePath = join10(corpus.actionsDir, fileName);
  const text = actionTextFromContext(context, fileName);
  const metadata = parseM7Header(text, actionId);
  if (metadata)
    assertActionMetadataIdentity(filePath, metadata);
  let replay;
  try {
    const parsed = parseAndValidateFlow(text, {
      flowDir: snapshot.directory,
      flowRoot: snapshot.directory,
      readFileFn: (path) => {
        const child = relative3(snapshot.directory, path);
        if (child === "" || child === ".." || child.startsWith(`..${sep6}`) || isAbsolute5(child)) {
          throw new Error(`Refusing action flow outside ${snapshot.directory}.`);
        }
        const text2 = context.fileContents.get(child);
        if (text2 === void 0) {
          throw new Error(`Refusing inherited action symlink at ${snapshot.directory}/${child}.`);
        }
        return text2;
      },
      realpathFn: (path) => resolve5(path)
    });
    replay = {
      ok: true,
      yamlText: buildMaestroFlow(parsed.appId ? { appId: parsed.appId } : {}, parsed.commands),
      cdpYaml: buildMaestroFlow({}, parsed.commands),
      commands: parsed.commands,
      appId: parsed.appId
    };
  } catch (err) {
    replay = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  assertReadableActionLoadContextStable(context);
  return { filePath, yamlText: text, metadata, replay };
}
function captureActionFromPath(path) {
  const absolutePath = resolve5(path);
  if (!/\.ya?ml$/i.test(absolutePath))
    return null;
  const actionsDir = dirname9(absolutePath);
  if (basename4(actionsDir) !== "actions" || basename4(dirname9(actionsDir)) !== ".rn-agent") {
    return null;
  }
  const actionId = basename4(absolutePath).replace(/\.ya?ml$/i, "");
  const context = openReadableActionLoadContext(dirname9(dirname9(actionsDir)), {
    actionId,
    includeRunFlowFiles: true
  });
  if (!context)
    return null;
  const action = captureActionFromContext(context, actionId);
  return action && basename4(action.filePath) === basename4(absolutePath) ? action : null;
}
var migrationPathIdentities = /* @__PURE__ */ new WeakMap();
function migrationConflict(filePath) {
  return new Error(`Action changed during migration: ${filePath}. Re-run migration.`);
}
function migrationBaselineMatches(filePath, baseline) {
  const pathIdentity = migrationPathIdentities.get(baseline);
  if (!pathIdentity || !migrationPathIdentityMatches(pathIdentity))
    return false;
  if (!migrationYamlBaselineMatches(filePath, baseline))
    return false;
  const sidecarPath = sidecarPathFor(filePath);
  const sidecarExists = existsSync9(sidecarPath);
  if (sidecarExists !== baseline.sidecarExisted)
    return false;
  return !sidecarExists || runtimeSidecarMatches(sidecarPath, baseline.state);
}
function captureMigrationPathIdentity(filePath) {
  const actionsDir = dirname9(filePath);
  const rnAgentDir = dirname9(actionsDir);
  return [
    { path: rnAgentDir, kind: "directory" },
    { path: actionsDir, kind: "directory" },
    { path: filePath, kind: "file" }
  ].map(({ path, kind }) => {
    const stat = lstatSync7(path);
    const valid = !stat.isSymbolicLink() && (kind === "directory" ? stat.isDirectory() : stat.isFile());
    if (!valid)
      throw new Error(`Refusing changed learned-action path at ${path}.`);
    return { path, kind, dev: stat.dev, ino: stat.ino };
  });
}
function migrationPathIdentityMatches(entries) {
  try {
    return entries.every((entry) => {
      const stat = lstatSync7(entry.path);
      return !stat.isSymbolicLink() && stat.dev === entry.dev && stat.ino === entry.ino && (entry.kind === "directory" ? stat.isDirectory() : stat.isFile());
    });
  } catch {
    return false;
  }
}
function migrationYamlBaselineMatches(filePath, baseline) {
  try {
    return readFileSync8(filePath, "utf8") === baseline.yamlText;
  } catch {
    return false;
  }
}
function migrationYamlPublicationMatches(filePath, baseline) {
  const pathIdentity = migrationPathIdentities.get(baseline);
  return Boolean(pathIdentity && migrationPathIdentityMatches(pathIdentity) && migrationYamlBaselineMatches(filePath, baseline));
}
function loadActionMigrationBaseline(filePath) {
  assertWritableActionFile(filePath);
  const pathIdentity = captureMigrationPathIdentity(filePath);
  const yamlText = readFileSync8(filePath, "utf8");
  const sidecarExisted = existsSync9(sidecarPathFor(filePath));
  const state = loadOrInitSidecar(filePath);
  const baseline = { yamlText, state, sidecarExisted };
  migrationPathIdentities.set(baseline, pathIdentity);
  if (!migrationBaselineMatches(filePath, baseline))
    throw migrationConflict(filePath);
  return baseline;
}
function commitMigratedActionText(filePath, baseline, yamlText) {
  assertWritableActionFile(filePath);
  const sidecarPath = sidecarPathFor(filePath);
  const result = atomicWriter.pairWriteConditional(filePath, yamlText, sidecarPath, baseline.state, () => migrationBaselineMatches(filePath, baseline), () => migrationYamlPublicationMatches(filePath, baseline), baseline.yamlText);
  if (!result)
    throw migrationConflict(filePath);
  const nextState = { ...baseline.state, lastSeenMtimeMs: result.finalMtimeMs };
  const metadata = parseM7Header(yamlText, basename4(filePath).replace(/\.ya?ml$/i, ""));
  mirrorToDb({
    yamlFilePath: filePath,
    state: nextState,
    meta: {
      appId: metadata?.appId,
      status: metadata?.status,
      path: filePath
    }
  });
  return { filePath, sidecarPath };
}
function canonicalRuntimeJson(state) {
  return JSON.stringify(state, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value;
      return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
    }
    return value;
  });
}
function runtimeSidecarMatches(sidecarPath, expected) {
  let onDisk;
  try {
    onDisk = JSON.parse(readFileSync8(sidecarPath, "utf8"));
  } catch {
    return false;
  }
  const normalized = typeof onDisk?.lastSeenMtimeMs === "number" ? onDisk : { ...onDisk, lastSeenMtimeMs: expected.lastSeenMtimeMs };
  return canonicalRuntimeJson(normalized) === canonicalRuntimeJson(expected);
}
function assertWritableActionFile(filePath) {
  const actionsDir = dirname9(filePath);
  const rnAgentDir = dirname9(actionsDir);
  if (basename4(actionsDir) !== "actions" || basename4(rnAgentDir) !== ".rn-agent") {
    throw new Error(`Refusing action mutation outside an owned learned-action corpus: ${filePath}.`);
  }
  assertOwnedActionCorpus(dirname9(rnAgentDir));
  actionFileExists(filePath);
}
function assertActionMetadataIdentity(filePath, metadata) {
  const fileId = basename4(filePath).replace(/\.ya?ml$/i, "");
  if (metadata.id !== fileId) {
    throw new Error(`Action metadata id ${metadata.id} does not match filename identity ${fileId}.`);
  }
}

// packages/rn-dev-agent-core/dist/domain/action-engine-compat.js
function actionEnginePinRefusal(enginePin) {
  if (!enginePin) {
    return `Action is not migrated to ${ACTION_ENGINE_PIN} or newer. Run node <plugin-root>/rn-dev-agent-core/dist/maestro-runner-pin.js migrate-actions --root <app> before replay. Incompatible actions are terminal \u2014 no manual fallback.`;
  }
  const version = parseActionEnginePinVersion(enginePin);
  if (!version) {
    return `Action enginePin ${enginePin} is incompatible with the required floor ${ACTION_ENGINE_PIN}. Migrate or re-record the action. Incompatible actions are terminal \u2014 no manual fallback.`;
  }
  if (!meetsMaestroRunnerFloor(version)) {
    return `Action enginePin ${enginePin} is below the required floor ${ACTION_ENGINE_PIN}. Migrate or re-record the action. Incompatible actions are terminal \u2014 no manual fallback.`;
  }
  return null;
}
function regexSelectorCapabilityRefusal(commands) {
  const selectors = findRegexTextSelectors(commands);
  if (selectors.length === 0)
    return null;
  return `Action uses regex text selectors (${selectors[0]}) which are not a validated maestro-runner ${MAESTRO_RUNNER_PIN.version} capability (GH #750 CONTAINS mistranslation). Rewrite as id or literal text selectors before replay. No UI mutation will run.`;
}
function actionReplayPreflight(opts) {
  return replayCompatibilityPreflight({
    ...opts,
    requireEnginePin: true,
    requireRuntimePin: opts.requireRuntimePin
  });
}
function replayCompatibilityPreflight(opts) {
  if (opts.requireRuntimePin !== false) {
    const pin = exactPinRefusal(opts.engineStatus);
    if (pin)
      return pin;
  }
  if (opts.requireEnginePin) {
    const format = actionEnginePinRefusal(opts.enginePin);
    if (format)
      return format;
  }
  return regexSelectorCapabilityRefusal(opts.commands);
}
function isLearnedActionPath(path) {
  return classifyLearnedActionPath(path) === "action";
}
function classifyLearnedActionPath(path) {
  const lexical = classifyResolvedLearnedActionPath(resolve6(path));
  try {
    const canonical2 = classifyResolvedLearnedActionPath(canonicalizeExistingPath(path));
    if (lexical === canonical2)
      return lexical;
    if (lexical === "outside")
      return canonical2;
    return "descendant";
  } catch {
    return lexical;
  }
}
function classifyResolvedLearnedActionPath(path) {
  let parent = dirname10(path);
  let direct = true;
  while (true) {
    if (basename5(parent) === "actions" && basename5(dirname10(parent)) === ".rn-agent") {
      return direct ? "action" : "descendant";
    }
    const next = dirname10(parent);
    if (next === parent)
      return "outside";
    parent = next;
    direct = false;
  }
}
function canonicalizeExistingPath(path) {
  let cursor = resolve6(path);
  const suffix = [];
  while (!existsSync10(cursor)) {
    const parent = dirname10(cursor);
    if (parent === cursor)
      return cursor;
    suffix.unshift(basename5(cursor));
    cursor = parent;
  }
  return resolve6(realpathSync5(cursor), ...suffix);
}
function standaloneLearnedActionPathRefusal(path) {
  const classification = classifyLearnedActionPath(path);
  if (classification === "outside")
    return null;
  if (classification === "descendant") {
    return `Refusing to execute learned-action descendant ${path} as a standalone flow.`;
  }
  const actionId = basename5(path).replace(/\.ya?ml$/i, "");
  try {
    const action = captureActionFromPath(path);
    if (!action) {
      return `Action ${actionId} does not resolve uniquely to ${path}.`;
    }
    if (!action.replay.ok)
      return action.replay.error;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}
var ENGINE_PIN_LINE = new RegExp(`^#\\s*enginePin\\s*:\\s*.+$`);
function upsertEnginePinHeader(text) {
  const parts = splitYaml(text);
  const existing = parts.headerLines.filter((line) => ENGINE_PIN_LINE.test(line));
  const compatible = existing.map((line) => line.replace(/^#\s*enginePin\s*:\s*/, "").trim()).find((pin) => actionEnginePinRefusal(pin) === null);
  const nextLine = `# enginePin: ${compatible ?? ACTION_ENGINE_PIN}`;
  if (existing.length > 0) {
    const headerLines2 = [];
    let inserted = false;
    for (const line of parts.headerLines) {
      if (!ENGINE_PIN_LINE.test(line)) {
        headerLines2.push(line);
      } else if (!inserted) {
        headerLines2.push(nextLine);
        inserted = true;
      }
    }
    const nextText = joinYaml({ ...parts, headerLines: headerLines2 });
    return { text: nextText, changed: nextText !== text };
  }
  const statusIdx = parts.headerLines.findIndex((line) => /^#\s*status\s*:/.test(line));
  const headerLines = [...parts.headerLines];
  if (statusIdx >= 0)
    headerLines.splice(statusIdx + 1, 0, nextLine);
  else
    headerLines.push(nextLine);
  return { text: joinYaml({ ...parts, headerLines }), changed: true };
}
function isOwnedActionFile(name) {
  return name.endsWith(".yaml") || name.endsWith(".yml");
}
function actionIdFromFile(name) {
  return name.replace(/\.ya?ml$/, "");
}
function inheritedActionsCorpusReason(projectRoot) {
  const rnAgentDir = join11(projectRoot, ".rn-agent");
  const actionsDir = join11(rnAgentDir, "actions");
  try {
    if (lstatSync8(rnAgentDir).isSymbolicLink()) {
      return `Refusing to migrate through inherited .rn-agent symlink at ${rnAgentDir}. Symlink-inherited corpora are never modified.`;
    }
  } catch {
    return null;
  }
  try {
    if (lstatSync8(actionsDir).isSymbolicLink()) {
      return `Refusing to migrate through inherited .rn-agent/actions symlink at ${actionsDir}. Symlink-inherited corpora are never modified.`;
    }
  } catch {
    return null;
  }
  return null;
}
function migrateLearnedActions(projectRoot) {
  const dir = join11(projectRoot, ".rn-agent", "actions");
  const inherited = inheritedActionsCorpusReason(projectRoot);
  if (inherited) {
    return [
      {
        id: "actions",
        path: dir,
        status: "incompatible",
        reason: inherited,
        mutated: false
      }
    ];
  }
  let files = [];
  try {
    files = readdirSync4(dir).filter(isOwnedActionFile);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT")
      return [];
    return [
      {
        id: "actions",
        path: dir,
        status: "unreadable",
        reason: err instanceof Error ? err.message : String(err),
        mutated: false
      }
    ];
  }
  const results = [];
  for (const name of files) {
    const path = join11(dir, name);
    const id = actionIdFromFile(name);
    try {
      const resolvedPath = resolveActionPath(projectRoot, id);
      if (resolvedPath !== path) {
        throw new Error(`Action ${id} does not resolve to ${path}.`);
      }
    } catch (err) {
      results.push({
        id,
        path,
        status: "incompatible",
        reason: err instanceof Error ? err.message : String(err),
        mutated: false
      });
      continue;
    }
    try {
      if (lstatSync8(path).isSymbolicLink()) {
        results.push({
          id,
          path,
          status: "incompatible",
          reason: `Refusing to migrate through inherited action symlink at ${path}. Symlink-inherited corpora are never modified.`,
          mutated: false
        });
        continue;
      }
    } catch (err) {
      results.push({
        id,
        path,
        status: "unreadable",
        reason: err instanceof Error ? err.message : String(err),
        mutated: false
      });
      continue;
    }
    let baseline;
    try {
      baseline = loadActionMigrationBaseline(path);
    } catch (err) {
      results.push({
        id,
        path,
        status: "unreadable",
        reason: err instanceof Error ? err.message : String(err),
        mutated: false
      });
      continue;
    }
    const text = baseline.yamlText;
    const meta = parseM7Header(text, id);
    if (!meta) {
      results.push({
        id,
        path,
        status: "unreadable",
        reason: "missing M7 id/intent",
        mutated: false
      });
      continue;
    }
    if (meta.id !== id) {
      results.push({
        id,
        path,
        status: "incompatible",
        reason: `Action metadata id ${meta.id} does not match filename identity ${id}.`,
        mutated: false
      });
      continue;
    }
    let commands = [];
    try {
      commands = parseAndValidateFlow(text, { flowDir: dirname10(path), flowRoot: dir }).commands;
    } catch (err) {
      const reason = err instanceof MaestroValidationError ? err.message : String(err);
      results.push({ id, path, status: "unreadable", reason, mutated: false });
      continue;
    }
    const selectorRefusal = regexSelectorCapabilityRefusal(commands);
    if (selectorRefusal) {
      results.push({ id, path, status: "incompatible", reason: selectorRefusal, mutated: false });
      continue;
    }
    const updated = upsertEnginePinHeader(text);
    if (updated.changed) {
      try {
        commitMigratedActionText(path, baseline, updated.text);
      } catch (err) {
        results.push({
          id,
          path,
          status: "unreadable",
          reason: err instanceof Error ? err.message : String(err),
          mutated: false
        });
        continue;
      }
    }
    results.push({
      id,
      path,
      status: updated.changed ? "migrated" : "already-pinned",
      mutated: updated.changed
    });
  }
  return results;
}

// packages/rn-dev-agent-core/dist/domain/action-verification-suite.js
import { readFileSync as readFileSync9 } from "node:fs";
import { basename as basename6, dirname as dirname11, resolve as resolve7 } from "node:path";
init_maestro_validator();
function prepareActionVerificationSuite(files, flowDir, engineStatus, context) {
  const prepared = [];
  const errors = [];
  const learnedCorpus = classifyLearnedActionPath(resolve7(flowDir, "__action__.yaml")) === "action";
  let learnedContext = context;
  if (learnedCorpus && !learnedContext) {
    try {
      learnedContext = openReadableActionLoadContext(dirname11(dirname11(resolve7(flowDir))), {
        includeRunFlowFiles: true
      }) ?? void 0;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { prepared, errors: files.map((file) => ({ file, error })) };
    }
  }
  for (const file of files) {
    try {
      const id = basename6(file).replace(/\.ya?ml$/i, "");
      const owned = isLearnedActionPath(file);
      let inlineYaml;
      let commands;
      let meta;
      if (learnedContext) {
        const action = captureActionFromContext(learnedContext, id);
        if (!action || basename6(action.filePath) !== basename6(file)) {
          throw new Error(`Action ${id} did not resolve to ${file}`);
        }
        if (!action.replay.ok)
          throw new Error(action.replay.error);
        inlineYaml = action.replay.yamlText;
        commands = action.replay.commands;
        meta = action.metadata;
      } else {
        const actionPathRefusal = standaloneLearnedActionPathRefusal(file);
        if (actionPathRefusal)
          throw new Error(actionPathRefusal);
        const text = readFileSync9(file, "utf8");
        const parsed = parseAndValidateFlow(text, { flowDir: dirname11(file), flowRoot: flowDir });
        inlineYaml = parsed.raw;
        commands = parsed.commands;
        meta = parseM7Header(text, id);
      }
      const refusal = replayCompatibilityPreflight({
        enginePin: meta?.enginePin,
        commands,
        engineStatus,
        requireEnginePin: meta !== null || owned
      });
      if (refusal)
        throw new Error(refusal);
      prepared.push({
        file,
        inlineYaml,
        ...meta ? { actionMetadata: meta } : {}
      });
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { prepared, errors };
}

// packages/rn-dev-agent-core/dist/domain/bounded-regex.js
import { Worker } from "node:worker_threads";
var workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const matcher = new RegExp(workerData.pattern, 'i');
  parentPort.postMessage({ matches: workerData.candidates.filter((value) => matcher.test(value)) });
} catch (error) {
  parentPort.postMessage({ error: String(error) });
}
`;
function filterWithBoundedRegex(candidates, pattern, timeoutMs = 500) {
  return new Promise((resolve9) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { candidates, pattern }
    });
    let settled = false;
    const finish = (result) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      resolve9(result);
    };
    const timer = setTimeout(() => finish({
      ok: false,
      reason: "timeout",
      message: `pattern evaluation exceeded ${timeoutMs}ms`
    }), timeoutMs);
    worker.on("message", (message) => {
      if (typeof message.error === "string") {
        finish({ ok: false, reason: "invalid", message: message.error });
        return;
      }
      if (!Array.isArray(message.matches) || !message.matches.every((value) => typeof value === "string")) {
        finish({ ok: false, reason: "worker", message: "pattern worker returned invalid output" });
        return;
      }
      finish({ ok: true, matches: message.matches });
    });
    worker.on("error", (error) => {
      finish({ ok: false, reason: "worker", message: String(error) });
    });
    worker.on("exit", (code) => {
      if (!settled) {
        finish({ ok: false, reason: "worker", message: `pattern worker exited with code ${code}` });
      }
    });
  });
}

// packages/rn-dev-agent-core/dist/tools/maestro-run.js
init_utils();
import { execFile as execFileCb10 } from "node:child_process";
import { promisify as promisify13 } from "node:util";
import { existsSync as existsSync17, readFileSync as readFileSync15, writeFileSync as writeFileSync6 } from "node:fs";
import { tmpdir as tmpdir4 } from "node:os";
import { basename as basename8, join as join23, dirname as dirname14 } from "node:path";
init_agent_device_wrapper();
init_project_config();

// packages/rn-dev-agent-core/dist/tools/maestro-dispatch.js
var warnedFallbackReasons = /* @__PURE__ */ new Set();
function shouldWarnFallback(reason) {
  if (warnedFallbackReasons.has(reason))
    return false;
  warnedFallbackReasons.add(reason);
  return true;
}
function flowContainsHideKeyboard(commands) {
  return commands.some((c) => c === "hideKeyboard" || typeof c === "object" && c !== null && "hideKeyboard" in c);
}
function chooseMaestroDispatch(inputs) {
  const runnerPath = (inputs.maestroRunnerPath ?? getMaestroRunnerPath)();
  if (runnerPath) {
    return {
      runner: "maestro-runner",
      binPath: runnerPath,
      buildArgs: (platform, flowFile, appFile, deviceId) => [
        ...appFile ? ["--app-file", appFile] : [],
        "--platform",
        platform,
        ...deviceId ? ["--device", deviceId] : [],
        "test",
        flowFile
      ]
    };
  }
  return {
    error: `Session maestro-runner ${MAESTRO_RUNNER_PIN.version} is not installed in the pin-cache. Install attested ${MAESTRO_RUNNER_PIN.version} (floor >= ${MAESTRO_RUNNER_PIN.version}) via ${PINNED_RUNNER_INSTALL_HINT}. Ambient PATH maestro-runner, ~/.maestro-runner, and brew maestro are never used.`,
    hint: `run ensure-maestro-runner.sh for attested ${MAESTRO_RUNNER_PIN.version} (floor >= ${MAESTRO_RUNNER_PIN.version})`
  };
}

// packages/rn-dev-agent-core/dist/tools/resolve-ios-app-file.js
import { execFileSync as execFileSync3 } from "node:child_process";
import { existsSync as existsSync14, cpSync as cpSync2, rmSync as rmSync2, mkdirSync as mkdirSync10, readdirSync as readdirSync6, statSync as statSync6 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join20, basename as basename7 } from "node:path";
function flowUsesClearState(flowText) {
  return /clearState:\s*true\b/.test(flowText) || /^[ \t]*-[ \t]*clearState[ \t]*$/m.test(flowText);
}
function defaultSnapshotApp(appPath) {
  try {
    const destDir = join20(tmpdir2(), "rn-appfile-snapshots");
    const dest = join20(destDir, basename7(appPath));
    rmSync2(dest, { recursive: true, force: true });
    mkdirSync10(destDir, { recursive: true });
    try {
      execFileSync3("cp", ["-Rc", appPath, dest], { timeout: 3e4, stdio: "ignore" });
    } catch {
      cpSync2(appPath, dest, { recursive: true });
    }
    return dest;
  } catch {
    return null;
  }
}
function resolveIosAppFile(bundleId, deps = {}) {
  const exists = deps.exists ?? existsSync14;
  const getAppContainer = deps.getAppContainer ?? defaultGetAppContainer;
  const snapshotApp = deps.snapshotApp ?? defaultSnapshotApp;
  const fromContainer = getAppContainer(bundleId, deps.deviceId);
  if (fromContainer && exists(fromContainer)) {
    const snapshot = snapshotApp(fromContainer);
    if (snapshot)
      return snapshot;
  }
  const fromDerived = (deps.newestDerivedDataApp ?? (() => null))();
  if (fromDerived && exists(fromDerived))
    return fromDerived;
  return null;
}
function resolveAppFileForClearState(platform, flowText, headerAppId, explicitAppFile, deps) {
  if (explicitAppFile)
    return { ok: true, appFile: explicitAppFile };
  if (platform !== "ios" || !flowUsesClearState(flowText))
    return { ok: true };
  if (!headerAppId) {
    return {
      ok: false,
      error: "Flow uses clearState on iOS but no appId is known to locate the .app. Add `appId:` to the flow header or pass appFile=<path-to-.app>."
    };
  }
  const appFile = resolveIosAppFile(headerAppId, deps) ?? void 0;
  if (!appFile) {
    return {
      ok: false,
      error: `Flow uses clearState on iOS but no built .app could be located for ${headerAppId}. Pass appFile=<path-to-.app> (e.g. <DerivedData>/Build/Products/Debug-iphonesimulator/<App>.app).`
    };
  }
  return { ok: true, appFile };
}
function defaultGetAppContainer(bundleId, deviceId) {
  try {
    const target = deviceId && !/\s/.test(deviceId) ? deviceId : "booted";
    const out = execFileSync3("xcrun", ["simctl", "get_app_container", target, bundleId, "app"], {
      encoding: "utf8",
      timeout: 5e3
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// packages/rn-dev-agent-core/dist/tools/maestro-run.js
init_maestro_validator();

// packages/rn-dev-agent-core/dist/domain/ansi.js
var ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
function stripAnsi(value) {
  return value.replace(ANSI_RE, "");
}

// packages/rn-dev-agent-core/dist/domain/maestro-error-parser.js
var PATTERNS = [
  {
    re: /Element with id (['"])((?:(?!\1).)+)\1 (?:was )?not found/i,
    build: (m, raw) => ({ kind: "SELECTOR_NOT_FOUND", selectorKind: "id", selector: m[2], raw })
  },
  {
    re: /Element with text (['"])((?:(?!\1).)+)\1 (?:was )?not found/i,
    build: (m, raw) => ({ kind: "SELECTOR_NOT_FOUND", selectorKind: "text", selector: m[2], raw })
  },
  // maestro-runner 1.0.x shape — issue #105.
  // "Element not found: id='X'" or "Element not found: text='X'".
  {
    re: /Element not found:\s*id=(['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: "SELECTOR_NOT_FOUND", selectorKind: "id", selector: m[2], raw })
  },
  {
    re: /Element not found:\s*text=(['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: "SELECTOR_NOT_FOUND", selectorKind: "text", selector: m[2], raw })
  },
  {
    re: /Element (['"])((?:(?!\1).)+)\1 (?:was )?not found/i,
    build: (m, raw) => ({
      kind: "SELECTOR_NOT_FOUND",
      selectorKind: "unknown",
      selector: m[2],
      raw
    })
  },
  {
    re: /Timed out waiting for element with id (['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: "TIMEOUT", selector: m[2], raw })
  },
  {
    re: /Timed out waiting for element (['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: "TIMEOUT", selector: m[2], raw })
  },
  {
    re: /Assertion failed: (['"])((?:(?!\1).)+)\1 (?:is )?not visible/i,
    build: (m, raw) => ({ kind: "ASSERTION_FAILED", selector: m[2], raw })
  },
  {
    re: /Element (['"])((?:(?!\1).)+)\1 is not visible/i,
    build: (m, raw) => ({ kind: "ASSERTION_FAILED", selector: m[2], raw })
  }
];
var RUNNER_STEP_RE = /^[ \t]+([✓✗])\s+(\S.*\S|\S)\s*\(([\d.]+)s\)\s*$/;
var REASON_LINE_RE = /^[ \t]+╰─\s+/;
var ID_WAIT_STEP_RE = /^extendedWaitUntil:\s+visible\s+id=(['"])((?:(?!\1).)+)\1$/i;
var SELECTOR_LESS_ID_WAIT_SUMMARY_RE = /^extendedWaitUntil$/;
var ID_WAIT_REASON_RE = /^[ \t]+╰─\s+Element (['"])#((?:(?!\1).)+)\1 not visible within\b/i;
function blockReasons(lines, stepIndex) {
  const reasons = [];
  for (let i = stepIndex + 1; i < lines.length; i++) {
    if (RUNNER_STEP_RE.test(lines[i]))
      break;
    if (REASON_LINE_RE.test(lines[i]))
      reasons.push(lines[i]);
  }
  return reasons;
}
function idWaitStepAmongDuplicates(lines, terminalIndex, terminalReason) {
  for (let i = terminalIndex - 1; i >= 0; i--) {
    const step = RUNNER_STEP_RE.exec(lines[i]);
    if (!step)
      continue;
    if (step[1] !== "\u2717")
      return null;
    if (!blockReasons(lines, i).includes(terminalReason))
      return null;
    const stepMatch = ID_WAIT_STEP_RE.exec(step[2]);
    if (stepMatch)
      return stepMatch;
  }
  return null;
}
function parseTerminalIdWait(output, suppliedFailedStep) {
  const lines = stripAnsi(output).split("\n");
  let terminalStep;
  for (let index = 0; index < lines.length; index++) {
    const match = RUNNER_STEP_RE.exec(lines[index]);
    if (match)
      terminalStep = { index, status: match[1], name: match[2] };
  }
  if (terminalStep?.status === "\u2713")
    return null;
  if (suppliedFailedStep && terminalStep && terminalStep.name !== suppliedFailedStep)
    return null;
  const failedStep = suppliedFailedStep ?? terminalStep?.name;
  if (!failedStep || terminalStep && terminalStep.status !== "\u2717")
    return null;
  const reasonLine = lines.slice(terminalStep ? terminalStep.index + 1 : 0).filter((line) => REASON_LINE_RE.test(line)).at(-1);
  if (!reasonLine)
    return null;
  const reasonMatch = ID_WAIT_REASON_RE.exec(reasonLine);
  if (!reasonMatch)
    return null;
  const stepMatch = ID_WAIT_STEP_RE.exec(failedStep) ?? (terminalStep && SELECTOR_LESS_ID_WAIT_SUMMARY_RE.test(failedStep) ? idWaitStepAmongDuplicates(lines, terminalStep.index, reasonLine) : null);
  if (!stepMatch || reasonMatch[2] !== stepMatch[2])
    return null;
  return {
    kind: "SELECTOR_NOT_FOUND",
    selectorKind: "id",
    selector: stepMatch[2],
    raw: output
  };
}
function parseMaestroFailure(output, terminal) {
  const raw = typeof output === "string" ? output : "";
  if (terminal?.exitClass === "timed-out") {
    return { kind: "TIMEOUT", selector: terminal.failureSelector ?? null, raw };
  }
  if (terminal?.failureKind === "SELECTOR_NOT_FOUND") {
    return {
      kind: "SELECTOR_NOT_FOUND",
      selectorKind: "unknown",
      selector: terminal.failureSelector ?? "",
      raw
    };
  }
  if (terminal?.failureKind === "TIMEOUT") {
    return { kind: "TIMEOUT", selector: terminal.failureSelector ?? null, raw };
  }
  if (terminal?.failureKind === "ASSERTION_FAILED") {
    return { kind: "ASSERTION_FAILED", selector: terminal.failureSelector ?? null, raw };
  }
  if (terminal?.exitClass === "before-first-step" && terminal.bootstrapEvidence) {
    return {
      kind: "WDA_BOOTSTRAP_FAILED",
      detail: terminal.bootstrapEvidence.slice(0, 500),
      raw
    };
  }
  if (!raw) {
    return { kind: "UNKNOWN", raw: "" };
  }
  output = raw;
  const terminalIdWait = parseTerminalIdWait(output, terminal?.failedStep);
  if (terminalIdWait)
    return terminalIdWait;
  const lines = output.split("\n");
  for (const { re, build } of PATTERNS) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line)
        continue;
      const m = line.match(re);
      if (m)
        return build(m, output);
    }
  }
  for (const { re, build } of PATTERNS) {
    const m = output.match(re);
    if (m)
      return build(m, output);
  }
  return { kind: "UNKNOWN", raw: output };
}
function outputIndicatesFlowFailure(output) {
  return /^\s*(?:\[FAILED\]|(?:Test|Flow) FAILED\b|FAILED\s*$)/m.test(output);
}

// packages/rn-dev-agent-core/dist/domain/maestro-step-parser.js
var STEP_RE = /^[ \t]+([✓✗])\s+(\S.*\S|\S)\s*\(([\d.]+)s\)\s*$/;
var MAX_FIELD = 200;
function cap(s) {
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + "\u2026" : s;
}
var MAX_STEPS = 1e3;
function combineRunnerOutput(stdout, stderr) {
  return (stdout + "\n" + stderr).replace(/^[\r\n]+/, "").trimEnd();
}
function parseExactSteps(output) {
  if (!output || typeof output !== "string")
    return [];
  const steps = [];
  let index = 0;
  for (const raw of stripAnsi(output).split("\n")) {
    const m = STEP_RE.exec(raw);
    if (!m)
      continue;
    const name = m[2];
    const verb = cap(name.split(/\s+/)[0].replace(/:$/, ""));
    if (verb === "rn-maestro-run")
      continue;
    const seconds = Number(m[3]);
    if (!Number.isFinite(seconds))
      continue;
    steps.push({
      index: index++,
      name,
      verb,
      status: m[1] === "\u2713" ? "pass" : "fail",
      durationMs: Math.round(seconds * 1e3)
    });
  }
  return steps.length > MAX_STEPS ? steps.slice(-MAX_STEPS) : steps;
}
function boundStep(step) {
  return { ...step, name: cap(step.name) };
}
function parseSteps(output) {
  return parseExactSteps(output).map(boundStep);
}
function findFailedStep(steps) {
  const last = steps.length ? steps[steps.length - 1] : null;
  return last && last.status === "fail" ? last : null;
}
function lastObservedStep(steps) {
  return steps.length ? steps[steps.length - 1] : null;
}
function summarizeExactReason(output, failedStep) {
  const f = parseMaestroFailure(output, failedStep ? { failedStep } : void 0);
  if (f.kind === "UNKNOWN" || f.kind === "WDA_BOOTSTRAP_FAILED")
    return null;
  const selector = "selector" in f ? f.selector ?? null : null;
  return { kind: f.kind, selector };
}
function buildStepSummary(output, opts) {
  const exactSteps = parseExactSteps(output);
  const exactFailedStep = opts.failed ? findFailedStep(exactSteps) : null;
  const exactReason = opts.failed ? summarizeExactReason(output, exactFailedStep?.name) : null;
  const steps = exactSteps.map(boundStep);
  return {
    steps,
    failedStep: exactFailedStep ? boundStep(exactFailedStep) : null,
    reason: exactReason ? {
      ...exactReason,
      selector: exactReason.selector === null ? null : cap(exactReason.selector)
    } : null,
    lastStep: lastObservedStep(steps)
  };
}
var WDA_TOKEN_RE = /\bWDA\b|WebDriverAgent/i;
var WDA_FAILURE_RE = /\b(?:fail(?:ed|ure|s)?|error|unable|cannot|can't|could not|timed out|timeout|refused|denied|crash(?:ed)?|panic|aborted)\b/i;
function isWdaFailureLine(line) {
  return WDA_TOKEN_RE.test(line) && WDA_FAILURE_RE.test(line);
}
function buildTerminalEvidence(output, opts = {}) {
  const exactSteps = parseExactSteps(output);
  const failedStep = findFailedStep(exactSteps);
  const reason = summarizeExactReason(output, failedStep?.name);
  const bootstrapEvidence = stripAnsi(output).split("\n").filter((line) => isWdaFailureLine(line)).join("\n").slice(0, 500);
  const exitClass = opts.timedOut ? "timed-out" : opts.spawnError ? "spawn-error" : exactSteps.length === 0 ? "before-first-step" : "step-failure";
  return {
    completedSteps: exactSteps.filter((step) => step.status === "pass").length,
    ...failedStep ? { failedStep: failedStep.name } : {},
    exitClass,
    ...bootstrapEvidence ? { bootstrapEvidence } : {},
    ...reason ? {
      failureKind: reason.kind,
      failureSelector: reason.selector
    } : {}
  };
}
function classifyExecError(err) {
  const e = err;
  const killed = e?.killed === true;
  const overflow = e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  return { timedOut: (killed || e?.code === "ETIMEDOUT") && !overflow, outputTruncated: overflow };
}
function formatFailureHeadline(summary, cls, fallbackMsg) {
  if (cls.timedOut) {
    return `Maestro flow timed out${summary.lastStep ? ` after step "${summary.lastStep.name}"` : ""}`;
  }
  if (cls.outputTruncated) {
    return "Maestro flow output exceeded the 10MB buffer";
  }
  if (summary.failedStep) {
    const r = summary.reason;
    const reasonStr = r ? ` (${r.kind}${r.selector ? `: ${r.selector}` : ""})` : "";
    return `Maestro flow failed at step "${summary.failedStep.name}"${reasonStr}`;
  }
  if (summary.reason) {
    const r = summary.reason;
    return `Maestro flow failed (${r.kind}${r.selector ? `: ${r.selector}` : ""})`;
  }
  return `Maestro flow failed: ${fallbackMsg.slice(0, 500)}`;
}

// packages/rn-dev-agent-core/dist/domain/tap-latency.js
var DEFAULT_FLOOR_MS = 1500;
function parseTapLatencies(output) {
  return parseSteps(output).filter((s) => s.verb === "tapOn" && s.status === "pass").map((s) => s.durationMs);
}
function median(samples) {
  if (samples.length === 0)
    return null;
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}
function resolveFloorMs(envVal) {
  if (envVal === void 0)
    return DEFAULT_FLOOR_MS;
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FLOOR_MS;
}
function runtimeDegradationFromMetadata(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return null;
  const metadata = candidate;
  if (typeof metadata.medianTapMs !== "number" || !Number.isFinite(metadata.medianTapMs) || typeof metadata.floorMs !== "number" || !Number.isFinite(metadata.floorMs) || typeof metadata.sampleCount !== "number" || !Number.isSafeInteger(metadata.sampleCount) || metadata.medianTapMs < 0 || metadata.floorMs <= 0 || metadata.sampleCount < 0) {
    return null;
  }
  return {
    degraded: true,
    medianMs: metadata.medianTapMs,
    floorMs: metadata.floorMs,
    sampleCount: metadata.sampleCount
  };
}
function runtimeDegradationMetadata(degradation) {
  return {
    medianTapMs: degradation.medianMs,
    floorMs: degradation.floorMs,
    sampleCount: degradation.sampleCount
  };
}
var MIN_SAMPLES_FOR_DEGRADED = 2;
function classifyRuntimeDegradation(output, floorMs) {
  const samples = parseTapLatencies(output);
  const medianMs = median(samples);
  return {
    degraded: medianMs != null && samples.length >= MIN_SAMPLES_FOR_DEGRADED && medianMs >= floorMs,
    medianMs,
    floorMs,
    sampleCount: samples.length
  };
}
function formatRuntimeDegradedHint(d) {
  return `RUNTIME_DEGRADED: median tapOn latency ${d.medianMs}ms (>= ${d.floorMs}ms) \u2014 the simulator test runtime is likely wedged; reboot it (xcrun simctl shutdown <udid> && xcrun simctl boot <udid>), relaunch the app, and retry.`;
}
function formatRuntimeSlowCaveat(d) {
  return `RUNTIME_DEGRADED: median tapOn latency ${d.medianMs}ms (>= ${d.floorMs}ms) \u2014 runtime is slow; the goal state may have appeared after the wait \u2014 verify before rebooting.`;
}
function augmentFailureWithDegradation(output, floorMs, baseMessage, baseMeta, opts = {}) {
  const d = classifyRuntimeDegradation(output, floorMs);
  if (!d.degraded)
    return { message: baseMessage, meta: baseMeta };
  const hint = opts.trailingVerification?.trailingVerificationOnly ? formatRuntimeSlowCaveat(d) : formatRuntimeDegradedHint(d);
  return {
    message: `${baseMessage} \u2014 ${hint}`,
    meta: {
      ...baseMeta,
      runtimeDegraded: runtimeDegradationMetadata(d)
    }
  };
}

// packages/rn-dev-agent-core/dist/tools/maestro-run.js
init_rn_fast_runner_client();
init_release_android_slot();
init_recovery();

// packages/rn-dev-agent-core/dist/domain/maestro-device-authority.js
function canonicalDeviceId(value) {
  return value.toLowerCase();
}
function sameDevice(left, right) {
  return canonicalDeviceId(left) === canonicalDeviceId(right);
}
function uniqueValues(values) {
  const seen = /* @__PURE__ */ new Map();
  for (const value of values) {
    if (!value)
      continue;
    const key = canonicalDeviceId(value);
    if (!seen.has(key))
      seen.set(key, value);
  }
  return [...seen.values()];
}
function uniqueMatches(output, pattern) {
  return uniqueValues([...output.matchAll(pattern)].map((match) => match[1]));
}
function verifyMaestroDeviceAuthority(input) {
  const requestedDeviceId = input.requestedDeviceId?.trim() || null;
  const reportedIds = uniqueValues([
    ...input.directReportDeviceIds ?? [],
    ...uniqueMatches(input.output, /\b(?:Found|Using specified|Connecting to) (?:(?:iOS|Android) )?device:\s*([A-Za-z0-9._:-]+)/gi)
  ]);
  const wdaDeviceIds = uniqueMatches(input.output, /\b(?:Building|Starting|Launching|Installing)\s+(?:WDA|WebDriverAgent(?:Runner)?)\s+(?:for|on|to)\s+device\s+([A-Za-z0-9._:-]+)/gi);
  const observedDeviceIds = uniqueValues([...reportedIds, ...wdaDeviceIds]);
  const reportedDeviceId = reportedIds.length === 1 ? reportedIds[0] : null;
  if (!requestedDeviceId) {
    return {
      requestedDeviceId,
      reportedDeviceId,
      observedDeviceIds,
      wdaDeviceIds,
      verified: false,
      source: reportedIds.length > 0 ? "maestro-runner-log" : "none",
      reason: "no-exact-device-request"
    };
  }
  if (input.runner !== "maestro-runner") {
    return {
      requestedDeviceId,
      reportedDeviceId,
      observedDeviceIds,
      wdaDeviceIds,
      verified: false,
      source: "maestro-cli-explicit-udid",
      reason: "direct-runner-evidence-unavailable"
    };
  }
  const base = {
    requestedDeviceId,
    reportedDeviceId,
    observedDeviceIds,
    wdaDeviceIds,
    source: "maestro-runner-log"
  };
  if (reportedIds.length === 0) {
    return { ...base, verified: false, reason: "reported-device-missing" };
  }
  if (reportedIds.length !== 1) {
    return { ...base, verified: false, reason: "reported-device-ambiguous" };
  }
  if (!reportedDeviceId || !sameDevice(reportedDeviceId, requestedDeviceId)) {
    const weakOnly = input.directReportIdentityStrength === "weak" && (input.directReportDeviceIds ?? []).some((id) => sameDevice(id, reportedDeviceId ?? ""));
    return {
      ...base,
      verified: false,
      reason: weakOnly ? "reported-device-weak-identity" : "reported-device-mismatch"
    };
  }
  if (observedDeviceIds.some((id) => !sameDevice(id, requestedDeviceId))) {
    return { ...base, verified: false, reason: "wda-device-mismatch" };
  }
  return {
    ...base,
    verified: true,
    ...input.platform === "ios" && input.requireWdaProvenance === true ? {
      wdaProvenance: wdaDeviceIds.length > 0 ? "exact-match" : "unavailable"
    } : {},
    reason: input.platform === "ios" && wdaDeviceIds.length > 0 ? "exact-runner-and-wda-match" : "exact-runner-match"
  };
}
function shouldRejectMaestroDeviceAuthority(authority) {
  return authority.requestedDeviceId !== null && authority.source === "maestro-runner-log" && !authority.verified;
}
function maestroAuthorityRefusal(authority, underlyingError) {
  if (!shouldRejectMaestroDeviceAuthority(authority))
    return null;
  const headline = `Maestro device authority refused: requested ${authority.requestedDeviceId}, direct runner/WDA evidence was ${authority.reportedDeviceId ?? "missing"} (${authority.reason}).`;
  return underlyingError ? `${headline} Underlying failure: ${underlyingError}` : headline;
}

// packages/rn-dev-agent-core/dist/domain/maestro-runner-report.js
import { existsSync as existsSync16, readFileSync as readFileSync14, readdirSync as readdirSync7, realpathSync as realpathSync7, rmSync as rmSync3 } from "node:fs";
import { createHash as createHash4 } from "node:crypto";
import { tmpdir as tmpdir3 } from "node:os";
import { isAbsolute as isAbsolute6, join as join22, sep as sep7 } from "node:path";
var DIRECT_DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
var DEVICE_ID_KEYS = ["udid", "deviceId", "serial"];
var WEAK_DEVICE_ID_KEYS = ["id"];
var CONTAINER_DEVICE_ID_KEYS = ["udid", "deviceId", "deviceSerial"];
function idsFrom(value, keys) {
  if (!value || typeof value !== "object")
    return [];
  const record = value;
  for (const key of keys) {
    const id = record[key];
    if (typeof id === "string")
      return [id];
  }
  return [];
}
function deviceIdsFrom(value) {
  return idsFrom(value, DEVICE_ID_KEYS);
}
function weakDeviceIdsFrom(value) {
  if (typeof value === "string")
    return [value];
  return idsFrom(value, WEAK_DEVICE_ID_KEYS);
}
function containerDeviceIdsFrom(value) {
  return idsFrom(value, CONTAINER_DEVICE_ID_KEYS);
}
function reportDeviceIds(reportDir) {
  const reportPath = join22(reportDir, "report.json");
  if (!existsSync16(reportPath))
    return { ids: [], strength: "none" };
  try {
    const report = JSON.parse(readFileSync14(reportPath, "utf8"));
    const flows = Array.isArray(report.flows) ? report.flows : [];
    const devices = [report.device, ...flows.map((flow) => flow?.device)];
    const strong = [
      ...devices.flatMap((device) => deviceIdsFrom(device)),
      ...[report, ...flows].flatMap((container) => containerDeviceIdsFrom(container))
    ];
    const usingStrong = strong.length > 0;
    const ids = usingStrong ? strong : devices.flatMap((device) => weakDeviceIdsFrom(device));
    const accepted = [
      ...new Set(ids.map((id) => id.trim()).filter((id) => DIRECT_DEVICE_ID_RE.test(id)))
    ];
    return {
      ids: accepted,
      strength: accepted.length === 0 ? "none" : usingStrong ? "strong" : "weak"
    };
  } catch {
    return { ids: [], strength: "none" };
  }
}
function createRunnerReportDir(runner, prefix) {
  if (runner !== "maestro-runner")
    return null;
  return join22(tmpdir3(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}
function runnerReportArgs(reportDir) {
  return reportDir ? ["--output", reportDir, "--flatten"] : [];
}
function collectDirectRunnerEvidence(reportDir, output) {
  if (!reportDir)
    return { output, reportDeviceIds: [], reportDeviceIdStrength: "none" };
  const report = reportDeviceIds(reportDir);
  const evidence = {
    output,
    reportDeviceIds: report.ids,
    reportDeviceIdStrength: report.strength
  };
  const logPath = join22(reportDir, "maestro-runner.log");
  if (!existsSync16(logPath))
    return evidence;
  try {
    evidence.output = `${output}
${readFileSync14(logPath, "utf8")}`;
  } catch {
  }
  return evidence;
}
var OBSERVATION_STATUSES = /* @__PURE__ */ new Set([
  "passed",
  "failed",
  "skipped",
  "running",
  "pending"
]);
function observationStatus(value) {
  return typeof value === "string" && OBSERVATION_STATUSES.has(value) ? value : "unknown";
}
var FINGERPRINT_INCONCLUSIVE = "unreadable";
function contentHash(path) {
  try {
    return createHash4("sha256").update(readFileSync14(path)).digest("hex");
  } catch (error) {
    return error?.code === "ENOENT" ? null : FINGERPRINT_INCONCLUSIVE;
  }
}
function runnerReportFingerprint(reportDir) {
  const fingerprint = {};
  if (!reportDir)
    return fingerprint;
  const reportHash = contentHash(join22(reportDir, "report.json"));
  if (reportHash)
    fingerprint["report.json"] = reportHash;
  let flowEntries = [];
  try {
    flowEntries = readdirSync7(join22(reportDir, "flows"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fingerprint["flows"] = FINGERPRINT_INCONCLUSIVE;
    }
    return fingerprint;
  }
  for (const entry of flowEntries.sort()) {
    const flowHash = contentHash(join22(reportDir, "flows", entry));
    if (flowHash)
      fingerprint[`flows/${entry}`] = flowHash;
  }
  return fingerprint;
}
function readStructuredFlowArtifact(reportDir, previous) {
  if (!reportDir)
    return null;
  const reportPath = join22(reportDir, "report.json");
  if (!existsSync16(reportPath))
    return null;
  const unfinalized = {
    finalized: false,
    flowStatus: "unknown",
    commands: []
  };
  try {
    const reportText = readFileSync14(reportPath, "utf8");
    if (previous) {
      if (Object.values(previous).includes(FINGERPRINT_INCONCLUSIVE))
        return unfinalized;
      const reportHash = createHash4("sha256").update(reportText).digest("hex");
      if (previous["report.json"] === reportHash)
        return null;
    }
    const report = JSON.parse(reportText);
    const flows = Array.isArray(report.flows) ? report.flows : [];
    if (flows.length !== 1)
      return unfinalized;
    const flow = flows[0];
    const flowStatus = flow.status === "passed" || flow.status === "failed" ? flow.status : "unknown";
    if (flowStatus === "unknown")
      return unfinalized;
    if (typeof flow.dataFile !== "string" || flow.dataFile.length === 0)
      return unfinalized;
    const normalizedDataFile = flow.dataFile;
    if (isAbsolute6(normalizedDataFile) || !/^flows\/[^/\\]+$/.test(normalizedDataFile)) {
      return unfinalized;
    }
    const realDataFile = realpathSync7(join22(reportDir, normalizedDataFile));
    if (!realDataFile.startsWith(realpathSync7(reportDir) + sep7))
      return unfinalized;
    const dataText = readFileSync14(realDataFile, "utf8");
    if (previous) {
      const dataHash = createHash4("sha256").update(dataText).digest("hex");
      if (previous[normalizedDataFile] === dataHash)
        return unfinalized;
    }
    const data = JSON.parse(dataText);
    if (!Array.isArray(data.commands))
      return unfinalized;
    let malformedRow = false;
    const seenIndices = /* @__PURE__ */ new Set();
    const commands = data.commands.map((entry) => {
      const record = entry ?? {};
      const error = record.error ?? void 0;
      const status = observationStatus(record.status);
      const producerIndex = typeof record.index === "number" && Number.isInteger(record.index) && record.index >= 0 ? record.index : null;
      if (producerIndex === null || seenIndices.has(producerIndex)) {
        malformedRow = true;
      } else {
        seenIndices.add(producerIndex);
      }
      if (typeof record.type !== "string" || record.type.length === 0 || status === "unknown") {
        malformedRow = true;
      }
      return {
        index: producerIndex ?? -1,
        type: typeof record.type === "string" ? record.type : "unknown",
        status,
        ...error && typeof error.message === "string" ? { error: error.message.slice(0, 500) } : {}
      };
    });
    if (malformedRow)
      return { finalized: false, flowStatus, commands: [] };
    const counts = flow.commands ?? {};
    const statusCount = (status) => commands.filter((command) => command.status === status).length;
    const countExact = (key, actual) => counts[key] === actual;
    const anyFailedRow = commands.some((command) => command.status === "failed");
    const contiguousIndices = Array.from({ length: commands.length }, (_, i) => i).every((i) => seenIndices.has(i));
    const finalized = (report.status === "passed" || report.status === "failed") && report.status === flowStatus && flowStatus === "failed" === anyFailedRow && !malformedRow && contiguousIndices && commands.length > 0 && countExact("total", commands.length) && countExact("passed", statusCount("passed")) && countExact("failed", statusCount("failed")) && countExact("skipped", statusCount("skipped")) && countExact("running", 0) && countExact("pending", 0) && commands.every((command) => command.status !== "running" && command.status !== "pending");
    return { finalized, flowStatus, commands };
  } catch {
    return unfinalized;
  }
}
function disposeRunnerReportDir(reportDir) {
  if (!reportDir)
    return;
  try {
    rmSync3(reportDir, { recursive: true, force: true });
  } catch {
  }
}

// packages/rn-dev-agent-core/dist/domain/maestro-run-ledger.js
import { createHash as createHash5 } from "node:crypto";
var MAESTRO_RUN_LEDGER_SCHEMA_VERSION = 1;
var MAESTRO_RUNNER_FLOW_JSON_ADAPTER = "maestro-runner/flow-json@1";
var MUTATION_VERBS = /* @__PURE__ */ new Set([
  "launchApp",
  "stopApp",
  "killApp",
  "clearState",
  "tap",
  "tapOn",
  "doubleTapOn",
  "longPressOn",
  "back",
  "inputText",
  "eraseText",
  "pasteText",
  "hideKeyboard",
  "pressKey",
  "scroll",
  "scrollUntilVisible",
  "swipe",
  "swipeUp",
  "swipeDown",
  "swipeLeft",
  "swipeRight",
  "openLink",
  "setLocation",
  "addMedia",
  "setAirplaneMode",
  "travel"
]);
var VERIFICATION_VERBS = /* @__PURE__ */ new Set([
  "assertVisible",
  "assertNotVisible",
  "extendedWaitUntil",
  "waitForAnimationToEnd"
]);
var CONTROL_VERBS = /* @__PURE__ */ new Set(["takeScreenshot", "copyTextFrom"]);
function commandEffect(verb) {
  if (MUTATION_VERBS.has(verb))
    return "mutation";
  if (VERIFICATION_VERBS.has(verb))
    return "verification";
  if (CONTROL_VERBS.has(verb))
    return "control";
  return "unknown";
}
function authoredVerb(command) {
  if (typeof command === "string")
    return command;
  if (!command || typeof command !== "object" || Array.isArray(command))
    return null;
  const keys = Object.keys(command);
  return keys.length === 1 ? keys[0] : null;
}
function sha256(text) {
  return createHash5("sha256").update(text, "utf8").digest("hex");
}
function digestCommand(command) {
  try {
    return sha256(JSON.stringify(command) ?? String(command));
  } catch {
    return sha256(String(command));
  }
}
function terminationClean(t) {
  return Number.isFinite(t.exitCode) && !t.timedOut && t.signal === null && !t.outputTruncated && !t.bootstrapFailure && !t.transportFailure && t.artifactFinalized;
}
function buildMaestroRunLedger(input) {
  const stages = [];
  const observations = [];
  const operations = input.commands.map((command, index) => {
    const verb = authoredVerb(command);
    return {
      operationId: `op-${index}`,
      sourceIndex: index,
      sourceRange: [index, index],
      sourceDigest: digestCommand(command),
      verb: verb ?? `unknown-${index}`,
      effect: verb === null ? "unknown" : commandEffect(verb),
      stageId: "unassigned",
      outcome: { state: "unknown" }
    };
  });
  const claimedIndices = /* @__PURE__ */ new Set();
  let claimConflict = false;
  input.stages.forEach((capture, stageIndex) => {
    const stageId = `stage-${stageIndex}`;
    const artifact = capture.invocation?.artifact ?? null;
    const artifactFinalized = artifact?.finalized === true;
    const termination = capture.invocation ? { ...capture.invocation.termination, artifactFinalized } : null;
    const stageOperations = [];
    for (const sourceIndex of capture.sourceIndices) {
      const row = operations[sourceIndex];
      if (!row || claimedIndices.has(sourceIndex)) {
        claimConflict = true;
        continue;
      }
      claimedIndices.add(sourceIndex);
      row.stageId = stageId;
      stageOperations.push(row);
    }
    if (!capture.invocation) {
      for (const operation of stageOperations)
        operation.outcome = { state: "notRun" };
    } else if (artifact && artifactFinalized && artifactSelfConsistent(artifact) && terminationClean(termination)) {
      assignOutcomesFromArtifact(stageOperations, artifact, stageId, observations);
    } else if (artifact) {
      recordObservations(stageOperations, artifact, stageId, observations);
    }
    stages.push({
      stageId,
      authorityKind: capture.requiresOrigin ? "origin" : "lifecycle",
      sourceOperationIds: stageOperations.map((operation) => operation.operationId),
      invoked: capture.invocation !== null,
      invocationTermination: termination
    });
  });
  const coversAllCommands = !claimConflict && claimedIndices.size === input.commands.length;
  const complete = coversAllCommands && input.stages.length > 0 && input.stages.every((capture) => capture.invocation !== null && capture.invocation.artifact?.finalized === true && capture.invocation.artifact.flowStatus !== "unknown") && stages.every((stage) => stage.invocationTermination !== null && terminationClean(stage.invocationTermination));
  return {
    schemaVersion: MAESTRO_RUN_LEDGER_SCHEMA_VERSION,
    producerAdapterVersion: MAESTRO_RUNNER_FLOW_JSON_ADAPTER,
    attempt: {
      ...input.attempt,
      sourceDigest: sha256(input.sourceText),
      complete
    },
    stages,
    observations,
    operations
  };
}
function recordObservations(stageOperations, artifact, stageId, observations) {
  const byVerb = /* @__PURE__ */ new Map();
  for (const operation of stageOperations) {
    const ids = byVerb.get(operation.verb) ?? [];
    ids.push(operation.operationId);
    byVerb.set(operation.verb, ids);
  }
  const observedCounts = /* @__PURE__ */ new Map();
  for (const command of artifact.commands) {
    observedCounts.set(command.type, (observedCounts.get(command.type) ?? 0) + 1);
  }
  for (const command of artifact.commands) {
    const candidates = byVerb.get(command.type) ?? [];
    const oneToOne = candidates.length === 1 && observedCounts.get(command.type) === 1;
    observations.push({
      producer: "maestro-commands-json",
      producerSequence: command.index,
      stageId,
      command: command.type,
      status: command.status,
      ...command.error ? { error: command.error.slice(0, 500) } : {},
      mapping: oneToOne ? { kind: "exact", operationId: candidates[0] } : candidates.length >= 1 ? { kind: "ambiguous", candidates: [...candidates] } : { kind: "none" }
    });
  }
}
function artifactSelfConsistent(artifact) {
  const anyFailed = artifact.commands.some((command) => command.status === "failed");
  if (artifact.flowStatus === "passed")
    return !anyFailed;
  if (artifact.flowStatus === "failed")
    return anyFailed;
  return false;
}
function assignOutcomesFromArtifact(stageOperations, artifact, stageId, observations) {
  recordObservations(stageOperations, artifact, stageId, observations);
  const authoredByVerb = /* @__PURE__ */ new Map();
  for (const operation of stageOperations) {
    const rows = authoredByVerb.get(operation.verb) ?? [];
    rows.push(operation);
    authoredByVerb.set(operation.verb, rows);
  }
  const observedByVerb = /* @__PURE__ */ new Map();
  for (const command of artifact.commands) {
    const evidence = observedByVerb.get(command.type) ?? { operationIds: [], statuses: [] };
    evidence.statuses.push(command.status);
    observedByVerb.set(command.type, evidence);
  }
  for (const [verb, rows] of authoredByVerb) {
    const statuses = observedByVerb.get(verb)?.statuses ?? [];
    if (statuses.length !== rows.length)
      continue;
    const uniform = statuses.every((status2) => status2 === statuses[0]);
    if (!uniform)
      continue;
    const status = statuses[0];
    for (const row of rows) {
      row.outcome = status === "passed" ? { state: "proven", status: "passed" } : status === "failed" ? { state: "proven", status: "failed" } : status === "skipped" ? { state: "notRun" } : { state: "unknown" };
    }
  }
  const deviated = artifact.commands.some((command) => {
    const rows = authoredByVerb.get(command.type);
    return !rows || (observedByVerb.get(command.type)?.statuses.length ?? 0) > rows.length;
  });
  if (deviated) {
    for (const row of stageOperations) {
      if (row.outcome.state === "proven" && row.outcome.status === "passed") {
        row.outcome = { state: "unknown" };
      }
    }
  }
}
function classifyTrailingVerification(ledger) {
  if (ledger.schemaVersion !== MAESTRO_RUN_LEDGER_SCHEMA_VERSION)
    return null;
  if (ledger.producerAdapterVersion !== MAESTRO_RUNNER_FLOW_JSON_ADAPTER)
    return null;
  if (ledger.stages.length === 0)
    return null;
  const stageById = new Map(ledger.stages.map((stage) => [stage.stageId, stage]));
  if (ledger.operations.some((operation) => {
    const stage = stageById.get(operation.stageId);
    return !stage || !stage.invoked;
  })) {
    return null;
  }
  if (!ledger.attempt.complete)
    return null;
  if (ledger.operations.length === 0)
    return null;
  if (ledger.attempt.kind === "repaired" && !ledger.attempt.parentAttemptId)
    return null;
  if (ledger.attempt.kind === "initial" && ledger.attempt.parentAttemptId)
    return null;
  const stageTerminations = [];
  for (const stage of ledger.stages) {
    if (!stage.invoked || stage.invocationTermination === null)
      return null;
    if (!terminationClean(stage.invocationTermination))
      return null;
    stageTerminations.push(stage.invocationTermination);
  }
  if (ledger.operations.some((operation) => operation.effect === "unknown"))
    return null;
  if (ledger.operations.some((operation) => operation.outcome.state === "unknown"))
    return null;
  let failureSeen = false;
  for (const stage of ledger.stages) {
    const stageObservations = ledger.observations.filter((observation) => observation.stageId === stage.stageId && observation.producer === "maestro-commands-json");
    const passedMutation = (observation) => observation.status === "passed" && commandEffect(observation.command) === "mutation";
    if (failureSeen && stageObservations.some(passedMutation))
      return null;
    const failedSequences = [];
    for (const observation of stageObservations) {
      if (observation.status !== "failed")
        continue;
      if (typeof observation.producerSequence !== "number")
        return null;
      failedSequences.push(observation.producerSequence);
    }
    if (failedSequences.length > 0) {
      const firstFailure = Math.min(...failedSequences);
      const mutationAfterFailure = stageObservations.some((observation) => passedMutation(observation) && (typeof observation.producerSequence !== "number" || observation.producerSequence > firstFailure));
      if (mutationAfterFailure)
        return null;
      failureSeen = true;
    }
  }
  let provenMutations = 0;
  let failedVerifications = 0;
  let notRunOperations = 0;
  for (const operation of ledger.operations) {
    const { effect, outcome } = operation;
    if (outcome.state === "notRun") {
      if (effect === "mutation")
        return null;
      notRunOperations++;
      continue;
    }
    if (outcome.state === "proven" && outcome.status === "failed") {
      if (effect !== "verification")
        return null;
      failedVerifications++;
      continue;
    }
    if (effect === "mutation")
      provenMutations++;
  }
  if (failedVerifications === 0)
    return null;
  if (provenMutations === 0)
    return null;
  return {
    trailingVerificationOnly: true,
    mutationEvidence: "proven",
    provenMutations,
    failedVerifications,
    notRunOperations,
    stageTerminations,
    attempt: {
      attemptId: ledger.attempt.attemptId,
      ordinal: ledger.attempt.ordinal,
      kind: ledger.attempt.kind,
      ...ledger.attempt.parentAttemptId ? { parentAttemptId: ledger.attempt.parentAttemptId } : {}
    }
  };
}

// packages/rn-dev-agent-core/dist/tools/maestro-run.js
init_authority_gate();
init_registry();
import { randomUUID } from "node:crypto";

// packages/rn-dev-agent-core/dist/domain/cdp-flow-replay.js
var UnsupportedStepError = class extends Error {
  stepKey;
  constructor(stepKey) {
    super(`cdp-flow-replay: unsupported Maestro step "${stepKey}" (no CDP/JS mapping)`);
    this.stepKey = stepKey;
    this.name = "UnsupportedStepError";
  }
};
var ReplayDispatchError = class extends Error {
  code;
  meta;
  constructor(code, message, meta) {
    super(message);
    this.code = code;
    this.meta = meta;
    this.name = "ReplayDispatchError";
  }
};
var interp = (s, p) => s.replace(/\$\{([A-Z_][A-Z0-9_]*)(?:\s*\?\?\s*(['"])(.*?)\2)?\}/g, (match, key, _quote, fallback) => p[key] ?? fallback ?? match);
var asString = (x) => typeof x === "string" ? x : null;
var isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
var DEFAULT_VISIBILITY_TIMEOUT_MS = 17e3;
var VISIBILITY_POLL_INTERVAL_MS = 200;
var MAX_TIMER_DELAY_MS = 2147483647;
async function readVisibilityBeforeDeadline(dispatch, id, deadline, signal) {
  const remainingMs = deadline - Date.now();
  if (remainingMs < 0)
    return null;
  return new Promise((resolve9, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer !== void 0)
        clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (value) => {
      if (settled)
        return;
      settled = true;
      cleanup();
      resolve9(Date.now() <= deadline ? value : null);
    };
    const fail = (error) => {
      if (settled)
        return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      fail(new ReplayDispatchError("RUNNER_TIMEOUT", "React-tree replay exceeded its execution deadline"));
    };
    const armDeadline = () => {
      const nextRemainingMs = deadline - Date.now();
      timer = setTimeout(() => Date.now() >= deadline ? finish(null) : armDeadline(), Math.min(Math.max(0, nextRemainingMs), MAX_TIMER_DELAY_MS));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    armDeadline();
    Promise.resolve().then(() => dispatch.visibility(id)).then(finish, (error) => {
      if (settled)
        return;
      if (Date.now() > deadline) {
        finish(null);
        return;
      }
      fail(error);
    });
  });
}
function refuseUnsupportedKeys(value, allowed, label) {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) {
    throw new UnsupportedStepError(`${label} (unsupported keys: ${unsupported.sort().join(", ")})`);
  }
}
function normalizeSteps(body, params) {
  const out = [];
  for (const raw of body) {
    if (raw === "waitForAnimationToEnd") {
      out.push({ t: "wait", timeoutMs: 400 });
      continue;
    }
    if (!isObj(raw))
      throw new UnsupportedStepError(typeof raw === "string" ? raw : `non-object(${typeof raw})`);
    const keys = Object.keys(raw);
    if (keys.length !== 1)
      throw new UnsupportedStepError(keys.join("+") || "empty");
    const key = keys[0];
    const v = raw[key];
    switch (key) {
      case "launchApp": {
        if (isObj(v)) {
          const unsupported = Object.keys(v).filter((k) => k !== "stopApp");
          if (unsupported.length > 0)
            throw new UnsupportedStepError(`launchApp (unsupported keys: ${unsupported.sort().join(", ")})`);
          if ("stopApp" in v && typeof v.stopApp !== "boolean")
            throw new UnsupportedStepError("launchApp (stopApp must be a boolean)");
        }
        out.push({ t: "launch", stopApp: isObj(v) && v.stopApp === true });
        break;
      }
      case "tapOn": {
        if (isObj(v))
          refuseUnsupportedKeys(v, ["id"], "tapOn");
        const id = isObj(v) ? asString(v.id) : null;
        if (!id)
          throw new UnsupportedStepError("tapOn (missing string id)");
        out.push({ t: "tap", id: interp(id, params) });
        break;
      }
      case "inputText": {
        const text = asString(v);
        if (text === null)
          throw new UnsupportedStepError("inputText (value not a string)");
        out.push({ t: "type", text: interp(text, params) });
        break;
      }
      case "assertVisible": {
        if (isObj(v))
          refuseUnsupportedKeys(v, ["id"], "assertVisible");
        const id = isObj(v) ? asString(v.id) : null;
        if (!id)
          throw new UnsupportedStepError("assertVisible (missing string id)");
        out.push({
          t: "waitVisible",
          id: interp(id, params),
          timeoutMs: DEFAULT_VISIBILITY_TIMEOUT_MS,
          evidenceType: "assert"
        });
        break;
      }
      case "extendedWaitUntil": {
        if (isObj(v))
          refuseUnsupportedKeys(v, ["visible", "timeout"], "extendedWaitUntil");
        if (isObj(v) && isObj(v.visible)) {
          refuseUnsupportedKeys(v.visible, ["id"], "extendedWaitUntil.visible");
        }
        const id = isObj(v) && isObj(v.visible) ? asString(v.visible.id) : null;
        const timeoutMs = isObj(v) && "timeout" in v ? v.timeout : DEFAULT_VISIBILITY_TIMEOUT_MS;
        if (!id || typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)
          throw new UnsupportedStepError("extendedWaitUntil (need visible.id; timeout must be finite and non-negative when present)");
        out.push({ t: "waitVisible", id: interp(id, params), timeoutMs });
        break;
      }
      case "waitForAnimationToEnd": {
        if (v === null || v === void 0) {
          out.push({ t: "wait", timeoutMs: 400 });
          break;
        }
        if (!isObj(v)) {
          throw new UnsupportedStepError("waitForAnimationToEnd (value must be an object)");
        }
        refuseUnsupportedKeys(v, ["timeout"], "waitForAnimationToEnd");
        if (!Number.isSafeInteger(v.timeout) || Number(v.timeout) < 0) {
          throw new UnsupportedStepError("waitForAnimationToEnd (need non-negative integer timeout)");
        }
        out.push({ t: "wait", timeoutMs: Number(v.timeout) });
        break;
      }
      case "runFlow": {
        if (isObj(v))
          refuseUnsupportedKeys(v, ["when", "commands"], "runFlow");
        if (isObj(v) && isObj(v.when))
          refuseUnsupportedKeys(v.when, ["visible"], "runFlow.when");
        if (isObj(v) && isObj(v.when) && isObj(v.when.visible)) {
          refuseUnsupportedKeys(v.when.visible, ["id"], "runFlow.when.visible");
        }
        const when = isObj(v) && isObj(v.when) && isObj(v.when.visible) ? asString(v.when.visible.id) : null;
        const commands = isObj(v) ? v.commands : void 0;
        if (!when || !Array.isArray(commands))
          throw new UnsupportedStepError("runFlow (need when.visible.id + commands[])");
        out.push({
          t: "runFlow",
          whenVisible: interp(when, params),
          commands: normalizeSteps(commands, params)
        });
        break;
      }
      default:
        throw new UnsupportedStepError(key);
    }
  }
  return out;
}
async function replayFlow(steps, dispatch, opts = {}) {
  const offset = opts.indexOffset ?? 0;
  const trace = [];
  let lastTapped = opts.initialFocusId ?? null;
  let pendingDesignation = null;
  let staleDesignation = null;
  const sourceIndex = (i) => opts.sourceIndex ?? i + offset;
  const fail = (i, reason, failureCode, failureMeta) => ({
    passed: false,
    failedStepIndex: sourceIndex(i),
    ...failureCode ? { failureCode } : {},
    ...failureMeta ? { failureMeta } : {},
    reason,
    steps: trace
  });
  const requireNotAborted = () => {
    if (opts.signal?.aborted) {
      throw new ReplayDispatchError("RUNNER_TIMEOUT", "React-tree replay exceeded its execution deadline");
    }
  };
  const releaseDesignation = async (token2) => {
    try {
      await dispatch.releaseDesignation?.(token2);
    } catch {
    }
  };
  const releasePendingDesignation = async () => {
    const designation = pendingDesignation;
    pendingDesignation = null;
    if (designation)
      await releaseDesignation(designation.token);
  };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const evidenceType = s.t === "waitVisible" ? s.evidenceType ?? s.t : s.t;
    const startedAt = Date.now();
    let stepFocusOnly;
    if (pendingDesignation && s.t !== "type") {
      staleDesignation = staleDesignation ?? pendingDesignation.id;
      const staleToken = pendingDesignation.token;
      pendingDesignation = null;
      await releaseDesignation(staleToken);
    }
    try {
      requireNotAborted();
      switch (s.t) {
        case "launch":
          await dispatch.launch(s.stopApp);
          requireNotAborted();
          trace.push({
            sourceIndex: sourceIndex(i),
            t: s.t,
            ok: true,
            durationMs: Date.now() - startedAt
          });
          break;
        case "tap":
          const pressResult = await dispatch.press(s.id);
          if (pressResult?.kind === "designation") {
            lastTapped = null;
            pendingDesignation = { id: s.id, token: pressResult.token };
            stepFocusOnly = true;
          } else {
            lastTapped = s.id;
          }
          requireNotAborted();
          trace.push({
            sourceIndex: sourceIndex(i),
            t: s.t,
            target: s.id,
            ...stepFocusOnly ? { focusOnly: stepFocusOnly } : {},
            ok: true,
            durationMs: Date.now() - startedAt
          });
          break;
        case "type": {
          const designation = pendingDesignation;
          const target = designation?.id ?? lastTapped;
          if (!target)
            return fail(i, "inputText before any tapOn \u2014 no focus target");
          pendingDesignation = null;
          try {
            await dispatch.type(target, s.text, designation ? {
              focusOnlyDesignation: true,
              designationToken: designation.token
            } : void 0);
          } finally {
            if (designation)
              await releaseDesignation(designation.token);
          }
          requireNotAborted();
          trace.push({
            sourceIndex: sourceIndex(i),
            t: s.t,
            target,
            ok: true,
            durationMs: Date.now() - startedAt
          });
          break;
        }
        case "waitVisible": {
          const deadline = startedAt + s.timeoutMs;
          let verdict = null;
          for (; ; ) {
            const observed = await readVisibilityBeforeDeadline(dispatch, s.id, deadline, opts.signal);
            requireNotAborted();
            if (!observed)
              break;
            verdict = observed;
            if (verdict.visible)
              break;
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0)
              break;
            await new Promise((resolve9) => setTimeout(resolve9, Math.min(VISIBILITY_POLL_INTERVAL_MS, remainingMs)));
          }
          const waitedMs = Date.now() - startedAt;
          trace.push({
            sourceIndex: sourceIndex(i),
            t: evidenceType,
            target: s.id,
            ok: verdict?.visible === true,
            durationMs: waitedMs
          });
          if (!verdict)
            return fail(i, `waitVisible: no readable visibility observation completed for "${s.id}" before the deadline`, "RUNNER_TIMEOUT", { failedSelector: s.id, waitedMs });
          if (!verdict.visible)
            return fail(i, verdict.reason ?? `waitVisible: "${s.id}" is not frontmost`, verdict.code ?? "TESTID_NOT_FOUND", { ...verdict.meta, failedSelector: s.id, waitedMs });
          break;
        }
        case "wait":
          await dispatch.settle(s.timeoutMs);
          requireNotAborted();
          trace.push({
            sourceIndex: sourceIndex(i),
            t: s.t,
            ok: true,
            durationMs: Date.now() - startedAt
          });
          break;
        case "runFlow": {
          const condition = await dispatch.visibility(s.whenVisible);
          requireNotAborted();
          if (condition.visible) {
            const sub = await replayFlow(s.commands, dispatch, {
              sourceIndex: sourceIndex(i),
              signal: opts.signal,
              initialFocusId: lastTapped ?? void 0
            });
            requireNotAborted();
            trace.push(...sub.steps);
            if (!sub.passed) {
              return {
                passed: false,
                failedStepIndex: sourceIndex(i),
                ...sub.failureCode ? { failureCode: sub.failureCode } : {},
                ...sub.failureMeta ? { failureMeta: sub.failureMeta } : {},
                reason: sub.reason,
                steps: trace
              };
            }
            lastTapped = sub.finalFocusId ?? null;
          } else if (condition.code && condition.code !== "TESTID_NOT_FOUND") {
            return fail(i, condition.reason ?? `runFlow condition proof failed for "${s.whenVisible}"`, condition.code, condition.meta);
          } else {
            trace.push({
              sourceIndex: sourceIndex(i),
              t: s.t,
              target: s.whenVisible,
              ok: true,
              durationMs: Date.now() - startedAt
            });
          }
          break;
        }
      }
    } catch (e) {
      const waitedMs = Date.now() - startedAt;
      await releasePendingDesignation();
      trace.push({
        sourceIndex: sourceIndex(i),
        t: evidenceType,
        target: "id" in s ? s.id : void 0,
        ...stepFocusOnly ? { focusOnly: stepFocusOnly } : {},
        ok: false,
        durationMs: waitedMs
      });
      const dispatchMeta = e instanceof ReplayDispatchError ? e.meta : void 0;
      return fail(i, e instanceof Error ? e.message : String(e), e instanceof ReplayDispatchError ? e.code : void 0, s.t === "waitVisible" ? { ...dispatchMeta, failedSelector: s.id, waitedMs } : dispatchMeta);
    }
  }
  if (opts.signal?.aborted) {
    await releasePendingDesignation();
    return fail(Math.max(0, steps.length - 1), "React-tree replay exceeded its execution deadline", "RUNNER_TIMEOUT");
  }
  const unconsumedDesignation = staleDesignation ?? pendingDesignation?.id;
  if (unconsumedDesignation) {
    if (pendingDesignation) {
      await releasePendingDesignation();
    }
    return fail(Math.max(0, steps.length - 1), `TextInput designation for "${unconsumedDesignation}" must be followed immediately by inputText`, "INTERACTION_NOT_ACTUATED", { failedSelector: unconsumedDesignation, focusOnly: true });
  }
  return { passed: true, finalFocusId: lastTapped, steps: trace };
}

// packages/rn-dev-agent-core/dist/domain/ios-proof-router.js
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function containsExactId(value, depth = 0) {
  if (depth > 20)
    return true;
  if (Array.isArray(value))
    return value.some((child) => containsExactId(child, depth + 1));
  if (!isObject(value))
    return false;
  return Object.entries(value).some(([key, child]) => key === "id" && typeof child === "string" || containsExactId(child, depth + 1));
}
function commandName(command) {
  if (typeof command === "string")
    return command;
  if (!isObject(command))
    return null;
  const keys = Object.keys(command);
  return keys.length === 1 ? keys[0] : null;
}
function commandTreeContains(value, names, depth = 0) {
  if (depth > 20)
    return false;
  if (Array.isArray(value)) {
    return value.some((child) => commandTreeContains(child, names, depth + 1));
  }
  if (!isObject(value))
    return false;
  return Object.entries(value).some(([key, child]) => names.has(key) || commandTreeContains(child, names, depth + 1));
}
function runFlowHasUnanchoredLeadingInputText(command) {
  if (!isObject(command) || !isObject(command.runFlow))
    return false;
  const commands = command.runFlow.commands;
  if (!Array.isArray(commands) || commands.length === 0)
    return false;
  for (const child of commands) {
    const name = commandName(child);
    if (name === "inputText")
      return true;
    if (name && nativeFocusPreservingCommands.has(name))
      continue;
    if (name === "tapOn" || name === "tap")
      return commands.some((candidate) => commandName(candidate) === "inputText");
    return false;
  }
  return false;
}
var nativeFocusPreservingCommands = /* @__PURE__ */ new Set([
  "assertVisible",
  "assertNotVisible",
  "extendedWaitUntil",
  "takeScreenshot",
  "waitForAnimationToEnd"
]);
function nativeCommandMayChangeFocus(command, depth = 0) {
  if (depth > 20)
    return true;
  const name = commandName(command);
  if (name !== "runFlow")
    return name === null || !nativeFocusPreservingCommands.has(name);
  if (!isObject(command))
    return true;
  const runFlow = command.runFlow;
  if (!isObject(runFlow) || !Array.isArray(runFlow.commands))
    return true;
  return runFlow.commands.some((child) => nativeCommandMayChangeFocus(child, depth + 1));
}
function exactTapId(command, params) {
  try {
    const step = normalizeSteps([command], params)[0];
    return step?.t === "tap" ? step.id : null;
  } catch (error) {
    if (error instanceof UnsupportedStepError)
      return null;
    throw error;
  }
}
function commandDomain(command, params) {
  const name = commandName(command);
  if (name === "waitForAnimationToEnd" || name === "inputText")
    return "neutral";
  try {
    normalizeSteps([command], params);
    return name === "launchApp" ? "neutral" : "react-tree";
  } catch (error) {
    if (!(error instanceof UnsupportedStepError))
      throw error;
    return containsExactId(command) ? "mixed" : "xctest-native";
  }
}
function planIosProofDomains(commands, params) {
  const classified = commands.map((command) => commandDomain(command, params));
  for (let index = 0; index < classified.length; index++) {
    if (classified[index] === "mixed") {
      return {
        ok: false,
        sourceIndex: index,
        reason: "one command mixes an exact testID with native-only semantics; split it into separate React-tree and XCTest commands"
      };
    }
  }
  const segments = [];
  let focusedDomain = null;
  let focusedReactId = null;
  const tapCommands = /* @__PURE__ */ new Set(["tapOn", "tap"]);
  const lifecycleCommands2 = /* @__PURE__ */ new Set(["launchApp", "clearState", "killApp", "stopApp"]);
  for (let index = 0; index < commands.length; index++) {
    const name = commandName(commands[index]);
    let domain = classified[index];
    if (name === "runFlow" && runFlowHasUnanchoredLeadingInputText(commands[index])) {
      domain = "xctest-native";
    }
    if (domain === "neutral") {
      domain = name === "inputText" ? focusedDomain ?? "xctest-native" : segments.at(-1)?.domain ?? classified.slice(index + 1).find((candidate) => candidate !== "neutral") ?? "react-tree";
    }
    if (domain === "mixed")
      continue;
    const prior = segments.at(-1);
    if (prior?.domain === domain) {
      prior.commands.push(commands[index]);
      prior.sourceIndices.push(index);
    } else {
      segments.push({
        domain,
        commands: [commands[index]],
        sourceIndices: [index],
        ...domain === "react-tree" && focusedReactId ? { initialReactFocusId: focusedReactId } : {}
      });
    }
    if (domain === "xctest-native" && nativeCommandMayChangeFocus(commands[index])) {
      focusedDomain = domain;
      focusedReactId = null;
    } else if (tapCommands.has(name ?? "")) {
      focusedDomain = domain;
      focusedReactId = name === "tapOn" && domain === "react-tree" ? exactTapId(commands[index], params) : null;
    } else if (commandTreeContains(commands[index], tapCommands)) {
      focusedDomain = domain;
      focusedReactId = null;
    } else if (commandTreeContains(commands[index], lifecycleCommands2)) {
      focusedDomain = null;
      focusedReactId = null;
    }
  }
  return { ok: true, segments };
}
function nativeSelectorsForCommands(commands) {
  const selectors = /* @__PURE__ */ new Set();
  const unsupportedSelectors = /* @__PURE__ */ new Set();
  const addSelector = (value) => {
    if (typeof value === "string") {
      if (!unsupportedSelectors.has(value))
        selectors.add(value);
      return;
    }
    if (isObject(value) && typeof value.text === "string") {
      if (Object.keys(value).length === 1 && !unsupportedSelectors.has(value.text)) {
        selectors.add(value.text);
      } else {
        selectors.delete(value.text);
        unsupportedSelectors.add(value.text);
      }
    }
  };
  const visit = (value, depth = 0) => {
    if (depth > 20)
      return;
    if (Array.isArray(value)) {
      for (const child of value)
        visit(child, depth + 1);
      return;
    }
    if (!isObject(value))
      return;
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === "tapOn" || childKey === "assertVisible")
        addSelector(child);
      if (childKey === "extendedWaitUntil" && isObject(child))
        addSelector(child.visible);
      if (childKey === "scrollUntilVisible" && isObject(child))
        addSelector(child.element);
      if (childKey === "when" && isObject(child))
        addSelector(child.visible);
      if (childKey !== "assertNotVisible" && childKey !== "notVisible")
        visit(child, depth + 1);
    }
  };
  visit(commands);
  return [...selectors].slice(0, 20).map((value) => ({ kind: "text", value }));
}
function soleComparableNativeSelectorForCommands(commands) {
  const candidates = [];
  const addCandidate = (value) => {
    if (typeof value === "string") {
      candidates.push({ kind: "text", value });
      return;
    }
    if (isObject(value) && typeof value.text === "string") {
      candidates.push(Object.keys(value).length === 1 ? { kind: "text", value: value.text } : null);
      return;
    }
    candidates.push(null);
  };
  const visit = (value, depth = 0) => {
    if (depth > 20)
      return;
    if (Array.isArray(value)) {
      for (const child of value)
        visit(child, depth + 1);
      return;
    }
    if (!isObject(value))
      return;
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === "tapOn" || childKey === "assertVisible")
        addCandidate(child);
      if (childKey === "extendedWaitUntil" && isObject(child))
        addCandidate(child.visible);
      if (childKey === "scrollUntilVisible" && isObject(child))
        addCandidate(child.element);
      if (childKey === "when" && isObject(child))
        addCandidate(child.visible);
      if (childKey !== "assertNotVisible" && childKey !== "notVisible")
        visit(child, depth + 1);
    }
  };
  visit(commands);
  return candidates.length === 1 ? candidates[0] : null;
}
function loginPostconditionId(commands) {
  const last = commands.at(-1);
  if (!isObject(last))
    return null;
  const command = last.assertVisible ?? last.extendedWaitUntil;
  if (!isObject(command))
    return null;
  const visible = "visible" in command ? command.visible : command;
  return isObject(visible) && typeof visible.id === "string" ? visible.id : null;
}

// packages/rn-dev-agent-core/dist/tools/cdp-replay-dispatch.js
function nodeProps(treeJson, id) {
  const stack = [treeJson];
  while (stack.length) {
    const n = stack.pop();
    if (n && typeof n === "object") {
      if (n.testID === id || n.nativeID === id)
        return n.props ?? n;
      if (n.tree)
        stack.push(n.tree);
      const kids = n.children ?? n.interactive ?? n.nodes ?? n.matches;
      if (Array.isArray(kids))
        stack.push(...kids);
    }
  }
  return null;
}
function nodePath(treeJson, id) {
  const root2 = treeJson && typeof treeJson === "object" && "tree" in treeJson ? treeJson.tree : treeJson;
  const visit = (value, ancestors) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const node = value;
    const path = [...ancestors, node];
    if (node.testID === id || node.nativeID === id)
      return path;
    const children = node.children ?? node.nodes ?? node.matches;
    if (!Array.isArray(children))
      return null;
    for (const child of children) {
      const found = visit(child, path);
      if (found)
        return found;
    }
    return null;
  };
  return visit(root2, []);
}
function pointerEventsBlock(treeJson, id) {
  const path = nodePath(treeJson, id);
  if (!path)
    return null;
  for (let index = 0; index < path.length; index += 1) {
    const node = path[index];
    const props = node.props ?? node;
    const pointerEvents = props.pointerEvents;
    const target = index === path.length - 1;
    if (target && (pointerEvents === "none" || pointerEvents === "box-none")) {
      return `the target has pointerEvents="${pointerEvents}"`;
    }
    if (!target && pointerEvents === "none")
      return 'an ancestor has pointerEvents="none"';
    if (!target && pointerEvents === "box-only") {
      return 'an ancestor has pointerEvents="box-only"';
    }
  }
  return null;
}
function isDisabled(props) {
  if (!props)
    return false;
  const a11y = props.accessibilityState;
  return props.disabled === true || a11y?.disabled === true;
}
async function runCdpReplayCommands(commands, params, deps, opts = {}) {
  return replayFlow(normalizeSteps(commands, params), buildCdpDispatch(deps, opts.signal), {
    signal: opts.signal,
    initialFocusId: opts.initialFocusId
  });
}
function buildCdpDispatch(deps, signal) {
  const requireNotAborted = () => {
    if (signal?.aborted) {
      throw new ReplayDispatchError("RUNNER_TIMEOUT", "React-tree replay exceeded its execution deadline");
    }
  };
  const assertExactInteractable = async (id) => {
    const tree = await deps.treeFor(id);
    requireNotAborted();
    const frontmost = await deps.frontmostFor(id);
    requireNotAborted();
    if (frontmost.matchCount === 0)
      throw new ReplayDispatchError("TESTID_NOT_FOUND", `testID "${id}" not present`, {
        failedSelector: id
      });
    const matches = frontmost.matchCount ?? 1;
    if (matches > 1)
      throw new ReplayDispatchError("AMBIGUOUS_TESTID", `testID "${id}" resolves to ${matches} mounted elements`, { matchCount: matches });
    if (!frontmost.visible)
      throw new ReplayDispatchError(frontmost.code ?? "ASSERTION_FAILED", frontmost.reason ?? `testID "${id}" is mounted but not frontmost`);
    if (frontmost.disabled === true || isDisabled(nodeProps(tree, id)))
      throw new ReplayDispatchError("INTERACTION_NOT_ACTUATED", `testID "${id}" is disabled/non-interactable`);
    const pointerEventsError = pointerEventsBlock(tree, id);
    if (pointerEventsError)
      throw new ReplayDispatchError("INTERACTION_NOT_ACTUATED", `testID "${id}" is not user-interactable: ${pointerEventsError}`);
  };
  return {
    async press(id) {
      await assertExactInteractable(id);
      requireNotAborted();
      return deps.pressByTestId(id);
    },
    async type(id, text, context) {
      await assertExactInteractable(id);
      requireNotAborted();
      await deps.typeByTestId(id, text, context);
    },
    async releaseDesignation(token2) {
      await deps.releaseInputDesignation?.(token2);
    },
    async visibility(id) {
      await deps.treeFor(id);
      const frontmost = await deps.frontmostFor(id);
      if (frontmost.matchCount === 0)
        return {
          visible: false,
          code: "TESTID_NOT_FOUND",
          reason: `testID "${id}" not present in the React tree`,
          meta: { failedSelector: id }
        };
      const matches = frontmost.matchCount ?? 1;
      if (matches > 1)
        return {
          visible: false,
          code: "AMBIGUOUS_TESTID",
          reason: `testID "${id}" resolves to ${matches} mounted elements`
        };
      if (!frontmost.visible)
        return {
          visible: false,
          code: frontmost.code ?? "ASSERTION_FAILED",
          reason: frontmost.reason ?? `testID "${id}" is mounted but not frontmost`
        };
      return { visible: true };
    },
    async launch(stopApp) {
      await deps.launchApp(stopApp);
    },
    async settle(timeoutMs) {
      await deps.settle(timeoutMs);
    }
  };
}

// packages/rn-dev-agent-core/dist/tools/maestro-run.js
var defaultExecFile = promisify13(execFileCb10);
async function runFlowParked(run, opts = {}) {
  const stale = opts.markCdpStale ?? markCdpStale;
  try {
    if (opts.platform === "android") {
      const release = opts.releaseAndroidSlot ?? releaseAndroidInteractionSlot;
      const outcome = opts.signal ? await release({ deviceId: opts.deviceId, signal: opts.signal }) : await release({ deviceId: opts.deviceId });
      opts.onAndroidRelease?.(outcome);
    } else {
      if (opts.signal) {
        await (opts.stopFastRunner ?? stopFastRunner)(opts.deviceId, opts.signal);
      } else {
        await (opts.stopFastRunner ?? stopFastRunner)(opts.deviceId);
      }
    }
    if (opts.completeRunnerPark) {
      if (opts.signal)
        await opts.completeRunnerPark(opts.signal);
      else
        await opts.completeRunnerPark();
    }
    return await run();
  } finally {
    stale();
  }
}
function assembleMaestroArgs(baseArgs, paramArgs) {
  if (paramArgs.length === 0)
    return baseArgs;
  return [...baseArgs.slice(0, -1), ...paramArgs, baseArgs[baseArgs.length - 1]];
}
function nestedMaestroAuthorityCallbacks(args) {
  return {
    claimNativeOrigin: () => claimManagedNativeOriginAuthority(args),
    completeNativeOrigin: (targetExpected, signal) => completeManagedNativeOriginAuthority(args, targetExpected, signal),
    relaunchManagedApp: (stopApp) => relaunchManagedNativeOriginApp(args, stopApp),
    reproveManagedOrigin: (options) => reproveManagedNativeOrigin(args, options),
    completeRunnerPark: (signal) => completeManagedRunnerParkAuthority(args, signal),
    reissueInstallReceipt: hasManagedInstallReissueAuthority(args) ? () => reissueManagedInstallAuthority(args) : null
  };
}
var MaestroStageExecutionError = class extends Error {
  completedResults;
  stageError;
  constructor(completedResults, stageError) {
    super(stageError instanceof Error ? stageError.message : String(stageError), {
      cause: stageError
    });
    this.name = "MaestroStageExecutionError";
    this.completedResults = [...completedResults];
    this.stageError = stageError;
  }
};
var lifecycleCommands = /* @__PURE__ */ new Set(["launchApp", "clearState", "killApp", "stopApp"]);
function commandName2(command) {
  if (typeof command === "string")
    return command;
  if (!command || typeof command !== "object" || Array.isArray(command))
    return null;
  const keys = Object.keys(command);
  return keys.length === 1 ? keys[0] : null;
}
function nestedLifecycleCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command))
    return false;
  const runFlow = command.runFlow;
  if (!runFlow || typeof runFlow !== "object" || Array.isArray(runFlow))
    return false;
  const commands = runFlow.commands;
  return Array.isArray(commands) && commands.some(nestedLifecycleCommandOrSelf);
}
function nestedLifecycleCommandOrSelf(command) {
  const name = commandName2(command);
  return name !== null && lifecycleCommands.has(name) || nestedLifecycleCommand(command);
}
function planMaestroAuthorityStages(commands) {
  const stages = [];
  let pending = [];
  let targetExpected = true;
  const flushPending = () => {
    if (pending.length === 0)
      return;
    stages.push({ commands: pending, requiresOrigin: true });
    pending = [];
  };
  for (const command of commands) {
    const name = commandName2(command);
    if (nestedLifecycleCommand(command)) {
      throw new MaestroValidationError("conditional runFlow commands cannot contain app lifecycle transitions");
    }
    if (name !== null && lifecycleCommands.has(name)) {
      flushPending();
      stages.push({ commands: [command], requiresOrigin: false });
      targetExpected = name === "launchApp";
      continue;
    }
    pending.push(command);
  }
  flushPending();
  return { stages, targetExpected };
}
async function executeMaestroAuthorityStages(commands, executeStage, claimOrigin, completeOrigin, relaunchManagedApp, reproveManagedOrigin, options = {}) {
  const plan = planMaestroAuthorityStages(commands);
  const results = [];
  let pendingOriginError;
  let originClaimed = options.firstOriginClaimed === true;
  for (const stage of plan.stages) {
    if (stage.requiresOrigin && pendingOriginError === void 0) {
      if (!originClaimed)
        await claimOrigin();
      originClaimed = false;
    }
    try {
      results.push(await executeStage(stage.commands));
      if (stage.commands.length === 1 && commandName2(stage.commands[0]) === "launchApp") {
        try {
          const launch = stage.commands[0];
          const launchOptions = launch.launchApp && typeof launch.launchApp === "object" && !Array.isArray(launch.launchApp) ? launch.launchApp : void 0;
          await relaunchManagedApp(typeof launchOptions?.stopApp === "boolean" ? launchOptions.stopApp : true);
          pendingOriginError = void 0;
        } catch (error) {
          if (!reproveManagedOrigin || error instanceof SessionAuthorityError)
            throw error;
          pendingOriginError = error;
        }
      }
    } catch (error) {
      await completeOrigin(false, options.signal);
      throw new MaestroStageExecutionError(results, error);
    }
  }
  if (pendingOriginError !== void 0) {
    try {
      await reproveManagedOrigin({ signal: options.signal });
    } catch {
      await completeOrigin(false, options.signal);
      throw new MaestroStageExecutionError(results, pendingOriginError);
    }
  }
  await completeOrigin(plan.targetExpected, options.signal);
  return results;
}
function resolveMaestroFlowAppId(boundAppId, parsedAppId) {
  if (boundAppId !== void 0 && !isValidBundleId(boundAppId)) {
    throw new MaestroValidationError(`Invalid bundle ID for authority-bound app: ${JSON.stringify(boundAppId).slice(0, 80)}`);
  }
  if (boundAppId && parsedAppId && parsedAppId !== boundAppId) {
    throw new MaestroValidationError(`Flow appId ${parsedAppId} does not match authority-bound appId ${boundAppId}`);
  }
  return boundAppId ?? parsedAppId;
}
var PARAM_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
function resolvePlatform(override) {
  if (override === "ios" || override === "android")
    return override;
  const session2 = getActiveSession();
  return session2?.platform ?? null;
}
function resolveAppId(override, platform) {
  if (override)
    return override;
  if (platform)
    return resolveBundleId(platform) ?? readExpoSlug() ?? "";
  return readExpoSlug() ?? "";
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function remapNativeStep(step, ordinal, sourceIndices) {
  if (!isRecord(step))
    return null;
  const reportedIndex = Number(step.index);
  const localIndex = Number.isSafeInteger(reportedIndex) && reportedIndex >= 0 ? reportedIndex : ordinal;
  return {
    index: sourceIndices[localIndex] ?? sourceIndices[ordinal] ?? localIndex,
    name: String(step.name ?? step.verb ?? "native"),
    verb: String(step.verb ?? step.name ?? "native"),
    status: step.status === "fail" ? "fail" : "pass",
    durationMs: Number(step.durationMs ?? 0)
  };
}
function remapNativeSteps(steps, sourceIndices) {
  if (!Array.isArray(steps))
    return [];
  return steps.flatMap((step, ordinal) => {
    const mapped = remapNativeStep(step, ordinal, sourceIndices);
    return mapped ? [mapped] : [];
  });
}
function partialNativeFailureMessage(meta, nestedError) {
  const failedStep = remapNativeStep(meta.failedStep, 0, []);
  const lastStep = remapNativeStep(meta.lastStep, 0, []);
  const terminal = isRecord(meta.terminal) ? meta.terminal : null;
  const failureKind = terminal?.failureKind;
  const reason = failureKind === "SELECTOR_NOT_FOUND" || failureKind === "TIMEOUT" || failureKind === "ASSERTION_FAILED" ? {
    kind: failureKind,
    selector: typeof terminal?.failureSelector === "string" ? terminal.failureSelector : null
  } : null;
  const headline = formatFailureHeadline(
    { steps: [], failedStep, lastStep, reason },
    { timedOut: meta.timedOut === true, outputTruncated: meta.outputTruncated === true },
    // Keep the nested envelope's own cause when no structured evidence exists.
    nestedError?.replace(/^Maestro flow failed: /, "") || "Native replay segment failed."
  );
  const runtimeDegradation = runtimeDegradationFromMetadata(meta.runtimeDegraded);
  return runtimeDegradation ? `${headline} \u2014 ${formatRuntimeDegradedHint(runtimeDegradation)}` : headline;
}
var ReactReplayFailure = class extends Error {
  replay;
  sourceIndices;
  constructor(replay, sourceIndices) {
    super(replay.reason ?? "React-tree replay failed");
    this.replay = replay;
    this.sourceIndices = sourceIndices;
    this.name = "ReactReplayFailure";
  }
};
function readToolEnvelope(result) {
  try {
    return JSON.parse(result.content[0]?.text ?? "{}");
  } catch {
    return { ok: false, error: "Unparseable nested replay result" };
  }
}
function isLoginMetadata(metadata) {
  if (!metadata)
    return false;
  return /(^|[-_.])login($|[-_.])/.test(metadata.id) || metadata.tags?.some((tag) => tag === "login" || tag === "auth") === true;
}
async function defaultProbeAndroidApiLevel(deviceId) {
  try {
    const { stdout } = await defaultExecFile("adb", ["-s", deviceId, "shell", "getprop", "ro.build.version.sdk"], { timeout: 5e3, encoding: "utf8", maxBuffer: 1024 * 1024 });
    const parsed = Number.parseInt(String(stdout).trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}
var UIAUTOMATION_SESSION_CREATION_FAILURE = /^Error: failed to create driver: create session: session not created: java\.lang\.IllegalStateException: UiAutomation not connected(?:, UiAutomation@[^\r\n]+)?$/;
function attachCause(error, cause) {
  if (error instanceof Error && error.cause === void 0) {
    try {
      Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
    } catch {
    }
  }
  return error;
}
function isExactDeviceIdShape(value) {
  return value.length > 0 && value.length <= 256 && !/\s/.test(value);
}
function isPreSpawnMaestroError(error) {
  const candidate = error;
  return typeof candidate?.code === "string" && !candidate.stdout && !candidate.stderr;
}
function isUiAutomationNotConnectedSessionCreationFailure(error) {
  const candidate = error;
  if (typeof candidate?.code !== "number" || candidate.code === 0 || typeof candidate.stderr !== "string") {
    return false;
  }
  const records = candidate.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return records.length === 1 && UIAUTOMATION_SESSION_CREATION_FAILURE.test(records[0]);
}
async function buildRunnerResume(platform, probe) {
  if (platform !== "ios")
    return void 0;
  return { attempted: true, healthy: await probe().catch(() => false) };
}
function createMaestroRunHandler(deps = {}) {
  const fastHealthCheck2 = deps.fastHealthCheck ?? fastHealthCheck;
  const stopFastRunner2 = deps.stopFastRunner ?? stopFastRunner;
  const activeSession2 = deps.getActiveSession ?? getActiveSession;
  const selectDispatch = deps.chooseDispatch ?? chooseMaestroDispatch;
  const parkFlow = deps.parkFlow ?? runFlowParked;
  const execute = deps.execFile ?? defaultExecFile;
  const probeApiLevel = deps.probeAndroidApiLevel ?? defaultProbeAndroidApiLevel;
  const now = deps.now ?? Date.now;
  const resolveEngineStatus = deps.resolveEngineStatus ?? (() => getEngineStatus().catch(() => null));
  const replayFactory = deps.replayDeps;
  const nativeOnlyHandler = replayFactory ? createMaestroRunHandler({ ...deps, replayDeps: void 0 }) : null;
  return async (args) => {
    if (args.params) {
      for (const [key, value] of Object.entries(args.params)) {
        if (!PARAM_KEY_RE.test(key)) {
          return failResult(`Refusing to run Maestro: invalid param key '${String(key).slice(0, 60)}' \u2014 must match ${PARAM_KEY_RE.source} (GH #116).`);
        }
        if (typeof value !== "string") {
          return failResult(`Refusing to run Maestro: param '${key}' has non-string value (GH #116).`);
        }
      }
    }
    const platform = resolvePlatform(args.platform);
    if (!platform) {
      return failResult("Cannot determine platform. Pass platform or open a device session first.");
    }
    const session2 = activeSession2();
    const matchingSessionDeviceId = session2?.platform === platform && session2.deviceId ? session2.deviceId : void 0;
    if (args.deviceId && matchingSessionDeviceId && !sameDevice(args.deviceId, matchingSessionDeviceId)) {
      return failResult(`Refusing Maestro target ${args.deviceId}: active ${platform} session is bound to ${matchingSessionDeviceId}.`, "TARGET_SESSION_MISMATCH", { requestedDeviceId: args.deviceId, activeSessionDeviceId: matchingSessionDeviceId });
    }
    const envAndroidSerial = platform === "android" && process.env.ANDROID_SERIAL ? process.env.ANDROID_SERIAL : void 0;
    if (envAndroidSerial !== void 0 && !isExactDeviceIdShape(envAndroidSerial)) {
      return failResult("Refusing Maestro: ANDROID_SERIAL must be 1-256 non-whitespace characters. Unset it or set an exact serial, then retry. No device was mutated.", "INVALID_ARGUMENT");
    }
    const requestedDeviceId = args.deviceId ?? matchingSessionDeviceId ?? envAndroidSerial;
    if (requestedDeviceId !== void 0 && !isExactDeviceIdShape(requestedDeviceId)) {
      return failResult("Refusing Maestro: deviceId must be 1-256 non-whitespace characters.", "INVALID_ARGUMENT");
    }
    let flowHasHideKeyboard = false;
    let flowFile;
    let rawYaml;
    let validatedContent;
    let validatedCommands;
    let headerAppId;
    let capturedAction = null;
    const flowPathClassification = args.flowPath ? classifyLearnedActionPath(args.flowPath) : "outside";
    if (flowPathClassification === "descendant") {
      return failResult(`Refusing to execute learned-action descendant ${args.flowPath} as a standalone flow.`, "BAD_RECORDING");
    }
    if (flowPathClassification === "action") {
      if (args.inlineYaml) {
        return failResult("Refusing ambiguous learned-action replay with both flowPath and inlineYaml.", "BAD_RECORDING");
      }
      try {
        capturedAction = captureActionFromPath(args.flowPath);
      } catch (err) {
        return failResult(err instanceof Error ? err.message : String(err), "BAD_RECORDING");
      }
      if (!capturedAction) {
        return failResult(`Action does not resolve uniquely to ${args.flowPath}.`, "BAD_RECORDING");
      }
      if (!capturedAction.replay.ok) {
        return failResult(capturedAction.replay.error, "BAD_RECORDING");
      }
      rawYaml = capturedAction.replay.yamlText;
    } else if (args.inlineYaml) {
      rawYaml = args.inlineYaml;
    } else if (args.flowPath) {
      if (!existsSync17(args.flowPath)) {
        return failResult(`Flow file not found: ${args.flowPath}`);
      }
      try {
        rawYaml = readFileSync15(args.flowPath, "utf-8");
      } catch (err) {
        return failResult(`Failed to read flow file: ${err.message}`);
      }
    } else {
      return failResult("Provide either flowPath or inlineYaml.");
    }
    try {
      const runFlowOpts = args.flowPath && flowPathClassification === "outside" ? { flowDir: dirname14(args.flowPath), flowRoot: dirname14(args.flowPath) } : {};
      const parsed = parseAndValidateFlow(rawYaml, runFlowOpts);
      planMaestroAuthorityStages(parsed.commands);
      validatedCommands = parsed.commands;
      flowHasHideKeyboard = flowContainsHideKeyboard(parsed.commands);
      const rawAppId = resolveAppId(args.appId, platform);
      headerAppId = resolveMaestroFlowAppId(rawAppId || void 0, parsed.appId);
      validatedContent = buildMaestroFlow(headerAppId ? { appId: headerAppId } : {}, parsed.commands);
      flowFile = join23(tmpdir4(), `rn-maestro-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`);
    } catch (err) {
      if (err instanceof MaestroValidationError) {
        return failResult(`Refusing to run Maestro: ${err.message} (Phase 134.1)`);
      }
      throw err;
    }
    const semanticActionMeta = capturedAction?.metadata ?? args.actionMetadata ?? (args.flowPath ? parseM7Header(rawYaml, basename8(args.flowPath).replace(/\.ya?ml$/i, "")) : null);
    const iosProofPlan = platform === "ios" && replayFactory ? planIosProofDomains(validatedCommands, args.params ?? {}) : null;
    if (iosProofPlan && !iosProofPlan.ok) {
      return failResult(`Refusing iOS proof-domain ambiguity at step ${iosProofPlan.sourceIndex}: ${iosProofPlan.reason}.`, "UNSUPPORTED_STEP", { sourceIndex: iosProofPlan.sourceIndex, proofDomains: ["react-tree", "xctest-native"] });
    }
    if (iosProofPlan?.ok && iosProofPlan.segments.some((segment) => segment.domain === "react-tree")) {
      const reactOnlyProof = iosProofPlan.segments.every((segment) => segment.domain === "react-tree");
      const reactEngineStatus = await resolveEngineStatus();
      const reactCompatibilityRefusal = capturedAction || semanticActionMeta ? actionReplayPreflight({
        enginePin: semanticActionMeta?.enginePin,
        commands: validatedCommands,
        engineStatus: reactEngineStatus,
        requireRuntimePin: !reactOnlyProof
      }) : replayCompatibilityPreflight({
        commands: validatedCommands,
        engineStatus: reactEngineStatus,
        requireEnginePin: false,
        requireRuntimePin: !reactOnlyProof
      });
      if (reactCompatibilityRefusal) {
        return failResult(reactCompatibilityRefusal, "ENGINE_PIN_MISMATCH", {
          pin: reactEngineStatus?.pin,
          installedVersion: reactEngineStatus?.version ?? null,
          selectedPath: reactEngineStatus?.selectedPath ?? null,
          provenance: reactEngineStatus?.provenance ?? "none",
          proofDomain: reactOnlyProof ? "react-tree" : "partitioned"
        });
      }
      writeFileSync6(flowFile, validatedContent, "utf-8");
      if (isLoginMetadata(semanticActionMeta) && !loginPostconditionId(validatedCommands)) {
        return failResult("Refusing login replay without a final positive post-submit testID assertion. End the flow with assertVisible.id or extendedWaitUntil.visible.id.", "ASSERTION_FAILED", { proofDomain: "react-tree", postcondition: "missing" });
      }
      const timeout2 = args.timeoutMs ?? 12e4;
      const deadline = now() + timeout2;
      const controller = new AbortController();
      const deadlineTimer = setTimeout(() => controller.abort(new Error("iOS partitioned replay deadline exceeded")), timeout2);
      const managedAuthority = nestedMaestroAuthorityCallbacks(args);
      const claimOrigin = args.claimNativeOrigin ?? deps.claimNativeOrigin ?? managedAuthority.claimNativeOrigin;
      const completeOrigin = args.completeNativeOrigin ?? deps.completeNativeOrigin ?? managedAuthority.completeNativeOrigin;
      const relaunchManagedApp = args.relaunchManagedApp ?? deps.relaunchManagedApp ?? managedAuthority.relaunchManagedApp;
      const reproveManagedOrigin = args.reproveManagedOrigin ?? deps.reproveManagedOrigin ?? managedAuthority.reproveManagedOrigin;
      const completeRunnerPark = args.completeRunnerPark ?? managedAuthority.completeRunnerPark;
      const reissueInstallReceipt2 = args.reissueInstallReceipt ?? deps.reissueInstallReceipt ?? managedAuthority.reissueInstallReceipt;
      const combinedSteps = [];
      const proofDomains = [];
      let nativeTransportVersion = null;
      let nativeOutput = "";
      let retainedReactFocusId;
      try {
        for (const segment of iosProofPlan.segments) {
          if (controller.signal.aborted || deadline - now() <= 0) {
            return failResult("Partitioned iOS replay exceeded its deadline.", "RUNNER_TIMEOUT", {
              proofDomains
            });
          }
          if (segment.domain === "xctest-native") {
            proofDomains.push("xctest-native");
            const nested = await nativeOnlyHandler({
              ...args,
              flowPath: void 0,
              inlineYaml: buildMaestroFlow(headerAppId ? { appId: headerAppId } : {}, segment.commands),
              timeoutMs: Math.max(1, deadline - now()),
              claimNativeOrigin: claimOrigin,
              completeNativeOrigin: completeOrigin,
              relaunchManagedApp,
              reproveManagedOrigin,
              completeRunnerPark,
              reissueInstallReceipt: reissueInstallReceipt2
            });
            const env = readToolEnvelope(nested);
            if (env.ok !== true || env.data?.passed !== true) {
              const nestedMeta = { ...env.meta, ...env.data };
              const nativeSegmentCoversAttempt = segment.sourceIndices.length === validatedCommands.length && segment.sourceIndices.every((sourceIndex, index) => sourceIndex === index);
              let nestedError = env.error ?? "Native replay segment failed.";
              if (!nativeSegmentCoversAttempt) {
                delete nestedMeta.trailingVerification;
                delete nestedMeta.ledger;
                nestedError = partialNativeFailureMessage(nestedMeta, env.error);
              }
              combinedSteps.push(...remapNativeSteps(nestedMeta.steps, segment.sourceIndices));
              const uniqueProofDomains = [...new Set(proofDomains)];
              const proofDomain2 = uniqueProofDomains.length === 1 ? uniqueProofDomains.at(0) ?? "partitioned" : "partitioned";
              const failedStep = remapNativeStep(nestedMeta.failedStep, Math.max(0, segment.sourceIndices.length - 1), segment.sourceIndices);
              const lastStep = remapNativeStep(nestedMeta.lastStep, Math.max(0, segment.sourceIndices.length - 1), segment.sourceIndices);
              const meta = {
                ...nestedMeta,
                flowFile,
                proofDomain: proofDomain2,
                proofDomains: uniqueProofDomains,
                ...proofDomain2 === "partitioned" ? { runner: "partitioned", transport: "partitioned" } : {},
                steps: combinedSteps,
                ...failedStep ? { failedStep } : {},
                ...lastStep ? { lastStep } : {}
              };
              return env.code ? failResult(nestedError, env.code, meta) : failResult(nestedError, meta);
            }
            nativeTransportVersion = env.data.transportVersion ?? nativeTransportVersion;
            if (typeof env.data.output === "string")
              nativeOutput += env.data.output;
            combinedSteps.push(...remapNativeSteps(env.data.steps, segment.sourceIndices));
            if (segment.commands.some(nativeCommandMayChangeFocus)) {
              retainedReactFocusId = void 0;
            }
            continue;
          }
          proofDomains.push("react-tree");
          const replayDependencies = replayFactory(args, controller.signal);
          if (!replayDependencies) {
            const uniqueProofDomains = [...new Set(proofDomains)];
            const proofDomain2 = uniqueProofDomains.length === 1 ? uniqueProofDomains.at(0) ?? "partitioned" : "partitioned";
            return failResult("React-tree replay requires the authority-bound bridgeless runtime. Reconnect the exact app bundle and retry.", "CDP_NOT_CONNECTED", {
              flowFile,
              proofDomain: proofDomain2,
              proofDomains: uniqueProofDomains,
              failedProofDomain: "react-tree",
              ...proofDomain2 === "partitioned" ? { runner: "partitioned", transport: "partitioned" } : {},
              transportVersion: nativeTransportVersion,
              steps: combinedSteps,
              failedStepIndex: segment.sourceIndices.at(0),
              output: nativeOutput.slice(0, 2e3),
              outputTruncated: nativeOutput.length > 2e3
            });
          }
          let stageCursor = 0;
          let reactFocusId = retainedReactFocusId ?? segment.initialReactFocusId;
          const stageResults = await executeMaestroAuthorityStages(segment.commands, async (commands) => {
            const sourceIndices = segment.sourceIndices.slice(stageCursor, stageCursor + commands.length);
            stageCursor += commands.length;
            const replay = await runCdpReplayCommands([...commands], args.params ?? {}, {
              ...replayDependencies,
              launchApp: async () => {
              }
            }, { signal: controller.signal, initialFocusId: reactFocusId });
            if (!replay.passed)
              throw new ReactReplayFailure(replay, sourceIndices);
            for (const step of replay.steps) {
              if (step.t === "launch")
                reactFocusId = void 0;
              if (step.t === "tap" && step.target) {
                reactFocusId = step.focusOnly ? void 0 : step.target;
              }
            }
            if (replay.finalFocusId === null)
              reactFocusId = void 0;
            return { replay, sourceIndices };
          }, claimOrigin, completeOrigin, relaunchManagedApp, reproveManagedOrigin, { signal: controller.signal });
          retainedReactFocusId = reactFocusId;
          for (const { replay, sourceIndices } of stageResults) {
            for (const step of replay.steps) {
              combinedSteps.push({
                index: sourceIndices[step.sourceIndex] ?? step.sourceIndex,
                name: step.t,
                verb: step.t,
                ...step.focusOnly ? { focusOnly: true } : {},
                status: step.ok ? "pass" : "fail",
                durationMs: step.durationMs
              });
            }
          }
        }
        const uniqueDomains = [...new Set(proofDomains)];
        const proofDomain = uniqueDomains.length === 1 ? uniqueDomains[0] : "partitioned";
        const expectedRoute = semanticActionMeta?.expectedRouteSequence?.at(-1);
        if (expectedRoute && deps.getLiveRoute) {
          const liveRoute = await deps.getLiveRoute().catch(() => null);
          if (controller.signal.aborted || deadline - now() <= 0) {
            return failResult("Partitioned iOS replay exceeded its deadline during route verification.", "RUNNER_TIMEOUT", {
              proofDomain,
              proofDomains: uniqueDomains,
              ...proofDomain === "partitioned" ? { runner: "partitioned", transport: "partitioned" } : {},
              transportVersion: nativeTransportVersion,
              steps: combinedSteps,
              expectedRoute,
              liveRoute
            });
          }
          if (liveRoute !== expectedRoute) {
            return failResult(`React-tree replay reached its final testID but route ${String(liveRoute)} does not match expected route ${expectedRoute}.`, "ASSERTION_FAILED", {
              proofDomain,
              proofDomains: uniqueDomains,
              ...proofDomain === "partitioned" ? { runner: "partitioned", transport: "partitioned" } : {},
              transportVersion: nativeTransportVersion,
              steps: combinedSteps,
              output: nativeOutput.slice(0, 2e3),
              outputTruncated: nativeOutput.length > 2e3,
              expectedRoute,
              liveRoute
            });
          }
        }
        return okResult({
          passed: true,
          flowFile,
          platform,
          runner: uniqueDomains.length === 1 ? "cdp-js" : "partitioned",
          transport: uniqueDomains.length === 1 ? "cdp-js" : "partitioned",
          transportVersion: nativeTransportVersion,
          proofDomain: uniqueDomains.length === 1 ? uniqueDomains[0] : "partitioned",
          proofDomains: uniqueDomains,
          maestroCertified: false,
          reactTreeProof: {
            nativeInteractionFidelity: false,
            covers: ["exact-react-identity", "controlled-fiber-text-readback"],
            excludes: ["ime-composition", "password-autofill", "keyboard-occlusion"]
          },
          steps: combinedSteps,
          output: nativeOutput.slice(0, 2e3),
          timedOut: false,
          outputTruncated: nativeOutput.length > 2e3
        });
      } catch (error) {
        const failure = error instanceof MaestroStageExecutionError ? error.stageError : error;
        if (error instanceof MaestroStageExecutionError) {
          for (const completed of error.completedResults) {
            if (!completed || typeof completed !== "object" || !("replay" in completed))
              continue;
            const result = completed;
            if (!result.replay || !Array.isArray(result.replay.steps))
              continue;
            const sourceIndices = result.sourceIndices ?? [];
            for (const step of result.replay.steps) {
              if (!step || typeof step !== "object")
                continue;
              const record = step;
              combinedSteps.push({
                index: sourceIndices[record.sourceIndex ?? -1] ?? record.sourceIndex ?? combinedSteps.length,
                name: String(record.t ?? "unknown"),
                verb: String(record.t ?? "unknown"),
                ...record.target !== void 0 ? { target: String(record.target) } : {},
                ...record.focusOnly === true ? { focusOnly: true } : {},
                status: record.ok === false ? "fail" : "pass",
                durationMs: Number(record.durationMs ?? 0)
              });
            }
          }
        }
        if (failure instanceof ReactReplayFailure) {
          const replay = failure.replay;
          const failedStepIndex = replay.failedStepIndex === void 0 ? void 0 : failure.sourceIndices[replay.failedStepIndex] ?? replay.failedStepIndex;
          for (const step of replay.steps) {
            combinedSteps.push({
              index: failure.sourceIndices[step.sourceIndex] ?? step.sourceIndex,
              name: step.t,
              verb: step.t,
              ...step.focusOnly ? { focusOnly: true } : {},
              status: step.ok ? "pass" : "fail",
              durationMs: step.durationMs
            });
          }
          const uniqueProofDomains = [...new Set(proofDomains)];
          const proofDomain = uniqueProofDomains.length === 1 ? uniqueProofDomains.at(0) ?? "partitioned" : "partitioned";
          return failResult(`React-tree replay failed at step ${String(failedStepIndex)}: ${replay.reason ?? "unknown failure"}`, replay.failureCode ?? "ASSERTION_FAILED", {
            ...replay.failureMeta,
            proofDomain,
            proofDomains: uniqueProofDomains,
            failedProofDomain: "react-tree",
            ...proofDomain === "partitioned" ? { runner: "partitioned", transport: "partitioned" } : {},
            steps: combinedSteps,
            failedStepIndex
          });
        }
        if (failure instanceof SessionAuthorityError)
          throw failure;
        return failResult(failure instanceof Error ? failure.message : String(failure), controller.signal.aborted ? "RUNNER_TIMEOUT" : void 0, { proofDomains });
      } finally {
        clearTimeout(deadlineTimer);
      }
    }
    writeFileSync6(flowFile, validatedContent, "utf-8");
    const dispatch = selectDispatch({ platform, flowHasHideKeyboard });
    if ("error" in dispatch) {
      return failResult(dispatch.error);
    }
    const timeout = args.timeoutMs ?? 12e4;
    const flowDeadline = now() + timeout;
    const appFileResolution = resolveAppFileForClearState(platform, validatedContent, headerAppId, args.appFile, { deviceId: requestedDeviceId });
    if (!appFileResolution.ok) {
      return failResult(appFileResolution.error);
    }
    const reinstallsApp = Boolean(appFileResolution.appFile) && flowUsesClearState(validatedContent);
    const reissueInstallReceipt = args.reissueInstallReceipt ?? deps.reissueInstallReceipt ?? nestedMaestroAuthorityCallbacks(args).reissueInstallReceipt;
    let installReceiptCommitted = false;
    const commitReinstalledInstall = async () => {
      if (!reinstallsApp || installReceiptCommitted || !reissueInstallReceipt)
        return;
      installReceiptCommitted = true;
      await reissueInstallReceipt();
    };
    const baseArgs = dispatch.buildArgs(platform, flowFile, appFileResolution.appFile, requestedDeviceId);
    const paramArgs = [];
    if (args.params) {
      for (const [key, value] of Object.entries(args.params)) {
        paramArgs.push("-e", `${key}=${value}`);
      }
    }
    const releaseAndroidSlot = deps.releaseAndroidSlot ?? releaseAndroidInteractionSlot;
    const androidSlotReleaseWarnings = [];
    let releasedAndroidDeviceId;
    let uiAutomationRecoveryAttempted = false;
    let uiAutomationRecoveryRetried = false;
    const recordAndroidRelease = (outcome) => {
      if (outcome?.deviceId)
        releasedAndroidDeviceId = outcome.deviceId;
      if (outcome?.warnings?.length)
        androidSlotReleaseWarnings.push(...outcome.warnings);
    };
    const androidReleaseMeta = () => ({
      ...androidSlotReleaseWarnings.length > 0 ? { androidSlotReleaseWarnings: [...androidSlotReleaseWarnings] } : {},
      ...uiAutomationRecoveryAttempted ? {
        androidUiAutomationRecovery: {
          retried: uiAutomationRecoveryRetried,
          retryCount: uiAutomationRecoveryRetried ? 1 : 0
        }
      } : {}
    });
    const androidReleaseCaveat = () => androidSlotReleaseWarnings.length > 0 ? `Android interaction-slot release warnings: ${androidSlotReleaseWarnings.join("; ")}` : void 0;
    const engineStatus = dispatch.runner === "maestro-runner" ? await resolveEngineStatus() : null;
    const pinCaveat = engineStatus ? enginePinCaveat(engineStatus) : null;
    const exactRefusal = exactPinRefusal(engineStatus);
    if (exactRefusal) {
      return failResult(exactRefusal, "ENGINE_PIN_MISMATCH", {
        pin: engineStatus?.pin,
        installedVersion: engineStatus?.version ?? null,
        selectedPath: engineStatus?.selectedPath ?? null,
        provenance: engineStatus?.provenance ?? "none"
      });
    }
    const learnedAction = Boolean(capturedAction || args.actionMetadata);
    const actionMeta = semanticActionMeta;
    const compatibilityRefusal = learnedAction || actionMeta !== null ? actionReplayPreflight({
      enginePin: actionMeta?.enginePin,
      commands: validatedCommands,
      engineStatus
    }) : replayCompatibilityPreflight({
      commands: validatedCommands,
      engineStatus,
      requireEnginePin: false
    });
    if (compatibilityRefusal) {
      return failResult(compatibilityRefusal, "ENGINE_PIN_MISMATCH", {
        pin: engineStatus?.pin,
        installedVersion: engineStatus?.version ?? null,
        selectedPath: engineStatus?.selectedPath ?? null,
        provenance: engineStatus?.provenance ?? "none"
      });
    }
    let probedAndroidApiLevel = null;
    if (platform === "android" && dispatch.runner === "maestro-runner" && requestedDeviceId) {
      const apiLevel = await probeApiLevel(requestedDeviceId).catch(() => null);
      probedAndroidApiLevel = apiLevel;
      const apiRefusal = apiLevel === null ? null : preOAndroidApiRefusal(apiLevel);
      if (apiRefusal) {
        return failResult(apiRefusal, "ANDROID_API_UNSUPPORTED", {
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          passed: false,
          androidApiLevel: apiLevel
        });
      }
    }
    const nativeSelectors = platform === "ios" ? nativeSelectorsForCommands(validatedCommands) : [];
    const flowAbort = new AbortController();
    const flowAbortTimer = setTimeout(() => flowAbort.abort(new Error("Maestro flow deadline exceeded")), Math.max(1, flowDeadline - now()));
    let runnerReportDir;
    try {
      runnerReportDir = (deps.createReportDir ?? createRunnerReportDir)(dispatch.runner, "rn-maestro-report");
    } catch (error) {
      clearTimeout(flowAbortTimer);
      throw error;
    }
    const finalArgs = assembleMaestroArgs(baseArgs, [
      ...runnerReportArgs(runnerReportDir),
      ...paramArgs
    ]);
    const directRunnerEvidence = (output) => collectDirectRunnerEvidence(runnerReportDir, output);
    let nativeOriginPreclaimed = false;
    let deferredNativeOriginTarget = false;
    let completePreclaimedOrigin = null;
    const ledgerAttempt = args.attempt ?? {
      attemptId: randomUUID(),
      ordinal: 1,
      maxAttempts: 1,
      kind: "initial"
    };
    const authorityPlan = planMaestroAuthorityStages(validatedCommands);
    const plannedStageMeta = (() => {
      let cursor = 0;
      return authorityPlan.stages.map((stage) => {
        const sourceIndices = stage.commands.map((_, i) => cursor + i);
        cursor += stage.commands.length;
        return { sourceIndices, requiresOrigin: stage.requiresOrigin };
      });
    })();
    const stageCaptures = [];
    let ledgerStageCursor = 0;
    const stageTerminationFromError = (error) => {
      const errorClass = classifyExecError(error);
      const raw = error;
      return {
        exitCode: typeof raw?.code === "number" ? raw.code : null,
        signal: typeof raw?.signal === "string" ? raw.signal : null,
        timedOut: errorClass.timedOut,
        outputTruncated: errorClass.outputTruncated,
        bootstrapFailure: error instanceof RunnerCacheUnavailableError,
        transportFailure: isPreSpawnMaestroError(error)
      };
    };
    const buildAttemptLedger = () => buildMaestroRunLedger({
      attempt: ledgerAttempt,
      sourceText: validatedContent,
      commands: validatedCommands,
      stages: plannedStageMeta.map((meta, index) => stageCaptures[index] ?? {
        sourceIndices: meta.sourceIndices,
        requiresOrigin: meta.requiresOrigin,
        invocation: null
      })
    });
    try {
      const managedAuthority = nestedMaestroAuthorityCallbacks(args);
      const claimOrigin = args.claimNativeOrigin ?? deps.claimNativeOrigin ?? managedAuthority.claimNativeOrigin;
      const completeOrigin = args.completeNativeOrigin ?? deps.completeNativeOrigin ?? managedAuthority.completeNativeOrigin;
      const relaunchManagedApp = args.relaunchManagedApp ?? deps.relaunchManagedApp ?? managedAuthority.relaunchManagedApp;
      const reproveManagedOrigin = args.reproveManagedOrigin ?? deps.reproveManagedOrigin ?? managedAuthority.reproveManagedOrigin;
      if (platform === "ios" && authorityPlan.stages[0]?.requiresOrigin) {
        await claimOrigin();
        nativeOriginPreclaimed = true;
      }
      const completeTrackedOrigin = async (targetExpected, signal) => {
        if (platform === "ios" && targetExpected) {
          deferredNativeOriginTarget = true;
          return;
        }
        await completeOrigin(targetExpected, signal);
        nativeOriginPreclaimed = false;
      };
      completePreclaimedOrigin = completeTrackedOrigin;
      const stageResults = await parkFlow(() => executeMaestroAuthorityStages(validatedCommands, async (commands) => {
        const ledgerStageIndex = ledgerStageCursor++;
        const preFingerprint = runnerReportFingerprint(runnerReportDir);
        let failedInvocationTermination = null;
        const captureStageInvocation = (termination) => {
          const meta2 = plannedStageMeta[ledgerStageIndex];
          stageCaptures[ledgerStageIndex] = {
            sourceIndices: meta2?.sourceIndices ?? [],
            requiresOrigin: meta2?.requiresOrigin ?? true,
            invocation: {
              termination,
              // The pre-invocation fingerprint lets the reader refuse
              // leftover or mixed-generation evidence for this stage.
              artifact: readStructuredFlowArtifact(runnerReportDir, preFingerprint)
            }
          };
        };
        try {
          const stageResult = await (async () => {
            writeFileSync6(flowFile, buildMaestroFlow(headerAppId ? { appId: headerAppId } : {}, [...commands]), "utf-8");
            const executeOnce = async (beforeDispatch) => {
              if (flowDeadline - now() <= 0) {
                const error = new Error("Maestro flow timeout exhausted before the next stage");
                Object.assign(error, { code: "ETIMEDOUT" });
                throw error;
              }
              const executeRunner = (runnerPath, prefixArgs = []) => {
                beforeDispatch?.();
                const remainingTimeout = flowDeadline - now();
                if (remainingTimeout <= 0) {
                  const error = new Error("Maestro flow timeout exhausted before runner execution");
                  Object.assign(error, { code: "ETIMEDOUT" });
                  throw error;
                }
                return execute(runnerPath, [...prefixArgs, ...finalArgs], {
                  timeout: remainingTimeout,
                  encoding: "utf8",
                  maxBuffer: 10 * 1024 * 1024,
                  signal: flowAbort.signal
                });
              };
              if (deps.execFile) {
                const immediateStatus = await resolveEngineStatus();
                const refusal = exactPinRefusal(immediateStatus);
                const immediateRefusal = refusal ? `RUNNER_PIN_CHANGED: ${refusal}` : null;
                if (immediateRefusal)
                  throw new Error(immediateRefusal);
                return executeRunner(dispatch.binPath);
              }
              return withImmediatePinnedRunner(dispatch.binPath, resolveEngineStatus, executeRunner, platform);
            };
            try {
              return await executeOnce();
            } catch (error) {
              const initialFailureTermination = stageTerminationFromError(error);
              const recoveryDeviceId = requestedDeviceId ?? releasedAndroidDeviceId;
              if (platform !== "android" || uiAutomationRecoveryAttempted || !recoveryDeviceId || !isUiAutomationNotConnectedSessionCreationFailure(error)) {
                failedInvocationTermination = initialFailureTermination;
                throw error;
              }
              uiAutomationRecoveryAttempted = true;
              const recoveryTimeout = flowDeadline - now();
              if (recoveryTimeout <= 0) {
                androidSlotReleaseWarnings.push("UiAutomation recovery skipped: Maestro flow timeout was exhausted");
                failedInvocationTermination = initialFailureTermination;
                throw error;
              }
              const recoveryAbort = new AbortController();
              const recoveryDeadlineTimer = setTimeout(() => {
                recoveryAbort.abort(new Error("UiAutomation recovery cleanup exceeded the remaining Maestro flow timeout"));
              }, recoveryTimeout);
              try {
                recordAndroidRelease(await releaseAndroidSlot({
                  deviceId: recoveryDeviceId,
                  includeLegacy: false,
                  signal: recoveryAbort.signal
                }));
              } catch (releaseError) {
                androidSlotReleaseWarnings.push(`UiAutomation recovery release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
                failedInvocationTermination = {
                  ...initialFailureTermination,
                  transportFailure: true
                };
                throw attachCause(error, releaseError);
              } finally {
                clearTimeout(recoveryDeadlineTimer);
              }
              try {
                return await executeOnce(() => {
                  uiAutomationRecoveryRetried = true;
                });
              } catch (retryError) {
                const retryFailureTermination = stageTerminationFromError(retryError);
                if (uiAutomationRecoveryRetried && !isPreSpawnMaestroError(retryError)) {
                  failedInvocationTermination = retryFailureTermination;
                  throw retryError;
                }
                uiAutomationRecoveryRetried = false;
                androidSlotReleaseWarnings.push(`UiAutomation recovery retry did not start: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
                failedInvocationTermination = retryFailureTermination;
                throw attachCause(error, retryError);
              }
            }
          })();
          captureStageInvocation({
            exitCode: 0,
            signal: null,
            timedOut: false,
            outputTruncated: false,
            bootstrapFailure: false,
            transportFailure: false
          });
          return stageResult;
        } catch (stageInvocationError) {
          captureStageInvocation(failedInvocationTermination ?? stageTerminationFromError(stageInvocationError));
          throw stageInvocationError;
        }
      }, claimOrigin, completeTrackedOrigin, relaunchManagedApp, reproveManagedOrigin, { firstOriginClaimed: nativeOriginPreclaimed, signal: flowAbort.signal }), {
        platform,
        deviceId: requestedDeviceId,
        releaseAndroidSlot,
        onAndroidRelease: recordAndroidRelease,
        stopFastRunner: deps.stopFastRunner,
        completeRunnerPark: args.completeRunnerPark ?? managedAuthority.completeRunnerPark,
        signal: flowAbort.signal
      });
      if (deferredNativeOriginTarget) {
        if (nativeOriginPreclaimed && (args.reproveManagedOrigin || deps.reproveManagedOrigin || replayFactory && hasManagedNativeOriginAuthority(args))) {
          await reproveManagedOrigin({
            signal: flowAbort.signal,
            readinessTimeoutMs: Math.max(1, flowDeadline - now())
          });
        }
        await completeOrigin(true, flowAbort.signal);
        nativeOriginPreclaimed = false;
      }
      await commitReinstalledInstall();
      const stdout = stageResults.map((result) => result.stdout).join("\n");
      const stderr = stageResults.map((result) => result.stderr).join("\n");
      const output = combineRunnerOutput(stdout, stderr);
      const passed = !outputIndicatesFlowFailure(output);
      const directEvidence = directRunnerEvidence(output);
      const deviceAuthority = verifyMaestroDeviceAuthority({
        runner: dispatch.runner,
        platform,
        requestedDeviceId,
        output: directEvidence.output,
        directReportDeviceIds: directEvidence.reportDeviceIds,
        directReportIdentityStrength: directEvidence.reportDeviceIdStrength,
        requireWdaProvenance: passed
      });
      const authorityRefusal = maestroAuthorityRefusal(deviceAuthority);
      if (authorityRefusal) {
        return failResult(authorityRefusal, "DEVICE_AUTHORITY_MISMATCH", {
          flowFile,
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          passed: false,
          deviceAuthority,
          output: output.slice(0, 4e3),
          ...androidReleaseMeta()
        });
      }
      const summary = buildStepSummary(output, { failed: !passed });
      const runnerResume = !passed ? await buildRunnerResume(platform, fastHealthCheck2) : void 0;
      const meta = {
        passed,
        flowFile,
        platform,
        runner: dispatch.runner,
        transport: dispatch.runner,
        proofDomain: "xctest-native",
        transportVersion: engineStatus?.version ?? null,
        fallback: dispatch.fallbackReason ? dispatch.runner : "none",
        deviceAuthority,
        output: output.slice(0, 2e3),
        ...summary,
        ...!passed ? { terminal: buildTerminalEvidence(output), ...runnerResume ? { runnerResume } : {} } : {},
        timedOut: false,
        outputTruncated: false,
        ...dispatch.fallbackReason ? { fallbackReason: dispatch.fallbackReason } : {},
        ...dispatch.degradedReason ? { degradedReason: dispatch.degradedReason } : {},
        ...engineStatus && engineStatus.pin.status !== "pinned-ok" ? { enginePin: engineStatus.pin } : {},
        ...androidReleaseMeta()
      };
      const caveat = dispatch.fallbackReason ?? dispatch.degradedReason ?? pinCaveat ?? void 0;
      const releaseCaveat = androidReleaseCaveat();
      if (passed) {
        const warnCaveat = caveat && shouldWarnFallback(caveat) ? caveat : void 0;
        if (releaseCaveat) {
          return warnResult(meta, warnCaveat ? `${warnCaveat}; ${releaseCaveat}` : releaseCaveat);
        }
        if (warnCaveat) {
          return warnResult(meta, warnCaveat);
        }
        return okResult(meta);
      }
      const baseWarnMsg = [caveat, releaseCaveat, "Flow completed with warnings or failures"].filter((part) => Boolean(part)).join("; ");
      const warnLedger = buildAttemptLedger();
      const warnTrailingVerification = classifyTrailingVerification(warnLedger);
      const warnAug = augmentFailureWithDegradation(output, resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS), baseWarnMsg, {
        ...meta,
        ledger: warnLedger,
        ...warnTrailingVerification ? { trailingVerification: warnTrailingVerification } : {}
      }, { trailingVerification: warnTrailingVerification });
      return warnResult(warnAug.meta, warnAug.message);
    } catch (err) {
      const stageError = err instanceof MaestroStageExecutionError ? err.stageError : err;
      const errorClass = classifyExecError(stageError);
      const processTerminationVeto = stageCaptures.some((capture) => {
        const termination = capture.invocation?.termination;
        if (!termination)
          return false;
        return termination.timedOut || termination.signal !== null || termination.outputTruncated || termination.bootstrapFailure || termination.transportFailure;
      });
      if (nativeOriginPreclaimed && completePreclaimedOrigin) {
        try {
          await completePreclaimedOrigin(false);
        } catch (cleanupError) {
          return failResult(`Native replay cleanup could not settle the managed runtime after ${stageError instanceof Error ? stageError.message : String(stageError)}.`, "AUTOMATION_CLEANUP_UNPROVEN", {
            platform,
            proofDomain: "xctest-native",
            runner: dispatch.runner,
            cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      }
      if (stageError instanceof RunnerCacheUnavailableError) {
        recordRunnerDiagnostic("typed-failure", {
          code: stageError.code,
          errno: stageError.errno,
          path: stageError.relativePath
        });
        return failResult(runnerCacheBootstrapFailure(stageError), "WDA_BOOTSTRAP_FAILED", {
          flowFile,
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          proofDomain: "xctest-native",
          passed: false,
          output: "",
          terminal: {
            exitClass: "before-first-step",
            bootstrapEvidence: stageError.message
          },
          ...androidReleaseMeta()
        });
      }
      await commitReinstalledInstall();
      if (err instanceof SessionAuthorityError) {
        err.attachMeta(androidReleaseMeta());
        throw err;
      }
      const msg2 = stageError instanceof Error ? stageError.message : String(stageError);
      if (stageError instanceof ExactAndroidDeviceRequiredError) {
        return failResult(stageError.message, stageError.code, {
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          passed: false,
          ...androidReleaseMeta()
        });
      }
      const errAny = stageError;
      const completed = err instanceof MaestroStageExecutionError ? err.completedResults : [];
      const stdout = [
        ...completed.map((result) => typeof result.stdout === "string" ? result.stdout : ""),
        typeof errAny?.stdout === "string" ? errAny.stdout : ""
      ].join("\n");
      const stderr = [
        ...completed.map((result) => typeof result.stderr === "string" ? result.stderr : ""),
        typeof errAny?.stderr === "string" ? errAny.stderr : ""
      ].join("\n");
      const combined = combineRunnerOutput(stdout, stderr);
      const apiLevelAllowsPreO = probedAndroidApiLevel === null || probedAndroidApiLevel < MAESTRO_RUNNER_MIN_ANDROID_API;
      if (platform === "android" && apiLevelAllowsPreO && isOlderSdkInstallFailure(combined)) {
        return failResult(olderSdkInstallDiagnosis(dispatch.runner), "ANDROID_API_UNSUPPORTED", {
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          passed: false,
          output: combined.slice(0, 4e3),
          ...androidReleaseMeta()
        });
      }
      let timedOut = errorClass.timedOut || flowAbort.signal.aborted;
      const { outputTruncated } = errorClass;
      const directEvidence = directRunnerEvidence(combined);
      const deviceAuthority = verifyMaestroDeviceAuthority({
        runner: dispatch.runner,
        platform,
        requestedDeviceId,
        output: directEvidence.output,
        directReportDeviceIds: directEvidence.reportDeviceIds,
        directReportIdentityStrength: directEvidence.reportDeviceIdStrength
      });
      const summary = buildStepSummary(combined, { failed: true });
      const spawnError = combined.length === 0 && isPreSpawnMaestroError(stageError);
      let terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
      const runnerResume = await buildRunnerResume(platform, fastHealthCheck2);
      if (flowAbort.signal.aborted || now() >= flowDeadline) {
        timedOut = true;
        terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
      }
      const catchRefusal = combined.length > 0 ? maestroAuthorityRefusal(deviceAuthority, msg2) : null;
      if (catchRefusal) {
        return failResult(catchRefusal, "DEVICE_AUTHORITY_MISMATCH", {
          flowFile,
          platform,
          runner: dispatch.runner,
          transport: dispatch.runner,
          passed: false,
          deviceAuthority,
          output: combined.slice(0, 4e3),
          ...summary,
          terminal,
          ...runnerResume ? { runnerResume } : {},
          timedOut,
          outputTruncated,
          ...androidReleaseMeta()
        });
      }
      const nativeFailure = parseMaestroFailure(combined, terminal);
      if (nativeFailure.kind === "TIMEOUT" && !timedOut) {
        timedOut = true;
        terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
      }
      const soleNativeSelector = soleComparableNativeSelectorForCommands(validatedCommands)?.value;
      const selectorLessAssertionFailure = nativeFailure.kind === "UNKNOWN" && terminal.exitClass === "step-failure" && terminal.failedStep?.split(/\s+/, 1)[0] === "assertVisible";
      const failedNativeSelector = nativeFailure.kind === "SELECTOR_NOT_FOUND" ? nativeFailure.selector ?? soleNativeSelector : nativeFailure.kind === "ASSERTION_FAILED" ? nativeFailure.selector ?? soleNativeSelector : nativeFailure.kind === "TIMEOUT" ? nativeFailure.selector : selectorLessAssertionFailure ? soleNativeSelector : null;
      const comparableNativeSelector = nativeSelectors.find((selector) => selector.value === failedNativeSelector);
      let nativeVisionEvidence = null;
      let nativeVisionAttempted = false;
      if (requestedDeviceId && comparableNativeSelector && deps.nativeVisionProbe && !timedOut && !flowAbort.signal.aborted) {
        nativeVisionAttempted = true;
        nativeVisionEvidence = await deps.nativeVisionProbe({
          deviceId: requestedDeviceId,
          selectors: [comparableNativeSelector],
          signal: flowAbort.signal
        }).catch(() => null);
        if (flowAbort.signal.aborted || now() >= flowDeadline) {
          timedOut = true;
          terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
          nativeVisionEvidence = null;
        }
      }
      if (nativeVisionAttempted) {
        try {
          await stopFastRunner2(requestedDeviceId, flowAbort.signal);
          await (args.completeRunnerPark ?? nestedMaestroAuthorityCallbacks(args).completeRunnerPark)(flowAbort.signal);
        } catch {
          return failResult("Native replay cleanup could not settle the failure-screen comparison runner.", "AUTOMATION_CLEANUP_UNPROVEN", {
            platform,
            proofDomain: "xctest-native",
            runner: dispatch.runner,
            cleanup: {
              cleanupProven: false,
              wdaProcessSettled: true,
              runnerParkCommitted: false,
              managedOriginSettled: !nativeOriginPreclaimed
            }
          });
        }
      }
      if (flowAbort.signal.aborted || now() >= flowDeadline) {
        timedOut = true;
        terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
        nativeVisionEvidence = null;
      }
      const fastRunnerSawFailedSelector = failedNativeSelector !== null && nativeVisionEvidence?.visibleSelectors.some((selector) => selector.value === failedNativeSelector) === true;
      if (fastRunnerSawFailedSelector) {
        const selectorKind = nativeVisionEvidence.visibleSelectors.find((selector) => selector.value === failedNativeSelector).kind;
        return failResult("XCTest/WDA could not resolve a native-only selector that the bounded native snapshot saw on the failure screen. This is a blind native surface, not an ordinary selector miss. Use a WDA-healthy simulator/runtime for the native step, then retry; exact React testID steps should remain on cdp_run_action.", "NATIVE_SURFACE_BLIND", {
          platform,
          proofDomain: "xctest-native",
          runner: dispatch.runner,
          transportVersion: engineStatus?.version ?? null,
          nativeVision: {
            source: nativeVisionEvidence.source,
            nodeCount: nativeVisionEvidence.nodeCount,
            visibleSelectorCount: nativeVisionEvidence.visibleSelectors.length,
            failedSelectorKind: selectorKind,
            runtimeMajor: nativeVisionEvidence.runtimeMajor,
            runtimeVersionHeuristicIsProof: false
          },
          deviceAuthority,
          cleanup: {
            cleanupProven: true,
            wdaProcessSettled: true,
            runnerParkCommitted: true,
            managedOriginSettled: !nativeOriginPreclaimed,
            fastRunnerHealthy: runnerResume?.healthy ?? null
          },
          nextAction: "Run the doctor compatibility report and the central native WDA smoke on a WDA-healthy runtime, then retry this native-only step."
        });
      }
      const rawHeadline = formatFailureHeadline(summary, { timedOut, outputTruncated }, msg2);
      const releaseCaveat = androidReleaseCaveat();
      const headline = releaseCaveat ? `${rawHeadline}; ${releaseCaveat}` : rawHeadline;
      const failLedger = buildAttemptLedger();
      const failTrailingVerification = processTerminationVeto ? null : classifyTrailingVerification(failLedger);
      const failAug = augmentFailureWithDegradation(combined, resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS), headline, {
        ledger: failLedger,
        ...failTrailingVerification ? { trailingVerification: failTrailingVerification } : {},
        flowFile,
        platform,
        runner: dispatch.runner,
        transport: dispatch.runner,
        proofDomain: "xctest-native",
        transportVersion: engineStatus?.version ?? null,
        fallback: dispatch.fallbackReason ? dispatch.runner : "none",
        deviceAuthority,
        passed: false,
        // `output` mirrors the success/warn shape so callers can read
        // it the same way regardless of which path they hit.
        output: combined.slice(0, 4e3),
        ...summary,
        terminal,
        ...runnerResume ? { runnerResume } : {},
        timedOut,
        outputTruncated,
        // GH #397: a drifted/mismatched engine causing a real failure is
        // exactly when the pin state matters — carry it on this path too.
        ...engineStatus && engineStatus.pin.status !== "pinned-ok" ? { enginePin: engineStatus.pin } : {},
        ...androidReleaseMeta()
      }, { trailingVerification: failTrailingVerification });
      return failResult(failAug.message, failAug.meta);
    } finally {
      clearTimeout(flowAbortTimer);
      try {
        writeFileSync6(flowFile, validatedContent, "utf-8");
      } finally {
        disposeRunnerReportDir(runnerReportDir);
      }
    }
  };
}

// packages/rn-dev-agent-core/dist/maestro-runner-pin.js
var USAGE = "usage: maestro-runner-pin [diagnose|install|migrate-actions|verify-actions] [--json] [--root <app>]";
function ensureScriptPath() {
  const here = dirname15(fileURLToPath2(import.meta.url));
  const candidates = [
    join24(here, "..", "..", "..", "scripts", "ensure-maestro-runner.sh"),
    join24(here, "..", "scripts", "ensure-maestro-runner.sh"),
    join24(here, "..", "..", "scripts", "ensure-maestro-runner.sh")
  ];
  return candidates.find((path) => existsSync18(path)) ?? candidates[0];
}
async function diagnose(json2) {
  _resetEngineStatusForTest();
  const status = await getEngineStatus();
  const report = doctorPinnedRunner(status, nodePlatformKey());
  const runtimeProbe = spawnSync3("xcrun", ["simctl", "list", "devices", "--json"], {
    encoding: "utf8",
    timeout: 5e3
  });
  let bootedIosRuntimeMajors = null;
  if (runtimeProbe.status === 0) {
    try {
      const parsed = JSON.parse(runtimeProbe.stdout);
      bootedIosRuntimeMajors = Object.entries(parsed.devices ?? {}).filter(([, devices]) => Array.isArray(devices) && devices.some((device) => device?.state === "Booted")).map(([runtime]) => Number(runtime.match(/SimRuntime\.iOS-(\d+)/)?.[1])).filter((major) => Number.isSafeInteger(major));
    } catch {
      bootedIosRuntimeMajors = null;
    }
  }
  const wdaNativeCompatibility = {
    status: bootedIosRuntimeMajors === null ? "unknown" : bootedIosRuntimeMajors.length === 0 ? "not-applicable" : "native-smoke-required",
    bootedRuntimeMajors: bootedIosRuntimeMajors,
    runtimeVersionHeuristicIsProof: false,
    detail: "Runtime version alone never proves WDA blindness. A bounded native-selector comparison distinguishes NATIVE_SURFACE_BLIND from an ordinary selector miss.",
    nextAction: "Run the central native WDA smoke on the target runtime; exact React testIDs use the react-tree proof domain."
  };
  if (json2) {
    console.log(JSON.stringify({ ...report, pin: MAESTRO_RUNNER_PIN.version, wdaNativeCompatibility }, null, 2));
  } else {
    console.log(report.ok ? `maestro-runner ${report.installedVersion} pinned-ok (${report.provenance}: ${report.selectedPath})` : `maestro-runner pin ${report.status}: ${report.correction}`);
    console.log(`iOS proof policy: exact testID=${report.iosProofPolicy.exactTestId}; native=${report.iosProofPolicy.nativeSurface}; WDA compatibility=${wdaNativeCompatibility.status} (runtime heuristic is not proof)`);
  }
  return report.ok ? 0 : 1;
}
function install() {
  const script = ensureScriptPath();
  const result = spawnSync3("bash", [script], { stdio: "inherit" });
  return result.status === 0 ? 0 : 1;
}
function migrate(root2, json2) {
  const results = migrateLearnedActions(root2);
  const failed = results.filter((r) => r.status === "incompatible" || r.status === "unreadable");
  if (json2) {
    console.log(JSON.stringify({ root: root2, results }, null, 2));
  } else {
    for (const row of results) {
      console.log(`${row.status}	${row.id}${row.reason ? `	${row.reason}` : ""}`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}
async function verifyActions(argv) {
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : void 0;
  };
  const platform = valueAfter("--platform");
  const flowDirArg = valueAfter("--flow-dir");
  const pattern = valueAfter("--pattern");
  const timeout = Number(valueAfter("--timeout") ?? "120000");
  const stopOnFailure = argv.includes("--stop-on-failure");
  if (platform !== "ios" && platform !== "android" || !flowDirArg) {
    console.error("verify-actions requires --platform ios|android and --flow-dir <directory>");
    return 2;
  }
  if (!Number.isInteger(timeout) || timeout < 5e3 || timeout > 3e5) {
    console.error("verify-actions --timeout must be an integer from 5000 to 300000");
    return 2;
  }
  if (pattern) {
    if (pattern.length > 256) {
      console.error("verify-actions --pattern must be at most 256 characters");
      return 2;
    }
  }
  const flowDir = resolve8(flowDirArg);
  const flowDirClassification = classifyLearnedActionPath(join24(flowDir, "__action__.yaml"));
  if (flowDirClassification !== "action") {
    console.error(`Refusing to execute flows outside an owned .rn-agent/actions corpus: ${flowDir}.`);
    return 2;
  }
  _resetEngineStatusForTest();
  const engineStatus = await getEngineStatus();
  const pinRefusal = exactPinRefusal(engineStatus);
  if (pinRefusal) {
    console.error(pinRefusal);
    return 2;
  }
  let files;
  let actionContext;
  try {
    const openedContext = openReadableActionLoadContext(dirname15(dirname15(flowDir)), {
      includeRunFlowFiles: true
    });
    if (!openedContext)
      throw new Error(`No learned-action corpus found at ${flowDir}`);
    actionContext = openedContext;
    const yamlFiles = actionContext.files.filter((file) => /\.ya?ml$/i.test(file));
    const filtered = pattern ? await filterWithBoundedRegex(yamlFiles, pattern) : { ok: true, matches: yamlFiles };
    if (!filtered.ok) {
      console.error(`verify-actions pattern is ${filtered.reason}: ${filtered.message}`);
      return 2;
    }
    files = filtered.matches.map((file) => join24(flowDir, file)).sort();
  } catch (err) {
    console.error(`verify-actions could not read ${flowDir}: ${String(err)}`);
    return 2;
  }
  if (files.length === 0) {
    console.error(`No Maestro flows found in ${flowDir}`);
    return 2;
  }
  const suite = prepareActionVerificationSuite(files, flowDir, engineStatus, actionContext);
  if (suite.errors.length > 0) {
    console.error(`Suite preflight refused ${suite.errors.length} of ${files.length} flows before execution.`);
    for (const row of suite.errors)
      console.error(`  FAIL  ${row.file}: ${row.error}`);
    return 1;
  }
  console.log("rn-verify \u2014 Maestro E2E Regression Suite");
  console.log(`Platform:  ${platform}`);
  console.log(`Flow dir:  ${flowDir}`);
  console.log(`Flows:     ${files.length}`);
  console.log(`Timeout:   ${timeout}ms per flow`);
  const run = createMaestroRunHandler();
  let passed = 0;
  let failed = 0;
  for (const flow of suite.prepared) {
    const startedAt = Date.now();
    const result = await run({
      platform,
      inlineYaml: flow.inlineYaml,
      actionMetadata: flow.actionMetadata,
      timeoutMs: timeout
    });
    const envelope = JSON.parse(result.content[0].text);
    const ok = envelope.ok && envelope.data?.passed !== false;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${flow.file.split("/").pop()}  (${Date.now() - startedAt}ms)`);
    if (ok)
      passed += 1;
    else {
      failed += 1;
      if (envelope.error)
        console.error(`    ${envelope.error}`);
      if (stopOnFailure)
        break;
    }
  }
  console.log(`Results: ${passed} passed, ${failed} failed (${files.length} total)`);
  return failed === 0 ? 0 : 1;
}
function parseArgs(argv) {
  const json2 = argv.includes("--json");
  const rootIdx = argv.indexOf("--root");
  const root2 = rootIdx >= 0 ? argv[rootIdx + 1] ?? process.cwd() : process.cwd();
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--root");
  const cmd2 = positional[0] ?? "diagnose";
  return { cmd: cmd2, json: json2, root: root2 };
}
var { cmd, json, root } = parseArgs(process.argv.slice(2));
if (cmd === "diagnose") {
  process.exit(await diagnose(json));
} else if (cmd === "install") {
  process.exit(install());
} else if (cmd === "migrate-actions") {
  process.exit(migrate(root, json));
} else if (cmd === "verify-actions") {
  process.exit(await verifyActions(process.argv.slice(2)));
} else {
  console.error(USAGE);
  process.exit(2);
}
