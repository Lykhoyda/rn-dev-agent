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

// packages/rn-dev-agent-core/dist/session/declared-source-contract.js
function parseDeclaredManifests(value) {
  if (value === void 0)
    return void 0;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}
function missingDeclaredRootMessage() {
  return `NON_GIT_MANIFEST_REQUIRED: ${DECLARED_ROOT_ENV} is not set. ${NON_GIT_DECLARATION_NEXT_ACTION}`;
}
function missingDeclaredManifestListMessage() {
  return `NON_GIT_MANIFEST_REQUIRED: ${DECLARED_MANIFESTS_ENV} is not set. ${NON_GIT_DECLARATION_NEXT_ACTION}`;
}
function missingDeclaredManifestMessage(entry) {
  return `NON_GIT_MANIFEST_REQUIRED: declared manifest "${entry}" does not exist. ${NON_GIT_DECLARATION_NEXT_ACTION}`;
}
var DECLARED_ROOT_ENV, DECLARED_MANIFESTS_ENV, NON_GIT_DECLARATION_NEXT_ACTION;
var init_declared_source_contract = __esm({
  "packages/rn-dev-agent-core/dist/session/declared-source-contract.js"() {
    "use strict";
    DECLARED_ROOT_ENV = "RN_DEV_AGENT_DECLARED_ROOT";
    DECLARED_MANIFESTS_ENV = "RN_DEV_AGENT_DECLARED_MANIFESTS";
    NON_GIT_DECLARATION_NEXT_ACTION = `Declare the non-Git source explicitly: set ${DECLARED_ROOT_ENV} to the exact existing application root, and set ${DECLARED_MANIFESTS_ENV} to a comma-separated list of required existing manifest files inside that root, then restart the supervisor. Neither value is inferred from the working directory or generated.`;
  }
});

// packages/rn-dev-agent-core/dist/util/trusted-system-executable.js
import { existsSync } from "node:fs";
import { win32 } from "node:path";
function trustedWindowsRoots(environment) {
  return [
    ...new Set([environment.SystemRoot, environment.SYSTEMROOT, environment.windir, environment.WINDIR].filter((root) => typeof root === "string" && /^[a-z]:\\/i.test(root) && win32.basename(win32.normalize(root)).toLowerCase() === "windows").map((root) => win32.normalize(root)).concat("C:\\Windows"))
  ];
}
function resolveTrustedSystemExecutable(executable, platform, dependencies = {}) {
  const exists = dependencies.exists ?? existsSync;
  const environment = dependencies.environment ?? process.env;
  let candidates;
  if (platform === "win32" && executable === "powershell") {
    candidates = trustedWindowsRoots(environment).map((root) => win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  } else if (platform === "win32" && executable === "taskkill") {
    candidates = trustedWindowsRoots(environment).map((root) => win32.join(root, "System32", "taskkill.exe"));
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
async function withVerifiedDarwinProcessBirthHelper(callback) {
  return callback(verifyDarwinProcessBirthHelper({}));
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
var DARWIN_HELPER_MANIFEST, VERIFIED_HELPER_SCRIPT;
var init_process_birth = __esm({
  "packages/rn-dev-agent-core/dist/session/process-birth.js"() {
    "use strict";
    init_trusted_system_executable();
    DARWIN_HELPER_MANIFEST = {
      sourceSha256: "5cafc275ab929026203e64527f993cd77e2854f1697cdb419b7d901293e1bc48",
      recipeSha256: "a1293ae1f70a5da3a4ea9b1b79a095a5f182f7cb39e37521abe87cb1864f625b",
      stableBinarySha256: "e5dffbe66f7fa52f8e2554fb397b4b44000d8c092feff35e0c42f5f3e0150c3f",
      binarySha256: "dd8346dab2ccb6e3ce11840bbca5f8ea2f4cbd95efae34ddb130f98824a065aa",
      cdhashes: [
        "0471a3583ce2363ee96afe3e85951dd5fd154dec",
        "1998527647f4fef05eae6007fe7a1f945aa7c54d"
      ]
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

// packages/rn-dev-agent-core/dist/session/authority-store.js
import { chmodSync as chmodSync2, lstatSync as lstatSync2, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname as dirname2 } from "node:path";
function loadAuthoritySqlite() {
  try {
    const sqlite = require2("node:sqlite");
    return sqlite.DatabaseSync ?? null;
  } catch {
    return null;
  }
}
function assertPrivateDirectory(path) {
  mkdirSync(path, { mode: 448, recursive: true });
  const link = lstatSync2(path);
  if (link.isSymbolicLink() || !link.isDirectory()) {
    throw new Error("authority state root must be a real directory");
  }
  const stat = statSync(path);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("authority state root is not owned by the current user");
  }
  chmodSync2(path, 448);
}
function secureDatabaseFiles(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const link = lstatSync2(candidate);
      if (link.isSymbolicLink() || !link.isFile()) {
        throw new Error("authority database path is not a regular file");
      }
      const stat = statSync(candidate);
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error("authority database is not owned by the current user");
      }
      chmodSync2(candidate, 384);
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT")
        throw error;
    }
  }
}
function runInitialization(operation) {
  runWithBusyRetry(operation, INITIALIZATION_TIMEOUT_MS);
}
function runWithBusyRetry(operation, timeoutMs = DATABASE_OPERATION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    try {
      return operation();
    } catch (error) {
      const code = error.code;
      const message = error instanceof Error ? error.message : "";
      if (code !== "SQLITE_BUSY" && !/database is (?:locked|busy)/i.test(message))
        throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw error;
      Atomics.wait(INITIALIZATION_WAIT, 0, 0, Math.min(25, remaining));
    }
  }
}
function retryingDatabase(database) {
  return {
    close: () => database.close(),
    exec: (sql) => runWithBusyRetry(() => database.exec(sql)),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        get: (...params) => runWithBusyRetry(() => statement.get(...params)),
        run: (...params) => runWithBusyRetry(() => statement.run(...params)),
        all: (...params) => runWithBusyRetry(() => statement.all(...params))
      };
    }
  };
}
function openAuthorityStore(path, options = {}) {
  const ctor = options.sqliteCtor === void 0 ? loadAuthoritySqlite() : options.sqliteCtor;
  if (!ctor) {
    throw new AuthorityStoreUnavailableError("node:sqlite could not be loaded by this Node runtime");
  }
  let database = null;
  try {
    assertPrivateDirectory(dirname2(path));
    try {
      const existing = lstatSync2(path);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error("authority database path is not a regular file");
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
    }
    const rawDatabase = new ctor(path);
    const openedDatabase = retryingDatabase(rawDatabase);
    database = openedDatabase;
    secureDatabaseFiles(path);
    runInitialization(() => openedDatabase.exec(`
        PRAGMA busy_timeout=50;
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS authority_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO authority_meta(key, value)
        VALUES ('schema_version', '1')
        ON CONFLICT(key) DO NOTHING;
      `));
    secureDatabaseFiles(path);
    return {
      database: openedDatabase,
      secureFiles: () => secureDatabaseFiles(path),
      close: () => {
        let failure;
        try {
          secureDatabaseFiles(path);
        } catch (error) {
          failure = error;
        }
        try {
          openedDatabase.close();
        } catch (error) {
          failure ??= error;
        }
        try {
          secureDatabaseFiles(path);
        } catch (error) {
          failure ??= error;
        }
        if (failure)
          throw failure;
      }
    };
  } catch (cause) {
    try {
      database?.close();
    } catch {
    }
    throw new AuthorityStoreUnavailableError("authority registry could not be opened", { cause });
  }
}
var require2, INITIALIZATION_WAIT, INITIALIZATION_TIMEOUT_MS, DATABASE_OPERATION_TIMEOUT_MS, AuthorityStoreUnavailableError;
var init_authority_store = __esm({
  "packages/rn-dev-agent-core/dist/session/authority-store.js"() {
    "use strict";
    require2 = createRequire(import.meta.url);
    INITIALIZATION_WAIT = new Int32Array(new SharedArrayBuffer(4));
    INITIALIZATION_TIMEOUT_MS = 1e3;
    DATABASE_OPERATION_TIMEOUT_MS = 1e3;
    AuthorityStoreUnavailableError = class extends Error {
      code = "AUTHORITY_STORE_UNAVAILABLE";
      constructor(reason, options) {
        super(reason, options);
        this.name = "AuthorityStoreUnavailableError";
      }
    };
  }
});

// packages/rn-dev-agent-core/dist/session/cleanup-identity.js
function isPositiveSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isTcpPort(value) {
  return isPositiveSafeInteger(value) && value <= 65535;
}
function hasCompleteRunnerCleanupIdentity(binding) {
  const processBirth = String(binding.processBirth ?? "");
  const instanceId = String(binding.instanceId ?? "");
  const capability = String(binding.capability ?? "");
  if (!isPositiveSafeInteger(binding.pid) || !isTcpPort(binding.port) || !processBirth || !instanceId || !capability) {
    return false;
  }
  if (String(binding.platform ?? "") !== "android")
    return true;
  return Boolean(String(binding.deviceId ?? ""));
}
function hasCompleteRecorderCleanupIdentity(binding) {
  const script = String(binding.script ?? "");
  const scope = String(binding.scope ?? "");
  if (!script || !/^[a-f0-9]{64}$/.test(scope) || binding.port !== void 0 && !isTcpPort(binding.port)) {
    return false;
  }
  if (binding.phase === "starting")
    return true;
  return isPositiveSafeInteger(binding.pid) && Boolean(String(binding.processBirth ?? ""));
}
var init_cleanup_identity = __esm({
  "packages/rn-dev-agent-core/dist/session/cleanup-identity.js"() {
    "use strict";
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
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
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
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
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
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
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
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
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
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
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
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
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
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
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
        const { start, key, sep: sep2, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
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
          if (!keyProps.anchor && !keyProps.tag && !sep2) {
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
        const valueProps = resolveProps.resolveProps(sep2 ?? [], {
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
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep2, null, valueProps, onError);
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
        let sep2 = "";
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
                comment += sep2 + cb;
              sep2 = "";
              break;
            }
            case "newline":
              if (comment)
                sep2 += source;
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
        const { start, key, sep: sep2, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep2 && !value) {
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
        if (!isMap && !sep2 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep2, null, props, onError);
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
          const valueProps = resolveProps.resolveProps(sep2 ?? [], {
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
              if (sep2)
                for (const st of sep2) {
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
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep2, null, valueProps, onError) : null;
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
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
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
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
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
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
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
      let sep2 = "";
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
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep2 === " ")
            sep2 = "\n";
          else if (!prevMoreIndented && sep2 === "\n")
            sep2 = "\n\n";
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep2 === "\n")
            value += "\n";
          else
            sep2 = "\n";
        } else {
          value += sep2 + content;
          sep2 = " ";
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
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
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
      let sep2 = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep2 === "\n")
            res += sep2;
          else
            sep2 = "\n";
        } else {
          res += sep2 + match[1];
          sep2 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep2 + (match?.[1] ?? "");
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
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
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
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token2, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token2, "TAG_RESOLVE_FAILED", msg);
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
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token2, "TAG_RESOLVE_FAILED", msg, true);
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
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token2, "NON_STRING_KEY", msg);
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
            const msg = token2.source ? `${token2.message}: ${JSON.stringify(token2.source)}` : token2.message;
            const error = new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", msg));
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
    function stringifyItem({ start, key, sep: sep2, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep2)
        for (const st of sep2)
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
          let sep2;
          if (scalar.end) {
            sep2 = scalar.end;
            sep2.push(this.sourceToken);
            delete scalar.end;
          } else
            sep2 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep2 }]
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
                  const sep2 = it.sep;
                  sep2.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep2 }]
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
            const sep2 = fc.end.splice(1, fc.end.length);
            sep2.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep2 }]
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

// packages/rn-dev-agent-core/dist/nav-graph/storage.js
var import_yaml, STRIKE_COOLDOWN_MS;
var init_storage = __esm({
  "packages/rn-dev-agent-core/dist/nav-graph/storage.js"() {
    "use strict";
    import_yaml = __toESM(require_dist(), 1);
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
import { execFileSync as execFileSync2 } from "node:child_process";
function resolveMetroListenerExecutable(platform, dependencies = {}) {
  const executable = platform === "win32" ? "powershell" : platform === "linux" ? "ss" : platform === "darwin" ? "lsof" : null;
  return executable ? resolveTrustedSystemExecutable(executable, platform, dependencies) : null;
}
function numericListener(output, emptyStatus) {
  const value = String(output).trim();
  if (!value)
    return { status: emptyStatus };
  const candidates = value.split(/\s+/);
  if (candidates.some((candidate) => !/^\d+$/.test(candidate))) {
    return { status: "unknown" };
  }
  const pids = new Set(candidates.map(Number));
  const [pid] = pids;
  return pids.size === 1 && Number.isSafeInteger(pid) && pid > 0 ? { status: "listening", pid } : { status: "unknown" };
}
function probeMetroListener(port, platform = process.platform, execute2 = execFileSync2, executableDependencies = {}) {
  const executable = resolveMetroListenerExecutable(platform, executableDependencies);
  if (!executable)
    return { status: "unknown" };
  try {
    if (platform === "win32") {
      const output = execute2(executable, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq ${port}); if ($connections.Count -eq 0) { 'ABSENT' } else { $connections.OwningProcess | Sort-Object -Unique }`
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2e3 });
      return String(output).trim() === "ABSENT" ? { status: "absent" } : numericListener(output, "unknown");
    }
    if (platform === "linux") {
      const output = execute2(executable, ["-H", "-ltnp", `sport = :${port}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2e3
      });
      const value = String(output).trim();
      if (!value)
        return { status: "absent" };
      const pids = new Set([...value.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])));
      const [pid] = pids;
      return pids.size === 1 && Number.isSafeInteger(pid) && pid > 0 ? { status: "listening", pid } : { status: "unknown" };
    }
    if (platform === "darwin") {
      const output = execute2(executable, ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 2e3
      });
      return numericListener(output, "unknown");
    }
    return { status: "unknown" };
  } catch (error) {
    const failure = error;
    return platform === "darwin" && failure.status === 1 && !String(failure.stdout ?? "").trim() && !String(failure.stderr ?? "").trim() ? { status: "absent" } : { status: "unknown" };
  }
}
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
function sessionRecoveryRemedy(lead) {
  return `${lead} Interactive: reconnect the transport with /mcp. Headless: run ${HEADLESS_SESSION_RECOVERY_COMMAND} from the app root. Both run the same proven-dead startup cleanup and neither releases a live or unprovable owner. ${SESSION_RECOVERY_DOCS}.`;
}
function sessionOwnerInspectionRemedy(lead) {
  return `${lead} ${HEADLESS_SESSION_REPORT_COMMAND} from the app root names the owning app root and session; close that session, then run ${HEADLESS_SESSION_RECOVERY_COMMAND}. A live or unprovable owner is never force-released. ${SESSION_RECOVERY_DOCS}.`;
}
function sessionOtherRootRecoveryRemedy(lead) {
  return `${lead} ${HEADLESS_SESSION_REPORT_COMMAND} names the owning app root and session; run ${HEADLESS_SESSION_RECOVERY_COMMAND} from that app root \u2014 this one can never release it \u2014 or work in a separate worktree. Nothing is force-released either way. ${SESSION_RECOVERY_DOCS}.`;
}
function sessionCleanupObligationRemedy(lead) {
  return `${lead} Read the outstanding obligation with ${HEADLESS_SESSION_REPORT_COMMAND} from the app root, clear what it names, then run ${HEADLESS_SESSION_RECOVERY_COMMAND}; interactive clients can reconnect with /mcp instead. Neither releases a live or unprovable owner. ${SESSION_RECOVERY_DOCS}.`;
}
function sessionDeclaredSourceRemedy(lead) {
  return `${lead} Restore the declared manifests that produced the prior identity, then run ${HEADLESS_SESSION_RECOVERY_COMMAND} from this app root or reconnect the transport with /mcp, and reapply the manifest changes afterwards; otherwise use a separate worktree. ${SESSION_RECOVERY_DOCS}.`;
}
var SESSION_DOCTOR, HEADLESS_SESSION_RECOVERY_COMMAND, HEADLESS_SESSION_REPORT_COMMAND, SESSION_RECOVERY_DOCS;
var init_recovery_remedy = __esm({
  "packages/rn-dev-agent-core/dist/session/recovery-remedy.js"() {
    "use strict";
    SESSION_DOCTOR = '"${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}/rn-dev-agent-core/dist/session-doctor.js"';
    HEADLESS_SESSION_RECOVERY_COMMAND = `node ${SESSION_DOCTOR} repair`;
    HEADLESS_SESSION_REPORT_COMMAND = `node ${SESSION_DOCTOR} report`;
    SESSION_RECOVERY_DOCS = 'docs: session-authority "Recovering a wedged source root"';
  }
});

// packages/rn-dev-agent-core/dist/session/registry.js
import { createHash as createHash2, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
function referencesMetroEvidenceSocket(value, path) {
  if (Array.isArray(value)) {
    return value.some((entry) => referencesMetroEvidenceSocket(entry, path));
  }
  if (!value || typeof value !== "object")
    return false;
  const record = value;
  if (record.runtimeEvidenceSocket === path)
    return true;
  return Object.values(record).some((entry) => referencesMetroEvidenceSocket(entry, path));
}
function asSession(row) {
  return row ? row : null;
}
function asClaim(row) {
  return row ? row : null;
}
function claimConflict(claim) {
  const code = conflictCodes[claim.resource_type] ?? "RESOURCE_CLAIM_CONFLICT";
  return new SessionAuthorityError(code, `${claim.resource_type}:${claim.resource_key} is held`, {
    sessionId: claim.session_id,
    claimEpoch: claim.claim_epoch
  });
}
function isOperationalState(state) {
  return (/* @__PURE__ */ new Set([
    "active",
    "source_bound",
    "metro_bound",
    "device_claimed",
    "device_bound",
    "runtime_bound",
    "ready"
  ])).has(state);
}
function isFenceableState(state) {
  return isOperationalState(state) || state === "handoff";
}
function readSourceAppRoot(sourceJson) {
  try {
    const source = JSON.parse(sourceJson);
    return typeof source.appRoot === "string" ? source.appRoot : void 0;
  } catch {
    return void 0;
  }
}
function readStartupCleanupBlocker(bindingsJson) {
  let journal;
  try {
    const bindings = JSON.parse(bindingsJson);
    const value = bindings.startupCleanup;
    journal = value && typeof value === "object" ? value : void 0;
  } catch {
    return void 0;
  }
  if (!journal || typeof journal.finishedAt === "number")
    return void 0;
  const refusal = journal.refusal;
  if (!refusal || typeof refusal !== "object")
    return void 0;
  const record = refusal;
  if (typeof record.code !== "string" || typeof record.reason !== "string")
    return void 0;
  return {
    code: record.code,
    reason: record.reason,
    ...typeof record.nextAction === "string" ? { nextAction: record.nextAction } : {}
  };
}
function bindingsRunnerPresent(bindingsJson) {
  const bindings = JSON.parse(bindingsJson);
  return Boolean(bindings.runner && typeof bindings.runner === "object");
}
function managedMetroHandoffReservation(bindings) {
  const value = bindings.managedMetroHandoffReservation;
  if (value === null || value === void 0)
    return null;
  if (typeof value !== "object" || typeof value.handoffId !== "string" || typeof value.sourceClaimEpoch !== "number" || typeof value.targetSessionId !== "string" || typeof value.targetClaimEpoch !== "number" || typeof value.targetInstance !== "string" || !["shutdown_reserved", "shutdown_completed"].includes(String(value.phase)) || typeof value.metro !== "object" || value.metro === null || typeof value.metro.sourceSessionId !== "string") {
    throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro handoff reservation is malformed");
  }
  return value;
}
function openSessionRegistry(path, dependencies) {
  const store = openAuthorityStore(path, { sqliteCtor: dependencies.sqliteCtor });
  try {
    return new SessionRegistry(store.database, store.close, store.secureFiles, dependencies);
  } catch (error) {
    store.close();
    throw error;
  }
}
var OWNER_IDENTITY_REFUSAL_REASONS, INITIALIZATION_WAIT2, AUTHORITY_REGISTRY_SCHEMA_VERSION, SessionAuthorityError, RECOVERY_HANDLE_TTL_MS, RECOVERY_HANDLE_RENEW_MS, conflictCodes, SessionRegistry;
var init_registry = __esm({
  "packages/rn-dev-agent-core/dist/session/registry.js"() {
    "use strict";
    init_authority_store();
    init_cleanup_identity();
    init_declared_source_contract();
    init_metro_binding();
    init_recovery_remedy();
    OWNER_IDENTITY_REFUSAL_REASONS = {
      sourceOwnerLive: "the same-root owner is live; a live owner is never released",
      sourceOwnerUnprovable: "the same-root owner identity could not be proven, so it is treated as live",
      leaseOwnerUnprovable: "expired lease owner identity could not be proven"
    };
    INITIALIZATION_WAIT2 = new Int32Array(new SharedArrayBuffer(4));
    AUTHORITY_REGISTRY_SCHEMA_VERSION = 4;
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
    RECOVERY_HANDLE_RENEW_MS = 6e4;
    conflictCodes = {
      device: "DEVICE_CLAIM_CONFLICT",
      "device-receipt": "DEVICE_CLAIM_CONFLICT",
      target: "TARGET_CLAIM_CONFLICT",
      "metro-port": "METRO_PORT_CLAIM_CONFLICT",
      "observe-port": "OBSERVE_PORT_CLAIM_CONFLICT",
      runner: "RUNNER_CLAIM_CONFLICT",
      "runner-receipt": "RUNNER_CLAIM_CONFLICT"
    };
    SessionRegistry = class {
      #database;
      #close;
      #secureFiles;
      #now;
      #ownerStatus;
      #listenerStatus;
      #leaseMs;
      #operationContext = new AsyncLocalStorage();
      #pendingPlatformReceipts = /* @__PURE__ */ new Map();
      constructor(database, close, secureFiles, dependencies) {
        this.#database = database;
        this.#close = close;
        this.#secureFiles = secureFiles;
        this.#now = dependencies.now ?? Date.now;
        this.#ownerStatus = dependencies.ownerStatus;
        this.#listenerStatus = dependencies.listenerStatus ?? ((port) => probeMetroListener(port).status);
        this.#leaseMs = dependencies.leaseMs ?? 3e4;
        this.#initializeWithRetry();
      }
      close() {
        this.#close();
      }
      runWithOperation(operation, callback) {
        return this.#operationContext.run(operation, callback);
      }
      currentOperation() {
        const operation = this.#operationContext.getStore();
        if (!operation)
          return void 0;
        const session2 = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version
           FROM sessions WHERE session_id = ?`).get(operation.sessionId));
        const active = this.#database.prepare(`SELECT operation_id FROM operations
         WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
           AND authority_version = ?`).get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        return session2 && isFenceableState(session2.state) && session2.claim_epoch === operation.claimEpoch && session2.authority_version === operation.authorityVersion && active ? operation : void 0;
      }
      hasActiveBundleOperation(session2) {
        return Boolean(this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ? AND instr(profile, 'B') > 0
           LIMIT 1`).get(session2.sessionId, session2.claimEpoch));
      }
      operationHasAxis(operation, axis) {
        this.verifyOperation(operation);
        const pendingAxis = `~${axis}`;
        return Boolean(this.#database.prepare(`SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?
             AND instr(replace(profile, ?, ''), ?) > 0`).get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion, pendingAxis, axis));
      }
      beginOperationAxisAdmission(operation, axis) {
        const pendingAxis = `~${axis}`;
        this.#transaction(() => {
          this.verifyOperation(operation);
          this.#database.prepare(`UPDATE operations
           SET profile = CASE
             WHEN instr(replace(profile, ?, ''), ?) > 0 OR instr(profile, ?) > 0 THEN profile
             ELSE profile || ?
           END
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).run(pendingAxis, axis, pendingAxis, pendingAxis, operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        });
      }
      completeOperationAxisAdmission(operation, axis, admitted) {
        const pendingAxis = `~${axis}`;
        this.#transaction(() => {
          this.verifyOperation(operation);
          this.#database.prepare(`UPDATE operations
           SET profile = CASE
             WHEN ? = 0 THEN replace(profile, ?, '')
             WHEN instr(replace(profile, ?, ''), ?) > 0 THEN replace(profile, ?, '')
             ELSE replace(profile, ?, '') || ?
           END
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).run(admitted ? 1 : 0, pendingAxis, pendingAxis, axis, pendingAxis, pendingAxis, axis, operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        });
      }
      createSession(input) {
        const now = this.#now();
        this.#transaction(() => {
          this.#discardAbsentBlockedContenders(input);
          this.#database.prepare(`INSERT INTO sessions(
            session_id, source_key, worktree_key, app_root_key, state,
            claim_epoch, authority_version, supervisor_pid, supervisor_birth,
            worker_instance, worker_pid, worker_birth, heartbeat_ms, lease_until_ms,
            source_json, bindings_json, created_ms, updated_ms
          ) VALUES (?, ?, ?, ?, 'active', 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.sessionId, input.sourceKey, input.worktreeKey, input.appRootKey, input.supervisor.pid, input.supervisor.token, input.worker?.instanceId ?? null, input.worker?.pid ?? null, input.worker?.token ?? null, now, now + this.#leaseMs, JSON.stringify(input.source ?? {}), JSON.stringify(input.bindings ?? {}), now, now);
        });
        return { sessionId: input.sessionId, claimEpoch: 1 };
      }
      claimResources(session2, resources) {
        const unique = new Map(resources.map((resource) => [`${resource.type}\0${resource.key}`, resource]));
        if (unique.size !== resources.length) {
          throw new SessionAuthorityError("DUPLICATE_RESOURCE_CLAIM", "claim set contains duplicates");
        }
        const probes = this.#probeClaimOwners(session2, resources);
        const now = this.#now();
        return this.#transaction(() => {
          const owner = this.#requireSession(session2);
          const bindings = JSON.parse(owner.bindings_json);
          if (resources.some((resource) => resource.type === "device")) {
            this.#assertNoStaleDeviceCleanup(bindings);
          }
          this.#assertClaimsAvailable(session2, resources, probes, now);
          const leaseUntil = now + this.#leaseMs;
          for (const resource of resources) {
            this.#database.prepare(`INSERT INTO claims(
              resource_type, resource_key, session_id, claim_epoch, lease_until_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(resource_type, resource_key) DO UPDATE SET
              session_id = excluded.session_id,
              claim_epoch = excluded.claim_epoch,
              lease_until_ms = excluded.lease_until_ms`).run(resource.type, resource.key, session2.sessionId, session2.claimEpoch, leaseUntil);
          }
          this.#database.prepare(`UPDATE sessions
           SET authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, owner.session_id, owner.claim_epoch);
          this.#advanceActiveOperationFence(session2, owner.authority_version, owner.authority_version + 1);
          return session2;
        });
      }
      releaseResources(session2, resources) {
        const now = this.#now();
        this.#transaction(() => {
          const current = this.#requireSession(session2);
          for (const resource of resources) {
            if (resource.type === "runner" || resource.type === "device") {
              const rows = this.#database.prepare(`SELECT platform, receipt_json FROM platform_authority_receipts
               WHERE session_id = ? AND claim_epoch = ?`).all(session2.sessionId, session2.claimEpoch);
              for (const row of rows) {
                const persisted = JSON.parse(row.receipt_json);
                const receipt = persisted.receipt && typeof persisted.receipt === "object" ? persisted.receipt : persisted;
                if (resource.type === "runner" && receipt.runnerClaim === resource.key || resource.type === "device" && receipt.deviceClaim === resource.key) {
                  this.#invalidatePlatformReceipt(session2, row.platform);
                }
              }
            }
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(resource.type, resource.key, session2.sessionId, session2.claimEpoch);
          }
          this.#database.prepare(`UPDATE sessions SET authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, session2.sessionId, session2.claimEpoch);
          this.#advanceActiveOperationFence(session2, current.authority_version, current.authority_version + 1);
        });
      }
      async claimResourcesWithRetry(session2, resources, options = {}) {
        return this.#retry(() => this.claimResources(session2, resources), options.timeoutMs ?? 1e3, options.retryDelayMs ?? 5);
      }
      renewSession(session2) {
        const now = this.#now();
        this.#transaction(() => {
          this.#requireSession(session2);
          const leaseUntil = now + this.#leaseMs;
          this.#database.prepare(`UPDATE sessions
           SET heartbeat_ms = ?, lease_until_ms = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, leaseUntil, now, session2.sessionId, session2.claimEpoch);
          this.#database.prepare(`UPDATE claims SET lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(leaseUntil, session2.sessionId, session2.claimEpoch);
        });
      }
      async renewSessionWithRetry(session2, options = {}) {
        return this.#retry(() => this.renewSession(session2), options.timeoutMs ?? 1e3, options.retryDelayMs ?? 5);
      }
      bindWorker(session2, worker) {
        const now = this.#now();
        this.#transaction(() => {
          this.#requireSession(session2);
          this.#database.prepare("DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?").run(session2.sessionId, session2.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET worker_instance = ?, worker_pid = ?, worker_birth = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(worker.instanceId, worker.pid, worker.token, now, session2.sessionId, session2.claimEpoch);
        });
      }
      bindRecoveryWorker(session2, worker, capability) {
        const now = this.#now();
        this.#transaction(() => {
          const row = this.#requireRecoverableSession(session2);
          const bindings = JSON.parse(row.bindings_json);
          const expected = Buffer.from(String(bindings.recoveryCapabilityHash ?? ""), "hex");
          const actual = createHash2("sha256").update(capability).digest();
          if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "blocked recovery capability is invalid");
          }
          const pendingHandoffs = this.#database.prepare(`SELECT handoff.handoff_id, handoff.claim_epoch, handoff.target_instance,
                  donor.session_id, donor.claim_epoch AS donor_claim_epoch,
                  donor.bindings_json
           FROM handoffs handoff
           JOIN sessions donor ON donor.session_id = handoff.session_id
           WHERE handoff.consumed_ms IS NULL
             AND donor.state = 'handoff'
             AND donor.source_key = ?
             AND donor.worktree_key = ?
             AND donor.app_root_key = ?`).all(row.source_key, row.worktree_key, row.app_root_key);
          const adoptionRequired = bindings.adoptionRequired;
          const rotations = pendingHandoffs.flatMap((handoff) => {
            const donorBindings = JSON.parse(handoff.bindings_json);
            const reservation = managedMetroHandoffReservation(donorBindings);
            if (!reservation)
              return [];
            if (reservation.handoffId !== handoff.handoff_id || reservation.sourceClaimEpoch !== handoff.claim_epoch || reservation.sourceClaimEpoch !== handoff.donor_claim_epoch || reservation.metro.sourceSessionId !== handoff.session_id) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro handoff reservation no longer matches the recovery worker fence");
            }
            if (reservation.targetSessionId !== session2.sessionId || reservation.targetClaimEpoch !== session2.claimEpoch) {
              return [];
            }
            if (reservation.targetInstance !== row.worker_instance || handoff.target_instance !== row.worker_instance) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro handoff reservation no longer matches the recovery worker fence");
            }
            return [{ handoff, donorBindings, reservation }];
          });
          if (rotations.length > 1) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "multiple managed Metro handoffs target the same recovery session");
          }
          const rotation = rotations[0];
          if (rotation) {
            const rotatedReservation = {
              ...rotation.reservation,
              targetSessionId: session2.sessionId,
              targetClaimEpoch: session2.claimEpoch,
              targetInstance: worker.instanceId
            };
            const handoffChanged = this.#database.prepare(`UPDATE handoffs SET target_instance = ?
             WHERE handoff_id = ? AND target_instance = ? AND consumed_ms IS NULL`).run(worker.instanceId, rotation.handoff.handoff_id, rotation.reservation.targetInstance);
            if (handoffChanged.changes !== 1) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro handoff target changed during recovery worker rotation");
            }
            const donorChanged = this.#database.prepare(`UPDATE sessions
             SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
             WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`).run(JSON.stringify({
              ...rotation.donorBindings,
              managedMetroHandoffReservation: rotatedReservation
            }), now, rotation.handoff.session_id, rotation.handoff.donor_claim_epoch);
            if (donorChanged.changes !== 1) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro donor authority changed during recovery worker rotation");
            }
          }
          const grouped = JSON.parse(row.source_json).model === "grouped-v1";
          const expiresMs = now + RECOVERY_HANDLE_TTL_MS;
          const priorHandles = bindings.recoveryHandles;
          const resumableAdoptStale = row.state === "handoff_cleanup" && priorHandles?.adoptStale && typeof priorHandles.adoptStale === "object" ? priorHandles.adoptStale : void 0;
          const reboundAdoptStale = resumableAdoptStale ? {
            ...resumableAdoptStale,
            previous: typeof resumableAdoptStale.token === "string" && typeof resumableAdoptStale.expiresMs === "number" && resumableAdoptStale.expiresMs >= now ? {
              token: resumableAdoptStale.token,
              expiresMs: resumableAdoptStale.expiresMs
            } : void 0,
            token: randomBytes(32).toString("base64url"),
            expiresMs
          } : void 0;
          const recoveryHandles = {
            handoffRecipient: {
              token: randomBytes(32).toString("base64url"),
              expiresMs,
              workerInstance: worker.instanceId
            },
            ...typeof adoptionRequired?.sessionId === "string" ? {
              adoptStale: {
                token: randomBytes(32).toString("base64url"),
                expiresMs,
                priorSessionId: adoptionRequired.sessionId,
                priorClaimEpoch: adoptionRequired.claimEpoch
              }
            } : reboundAdoptStale ? { adoptStale: reboundAdoptStale } : {}
          };
          this.#database.prepare("DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?").run(session2.sessionId, session2.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET worker_instance = ?, worker_pid = ?, worker_birth = ?,
               bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?
             AND state IN ('blocked', 'handoff_cleanup')`).run(worker.instanceId, worker.pid, worker.token, grouped ? JSON.stringify(bindings) : JSON.stringify({ ...bindings, recoveryHandles }), now, session2.sessionId, session2.claimEpoch);
        });
      }
      /**
       * GH #672: rotate a recovery handle that is expired or about to expire, so `status`
       * can never advertise a token `validateStaleAdoption` will refuse. Capability- and
       * worker-bound, re-reads durable state, and leaves a still-fresh handle untouched.
       * Returns whether anything rotated.
       */
      refreshRecoveryHandles(session2, worker, capability) {
        const now = this.#now();
        return this.#transaction(() => {
          const row = this.#requireRecoverableSession(session2);
          const bindings = JSON.parse(row.bindings_json);
          const expected = Buffer.from(String(bindings.recoveryCapabilityHash ?? ""), "hex");
          const actual = createHash2("sha256").update(capability).digest();
          if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "blocked recovery capability is invalid");
          }
          if (row.worker_instance !== worker.instanceId) {
            throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "recovery handle refresh is not owned by this recovery worker");
          }
          const handles = bindings.recoveryHandles;
          if (!handles || typeof handles !== "object")
            return false;
          const expiresMs = now + RECOVERY_HANDLE_TTL_MS;
          let changed = false;
          const next = { ...handles };
          for (const name of ["handoffRecipient", "adoptStale"]) {
            const handle = handles[name];
            if (!handle || typeof handle !== "object")
              continue;
            const current = handle;
            const previous = current.previous;
            const previousExpired = previous && typeof previous.expiresMs === "number" && previous.expiresMs < now;
            const retained = previousExpired ? { ...current, previous: void 0 } : current;
            if (previousExpired)
              changed = true;
            if (typeof current.expiresMs === "number" && current.expiresMs > now + RECOVERY_HANDLE_RENEW_MS) {
              next[name] = retained;
              continue;
            }
            next[name] = {
              ...retained,
              previous: typeof current.token === "string" && typeof current.expiresMs === "number" && current.expiresMs >= now ? { token: current.token, expiresMs: current.expiresMs } : void 0,
              token: randomBytes(32).toString("base64url"),
              expiresMs
            };
            changed = true;
          }
          if (!changed)
            return false;
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?
             AND state IN ('blocked', 'handoff_cleanup')`).run(JSON.stringify({ ...bindings, recoveryHandles: next }), now, session2.sessionId, session2.claimEpoch);
          return true;
        });
      }
      /**
       * GH #672: distinguish the three real recovery answers for a blocked contender.
       * A dead prior owner is adoptable; a LIVE one never is (the caller must close it or
       * use another worktree); an owner whose identity cannot be proven is treated as live.
       * A vanished claim epoch only needs a fresh transport.
       */
      inspectRecoveryRequirement(sessionId) {
        const row = asSession(this.#database.prepare(`SELECT source_key, worktree_key, app_root_key, state, source_json, bindings_json
           FROM sessions WHERE session_id = ?`).get(sessionId));
        if (!row || row.state !== "blocked" && row.state !== "handoff_cleanup") {
          return { requirement: "none", priorOwner: "absent", nextAction: "" };
        }
        if (row.state === "handoff_cleanup") {
          return {
            requirement: "adoption",
            priorOwner: "stale",
            nextAction: 'Resume the transferred cleanup with rn_session({ action: "adopt_stale", adoptionHandle }).'
          };
        }
        const grouped = JSON.parse(row.source_json).model === "grouped-v1";
        const bindings = JSON.parse(row.bindings_json);
        const adoptionRequired = bindings.adoptionRequired;
        const priorSessionId = typeof adoptionRequired?.sessionId === "string" ? adoptionRequired.sessionId : null;
        const prior = priorSessionId ? asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, claim_epoch,
                      supervisor_pid, supervisor_birth, heartbeat_ms, bindings_json
               FROM sessions WHERE session_id = ?`).get(priorSessionId)) : null;
        if (!prior || prior.claim_epoch !== adoptionRequired?.claimEpoch) {
          return {
            requirement: "transport-restart",
            priorOwner: "absent",
            nextAction: sessionRecoveryRemedy("The blocking claim epoch is gone; a clean session can start here.")
          };
        }
        let status = "unknown";
        try {
          status = this.#ownerStatus({
            sessionId: prior.session_id,
            pid: prior.supervisor_pid,
            token: prior.supervisor_birth
          });
        } catch {
          status = "unknown";
        }
        if (status === "mismatch") {
          if (grouped) {
            const isSameAppRoot = prior.worktree_key === row.worktree_key && prior.app_root_key === row.app_root_key;
            if (!isSameAppRoot) {
              return {
                requirement: "attach",
                priorOwner: "stale",
                nextAction: sessionOtherRootRecoveryRemedy("The proven-dead owner belongs to a different app root in this worktree, so startup cleanup cannot release it here.")
              };
            }
            if (prior.source_key !== row.source_key) {
              return {
                requirement: "attach",
                priorOwner: "stale",
                nextAction: sessionDeclaredSourceRemedy("The proven-dead owner has a different source identity for this app root, so startup cleanup cannot release it under the current declared manifests.")
              };
            }
            const blocked = readStartupCleanupBlocker(prior.bindings_json);
            if (blocked) {
              return {
                requirement: "transport-restart",
                priorOwner: "stale",
                startupCleanupBlocked: blocked,
                nextAction: blocked.nextAction ?? sessionCleanupObligationRemedy(`Startup cleanup refused with ${blocked.code} and will refuse again until that is resolved: ${blocked.reason}.`)
              };
            }
            return {
              requirement: "transport-restart",
              priorOwner: "stale",
              nextAction: sessionRecoveryRemedy("The prior owner is proven dead and is released automatically.")
            };
          }
          return {
            requirement: "adoption",
            priorOwner: "stale",
            nextAction: 'The prior owner is proven dead. Adopt it with rn_session({ action: "adopt_stale", adoptionHandle }).'
          };
        }
        const heartbeatAgeMs = Math.min(Math.max(0, this.#now() - (typeof prior.heartbeat_ms === "number" ? prior.heartbeat_ms : 0)), 24 * 36e5);
        return {
          requirement: "attach",
          priorOwner: status === "match" ? "live" : "unknown",
          ...grouped ? { priorOwnerHeartbeatAgeMs: heartbeatAgeMs } : {},
          nextAction: status === "match" ? sessionOwnerInspectionRemedy("Another live rn-dev-agent supervisor owns this worktree; a live owner is never adopted.") : sessionOwnerInspectionRemedy("The prior owner identity could not be proven, so it is treated as live.")
        };
      }
      #assertDeviceAuthorityAvailable(session2, resource, probes, currentBindings) {
        this.#assertNoStaleDeviceCleanup(currentBindings);
        const claim = this.#findConflictingClaim(resource);
        if (claim && (claim.session_id !== session2.sessionId || claim.claim_epoch !== session2.claimEpoch)) {
          const probe = probes.get(claim.session_id);
          if (!probe || probe.claimEpoch !== claim.claim_epoch || probe.status !== "mismatch") {
            throw claimConflict(claim);
          }
          throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "a proven-stale device owner requires explicit adopt_stale before rebinding", { sessionId: claim.session_id, claimEpoch: claim.claim_epoch });
        }
      }
      /**
       * GH #776: the exact refusals replaceDeviceAuthority would raise, proven without
       * writing anything, so a caller can refuse before it yields any other axis.
       */
      inspectDeviceAuthorityAvailability(session2, resource) {
        const probes = this.#probeClaimOwners(session2, [resource]);
        this.#transaction(() => {
          const current = this.#requireSession(session2);
          const currentBindings = JSON.parse(current.bindings_json);
          this.#assertDeviceAuthorityAvailable(session2, resource, probes, currentBindings);
        });
      }
      replaceDeviceAuthority(session2, input) {
        const resource = input.resource ?? {
          type: "device",
          key: `${String(input.device.platform)}:${String(input.device.deviceId)}`
        };
        const probes = this.#probeClaimOwners(session2, [resource]);
        const now = this.#now();
        this.#transaction(() => {
          const current = this.#requireSession(session2);
          const currentBindings = JSON.parse(current.bindings_json);
          this.#assertDeviceAuthorityAvailable(session2, resource, probes, currentBindings);
          this.#database.prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type IN ('device', 'target', 'runner')`).run(session2.sessionId, session2.claimEpoch);
          this.#database.prepare(`INSERT INTO claims(
            resource_type, resource_key, session_id, claim_epoch, lease_until_ms
          ) VALUES (?, ?, ?, ?, ?)`).run(resource.type, resource.key, session2.sessionId, session2.claimEpoch, now + this.#leaseMs);
          const bindings = {
            ...currentBindings,
            device: input.device,
            install: input.install ?? null,
            bundle: null,
            runner: null,
            observe: null,
            proof: null,
            pendingBuild: null
          };
          this.#invalidatePlatformReceipt(session2, String(input.device.platform));
          this.#database.prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(input.install ? "device_bound" : "device_claimed", JSON.stringify(bindings), now, session2.sessionId, session2.claimEpoch);
          this.#advanceActiveOperationFence(session2, current.authority_version, current.authority_version + 1);
        });
      }
      /**
       * GH #672: device-family claims held by a proven-dead owner discovered AFTER startup.
       * Startup adoption only exists for source/port conflicts, so a dead device/runner owner
       * left `bind_device` demanding an `adopt_stale` handle that no path could mint. This
       * offers a bounded, capability-authenticated release for the exact device only — it
       * never transfers source, package-integration, Metro, or port authority, so a dead
       * owner from a foreign worktree can be cleaned up without adopting its session.
       * ADR L5: new code no longer mints these offers; `beginConfirmedStaleDeviceRelease`
       * is the default path. This mint stays only as the trivially revertible legacy path.
       */
      prepareStaleResourceRelease(session2, target) {
        const deviceKey = `${target.platform}:${target.deviceId}`;
        const now = this.#now();
        return this.#transaction(() => {
          const current = this.#requireSession(session2);
          const prior = this.#requireSingleProvenDeadDeviceOwner(session2, deviceKey);
          const family = this.#requireExactStaleDeviceFamily(session2, prior, target);
          const obligations = [];
          if (family.androidMetroReverse)
            obligations.push("androidMetroReverse");
          if (family.runner)
            obligations.push("runner");
          if (family.recorder)
            obligations.push("recorder");
          const offer = {
            token: randomBytes(32).toString("base64url"),
            expiresMs: now + RECOVERY_HANDLE_TTL_MS,
            priorSessionId: prior.session_id,
            priorClaimEpoch: prior.claim_epoch,
            obligations
          };
          const bindings = JSON.parse(current.bindings_json);
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({
            ...bindings,
            staleDeviceRelease: {
              ...offer,
              platform: target.platform,
              deviceId: target.deviceId,
              priorSupervisorPid: prior.supervisor_pid,
              deathProvenAt: now
            }
          }), now, session2.sessionId, session2.claimEpoch);
          return offer;
        });
      }
      /**
       * ADR L5: read-only view of what a confirmed inline release would transfer. Proves
       * the owner's death and computes the exact obligations without minting a capability
       * or writing any state.
       */
      inspectStaleDeviceRelease(session2, target) {
        const deviceKey = `${target.platform}:${target.deviceId}`;
        this.#requireSession(session2);
        const prior = this.#requireSingleProvenDeadDeviceOwner(session2, deviceKey);
        const family = this.#requireExactStaleDeviceFamily(session2, prior, target);
        const obligations = [];
        if (family.androidMetroReverse)
          obligations.push("androidMetroReverse");
        if (family.runner)
          obligations.push("runner");
        if (family.recorder)
          obligations.push("recorder");
        return {
          priorSessionId: prior.session_id,
          priorClaimEpoch: prior.claim_epoch,
          obligations
        };
      }
      /**
       * ADR L5 (captain-approved D3): confirmed inline replacement for the capability-token
       * transfer. Authorization is the caller's explicit confirmation plus positive death
       * proof re-read from durable state inside this transaction, scoped to the exact
       * requested device. An existing journal resumes token-lessly; nothing is minted and
       * nothing expires.
       */
      beginConfirmedStaleDeviceRelease(session2, workerInstance, target) {
        const now = this.#now();
        return this.#transaction(() => {
          const current = this.#requireSession(session2);
          const bindings = JSON.parse(current.bindings_json);
          if (current.worker_instance !== workerInstance) {
            throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "stale device release is not owned by this worker");
          }
          const resumed = bindings.staleDeviceCleanup;
          if (resumed) {
            this.#assertStaleReleaseJournalScope(current, resumed, target);
            return {
              platform: String(resumed.platform),
              deviceId: String(resumed.deviceId),
              ...resumed.androidMetroReverse ? { androidMetroReverse: resumed.androidMetroReverse } : {},
              runner: resumed.runner ?? null,
              recorder: resumed.recorder ?? null
            };
          }
          const deviceKey = `${target.platform}:${target.deviceId}`;
          const prior = this.#requireSingleProvenDeadDeviceOwner(session2, deviceKey);
          return this.#transferStaleDeviceAuthority(session2, bindings, prior, target, now);
        });
      }
      /**
       * GH #672: take over the dead owner's exact device-family claims and its cleanup
       * obligations. Every proof is re-read from durable state here, not trusted from the
       * mint: a prior owner that came back to life, changed epoch, or cannot be identified
       * refuses even with a valid handle.
       */
      beginStaleResourceRelease(session2, handle, workerInstance, target) {
        const now = this.#now();
        return this.#transaction(() => {
          const current = this.#requireSession(session2);
          const bindings = JSON.parse(current.bindings_json);
          if (current.worker_instance !== workerInstance) {
            throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "stale device release is not owned by this worker");
          }
          const resumed = bindings.staleDeviceCleanup;
          if (resumed) {
            this.#assertStaleReleaseJournalScope(current, resumed, target);
            return {
              platform: String(resumed.platform),
              deviceId: String(resumed.deviceId),
              ...resumed.androidMetroReverse ? { androidMetroReverse: resumed.androidMetroReverse } : {},
              runner: resumed.runner ?? null,
              recorder: resumed.recorder ?? null
            };
          }
          const offer = bindings.staleDeviceRelease;
          if (!offer || typeof offer.token !== "string" || typeof offer.expiresMs !== "number" || typeof offer.platform !== "string" || typeof offer.deviceId !== "string" || typeof offer.priorSessionId !== "string" || typeof offer.priorClaimEpoch !== "number" || typeof handle !== "string" || !this.#capabilityMatches(offer.token, handle)) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "stale device release capability is invalid or expired");
          }
          const platform = offer.platform;
          const deviceId = offer.deviceId;
          if (target && (target.platform !== platform || target.deviceId !== deviceId)) {
            throw new SessionAuthorityError("DEVICE_AUTHORITY_MISMATCH", "stale device release offer does not match the requested exact device", void 0, { axis: "D", nextAction: 'Run rn_session with action "status" for the exact recovery.' });
          }
          if (offer.expiresMs < now) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "stale device release capability is invalid or expired");
          }
          const prior = this.#requireProvenDeadOwner(offer.priorSessionId, offer.priorClaimEpoch);
          return this.#transferStaleDeviceAuthority(session2, bindings, prior, { platform, deviceId }, now);
        });
      }
      #transferStaleDeviceAuthority(session2, bindings, prior, target, now) {
        const { platform, deviceId } = target;
        const deviceKey = `${platform}:${deviceId}`;
        const priorBindings = JSON.parse(prior.bindings_json);
        const family = this.#requireExactStaleDeviceFamily(session2, prior, target);
        const { androidMetroReverse, runner, recorder } = family;
        for (const claim of family.claims) {
          this.#database.prepare(`UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
           WHERE resource_type = ? AND resource_key = ?
             AND session_id = ? AND claim_epoch = ?`).run(session2.sessionId, session2.claimEpoch, now + this.#leaseMs, claim.resource_type, claim.resource_key, prior.session_id, prior.claim_epoch);
        }
        const runnerClaimKey = runner ? `${platform}:${deviceId}:${String(runner.port)}` : null;
        const cleanup = {
          platform,
          deviceId,
          priorSessionId: prior.session_id,
          priorClaimEpoch: prior.claim_epoch,
          transferredAt: now,
          ...androidMetroReverse ? {
            androidMetroReverse: {
              ...androidMetroReverse,
              claimKey: deviceKey,
              stopRequestedAt: now,
              completedAt: null
            }
          } : {},
          runner: runner ? { ...runner, claimKey: runnerClaimKey, stopRequestedAt: now, completedAt: null } : null,
          recorder: recorder ? { ...recorder, claimKey: deviceKey, stopRequestedAt: now, completedAt: null } : null
        };
        this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
         WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({ ...bindings, staleDeviceCleanup: cleanup }), now, session2.sessionId, session2.claimEpoch);
        this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
         WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({
          ...priorBindings,
          device: null,
          androidMetroReverse: null,
          runner: null,
          recorder: null,
          deviceReleased: {
            toSessionId: session2.sessionId,
            toClaimEpoch: session2.claimEpoch,
            at: now,
            platform,
            deviceId,
            device: priorBindings.device ?? null,
            androidMetroReverse,
            runner,
            recorder
          }
        }), now, prior.session_id, prior.claim_epoch);
        return {
          platform,
          deviceId,
          ...cleanup.androidMetroReverse ? { androidMetroReverse: cleanup.androidMetroReverse } : {},
          runner: cleanup.runner,
          recorder: cleanup.recorder
        };
      }
      #requireSingleProvenDeadDeviceOwner(session2, deviceKey) {
        const claims = this.#deviceFamilyClaims(deviceKey);
        if (claims.length === 0) {
          throw new SessionAuthorityError("DEVICE_CLAIM_CONFLICT", `no foreign claim on ${deviceKey} needs release`);
        }
        const owners = new Set(claims.map((claim) => `${claim.session_id}\0${claim.claim_epoch}`));
        if (owners.size !== 1) {
          throw new SessionAuthorityError("DEVICE_CLAIM_CONFLICT", `${deviceKey} is split across several claim epochs; release each owner explicitly`);
        }
        if (claims[0].session_id === session2.sessionId && claims[0].claim_epoch === session2.claimEpoch) {
          throw new SessionAuthorityError("DEVICE_CLAIM_CONFLICT", `no foreign claim on ${deviceKey} needs release`);
        }
        return this.#requireProvenDeadOwner(claims[0].session_id, claims[0].claim_epoch);
      }
      #requireExactStaleDeviceFamily(session2, prior, target) {
        const deviceKey = `${target.platform}:${target.deviceId}`;
        const claims = this.#deviceFamilyClaims(deviceKey);
        if (claims.length === 0 || claims.some((claim) => claim.session_id !== prior.session_id || claim.claim_epoch !== prior.claim_epoch)) {
          throw new SessionAuthorityError("DEVICE_CLAIM_CONFLICT", `${deviceKey} is split across several claim epochs; release each owner explicitly`);
        }
        if (claims.some((claim) => claim.resource_type === "device-receipt" || claim.resource_type === "runner-receipt")) {
          throw new SessionAuthorityError("DEVICE_AUTHORITY_MISMATCH", "stale device cleanup cannot transfer platform validation receipt authority");
        }
        const bindings = JSON.parse(prior.bindings_json);
        if (!this.#bindingMatchesDevice(bindings.device, target)) {
          throw new SessionAuthorityError("DEVICE_AUTHORITY_MISMATCH", "stale device claim does not match its owner binding");
        }
        const deviceClaims = claims.filter((claim) => claim.resource_type === "device");
        if (deviceClaims.length !== 1 || deviceClaims[0].resource_key !== deviceKey) {
          throw new SessionAuthorityError("DEVICE_AUTHORITY_MISMATCH", "stale device binding has no exclusive cleanup claim");
        }
        const current = this.#requireSession(session2);
        const currentBindings = JSON.parse(current.bindings_json);
        if (this.#bindingMatchesDevice(currentBindings.device, target) || this.#bindingMatchesDevice(currentBindings.runner, target) || this.#bindingMatchesDevice(currentBindings.recorder, target)) {
          throw new SessionAuthorityError("DEVICE_AUTHORITY_MISMATCH", "stale device cleanup conflicts with existing target bindings");
        }
        const reverseValue = bindings.androidMetroReverse;
        const androidMetroReverse = reverseValue && typeof reverseValue === "object" && target.platform === "android" && reverseValue.platform === "android" && reverseValue.deviceId === target.deviceId && Number.isSafeInteger(reverseValue.metroPort) && reverseValue.local === `tcp:${String(reverseValue.metroPort)}` && reverseValue.remote === `tcp:${String(reverseValue.metroPort)}` ? reverseValue : null;
        if (reverseValue !== null && reverseValue !== void 0 && !androidMetroReverse) {
          throw new SessionAuthorityError("PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN", "stale physical Android Metro reverse binding does not match the exact device and port");
        }
        const runnerClaims = claims.filter((claim) => claim.resource_type === "runner");
        const runnerValue = bindings.runner;
        const runner = this.#bindingMatchesDevice(runnerValue, target) ? runnerValue : null;
        if (runnerValue !== null && runnerValue !== void 0 && !runner) {
          throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "stale runner binding targets another device");
        }
        if (runner && !hasCompleteRunnerCleanupIdentity(runner)) {
          throw new SessionAuthorityError("RUNNER_ADOPTION_REQUIRED", "stale runner cleanup identity is incomplete");
        }
        const runnerClaimKey = runner ? `${deviceKey}:${String(runner.port)}` : null;
        if (runnerClaims.length !== (runner ? 1 : 0) || runner && runnerClaims[0].resource_key !== runnerClaimKey) {
          throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "stale runner binding has no exclusive cleanup claim");
        }
        const recorderClaims = claims.filter((claim) => claim.resource_type === "recorder");
        const recorderValue = bindings.recorder;
        const recorder = this.#bindingMatchesDevice(recorderValue, target) ? recorderValue : null;
        if (recorderValue !== null && recorderValue !== void 0 && !recorder) {
          throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "stale recorder binding targets another device");
        }
        if (recorder && !hasCompleteRecorderCleanupIdentity(recorder)) {
          throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "stale recorder cleanup identity is incomplete");
        }
        if (recorderClaims.length !== (recorder ? 1 : 0) || recorder && recorderClaims[0].resource_key !== deviceKey) {
          throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "stale recorder binding has no exclusive cleanup claim");
        }
        return { claims, androidMetroReverse, runner, recorder };
      }
      completeStaleResourceRelease(session2, workerInstance, resource) {
        const now = this.#now();
        this.#transaction(() => {
          const { row, bindings, cleanup } = this.#requireStaleReleaseOwner(session2, workerInstance);
          const binding = cleanup[resource];
          if (!binding || typeof binding !== "object")
            return;
          const entry = binding;
          if (typeof entry.stopRequestedAt !== "number") {
            throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", `${resource} release was not durably requested`);
          }
          if (typeof entry.completedAt === "number")
            return;
          if (resource !== "androidMetroReverse") {
            const claimType = resource === "runner" ? "runner" : "recorder";
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(claimType, String(entry.claimKey), session2.sessionId, session2.claimEpoch);
          }
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({
            ...bindings,
            staleDeviceCleanup: { ...cleanup, [resource]: { ...entry, completedAt: now } }
          }), now, row.session_id, row.claim_epoch);
        });
      }
      finishStaleResourceRelease(session2, workerInstance) {
        const now = this.#now();
        this.#transaction(() => {
          const { row, bindings, cleanup } = this.#requireStaleReleaseOwner(session2, workerInstance);
          for (const resource of ["androidMetroReverse", "runner", "recorder"]) {
            const binding = cleanup[resource];
            if (binding && typeof binding === "object" && typeof binding.completedAt !== "number") {
              throw new SessionAuthorityError("AUTOMATION_CLEANUP_UNPROVEN", `${resource} release has not been durably completed`);
            }
          }
          const deviceKey = `${String(cleanup.platform)}:${String(cleanup.deviceId)}`;
          const unrelatedClaim = this.#deviceFamilyClaims(deviceKey).find((claim) => claim.resource_type !== "device");
          if (unrelatedClaim) {
            throw new SessionAuthorityError("DEVICE_AUTHORITY_MISMATCH", "stale device cleanup found authority outside its completed journal");
          }
          this.#database.prepare(`DELETE FROM claims
           WHERE resource_type = 'device' AND resource_key = ?
             AND session_id = ? AND claim_epoch = ?`).run(deviceKey, session2.sessionId, session2.claimEpoch);
          const nextAuthorityVersion = row.authority_version + 1;
          this.#database.prepare(`UPDATE sessions
           SET bindings_json = ?, authority_version = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND authority_version = ?`).run(JSON.stringify({ ...bindings, staleDeviceCleanup: null, staleDeviceRelease: null }), nextAuthorityVersion, now, row.session_id, row.claim_epoch, row.authority_version);
          this.#advanceActiveOperationFence(session2, row.authority_version, nextAuthorityVersion, true);
        });
      }
      /**
       * L4: verified-dead startup cleanup. The durable journal lives on the DEAD session's
       * row and is written before any side effect; claims release only in finish, after
       * every obligation is durably complete. Death is positively re-proven by every method.
       */
      findStartupCleanupCandidate(input) {
        const claim = this.#findClaim("source", input.worktreeKey);
        if (!claim)
          return null;
        const row = asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, claim_epoch
           FROM sessions WHERE session_id = ?`).get(claim.session_id));
        if (!row || row.claim_epoch !== claim.claim_epoch || row.source_key !== input.sourceKey || row.worktree_key !== input.worktreeKey || row.app_root_key !== input.appRootKey) {
          return null;
        }
        return { sessionId: claim.session_id, claimEpoch: claim.claim_epoch };
      }
      beginStartupOwnerCleanup(prior) {
        const now = this.#now();
        return this.#transaction(() => {
          const row = this.#requireProvenDeadStartupOwner(prior);
          const bindings = JSON.parse(row.bindings_json);
          const existing = bindings.startupCleanup;
          if (existing && typeof existing === "object" && typeof existing.finishedAt !== "number") {
            return {
              resumed: true,
              obligations: existing.obligations ?? {},
              integration: existing.integration ?? null
            };
          }
          const record = (value) => value && typeof value === "object" ? { ...value } : null;
          const obligation = (source, claimKey) => source ? {
            ...source,
            claimKey: String(source.claimKey ?? claimKey ?? ""),
            stopRequestedAt: typeof source.stopRequestedAt === "number" ? source.stopRequestedAt : now,
            completedAt: typeof source.completedAt === "number" ? source.completedAt : null
          } : void 0;
          const handoffCleanup = record(bindings.handoffCleanup);
          const staleDevice = record(bindings.staleDeviceCleanup);
          const androidMetroReverseSource = record(bindings.androidMetroReverse) ?? record(staleDevice?.androidMetroReverse);
          const recorderSource = record(bindings.recorder) ?? record(staleDevice?.recorder) ?? record(handoffCleanup?.recorder);
          const runnerSource = record(bindings.runner) ?? record(staleDevice?.runner) ?? record(handoffCleanup?.runner);
          const observeSource = record(bindings.observe) ?? record(handoffCleanup?.observe);
          const liveMetro = record(bindings.metroCleanup) ?? record(bindings.metro);
          const metroSource = liveMetro && liveMetro.mode === "managed" ? liveMetro : record(handoffCleanup?.metro);
          const obligations = {};
          const androidMetroReverseEntry = obligation(androidMetroReverseSource, androidMetroReverseSource ? `android:${String(androidMetroReverseSource.deviceId)}` : null);
          if (androidMetroReverseEntry) {
            obligations.androidMetroReverse = androidMetroReverseEntry;
          }
          const recorderEntry = obligation(recorderSource, recorderSource ? `${String(recorderSource.platform)}:${String(recorderSource.deviceId)}` : null);
          if (recorderEntry)
            obligations.recorder = recorderEntry;
          const runnerEntry = obligation(runnerSource, runnerSource ? `${String(runnerSource.platform)}:${String(runnerSource.deviceId)}:${String(runnerSource.port)}` : null);
          if (runnerEntry)
            obligations.runner = runnerEntry;
          const observeEntry = obligation(observeSource, observeSource ? String(observeSource.port) : null);
          if (observeEntry)
            obligations.observe = observeEntry;
          const metroEntry = obligation(metroSource, metroSource ? String(metroSource.port) : null);
          if (metroEntry)
            obligations.metro = metroEntry;
          const integrationBinding = record(bindings.packageIntegration);
          const integration = integrationBinding ? {
            installedBySessionId: integrationBinding.installedBySessionId ?? null,
            manifestSha256: integrationBinding.manifestSha256 ?? null,
            requestedAt: now,
            completedAt: null
          } : null;
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({
            ...bindings,
            startupCleanup: { journaledAt: now, obligations, integration }
          }), now, row.session_id, row.claim_epoch);
          return { resumed: false, obligations, integration };
        });
      }
      /** Re-recording an identical cleanup refusal is a no-op across repeated restarts. */
      recordStartupCleanupRefusal(prior, refusal) {
        const now = this.#now();
        this.#transaction(() => {
          const row = this.#requireProvenDeadStartupOwner(prior);
          const { bindings, journal } = this.#requireStartupCleanupJournal(row);
          if (typeof journal.finishedAt === "number")
            return;
          const existing = journal.refusal;
          if (existing && existing.code === refusal.code && existing.reason === refusal.reason && existing.nextAction === refusal.nextAction) {
            return;
          }
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({
            ...bindings,
            startupCleanup: {
              ...journal,
              refusal: {
                code: refusal.code,
                reason: refusal.reason,
                ...refusal.nextAction ? { nextAction: refusal.nextAction } : {}
              }
            }
          }), now, row.session_id, row.claim_epoch);
        });
      }
      verifyStartupOwnerObligation(prior, resource) {
        const row = this.#requireProvenDeadStartupOwner(prior);
        const { journal } = this.#requireStartupCleanupJournal(row);
        const entry = journal.obligations?.[resource];
        if (!entry || typeof entry !== "object")
          return null;
        const binding = entry;
        if (typeof binding.completedAt === "number")
          return binding;
        this.#assertStartupObligationScope(row, resource, binding);
        return binding;
      }
      completeStartupOwnerObligation(prior, resource) {
        const now = this.#now();
        this.#transaction(() => {
          const row = this.#requireProvenDeadStartupOwner(prior);
          const { bindings, journal } = this.#requireStartupCleanupJournal(row);
          const obligations = journal.obligations ?? {};
          const entry = obligations[resource];
          if (!entry || typeof entry !== "object")
            return;
          const binding = entry;
          if (typeof binding.completedAt === "number")
            return;
          if (typeof binding.stopRequestedAt !== "number") {
            throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", `${resource} cleanup was not durably requested`);
          }
          this.#assertStartupObligationScope(row, resource, binding);
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({
            ...bindings,
            startupCleanup: {
              ...journal,
              obligations: { ...obligations, [resource]: { ...binding, completedAt: now } }
            }
          }), now, row.session_id, row.claim_epoch);
        });
      }
      completeStartupOwnerIntegrationRestore(prior, input) {
        const now = this.#now();
        this.#transaction(() => {
          const row = this.#requireProvenDeadStartupOwner(prior);
          const { bindings, journal } = this.#requireStartupCleanupJournal(row);
          const integration = journal.integration;
          if (!integration || typeof integration !== "object")
            return;
          if (typeof integration.completedAt === "number")
            return;
          const binding = bindings.packageIntegration;
          if (!binding || typeof binding !== "object" || binding.manifestSha256 !== input.manifestSha256 || integration.manifestSha256 !== input.manifestSha256) {
            throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "integration restoration requires the recorded manifest authority");
          }
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({
            ...bindings,
            packageIntegration: null,
            startupCleanup: { ...journal, integration: { ...integration, completedAt: now } }
          }), now, row.session_id, row.claim_epoch);
        });
      }
      verifyStartupOwnerIntegrationRestore(prior, input) {
        const row = this.#requireProvenDeadStartupOwner(prior);
        this.#assertStartupSourceScope(row, input);
        const { bindings, journal } = this.#requireStartupCleanupJournal(row);
        const integration = journal.integration;
        const binding = bindings.packageIntegration;
        if (!integration || typeof integration !== "object" || typeof integration.completedAt === "number" || !binding || typeof binding !== "object" || binding.manifestSha256 !== input.manifestSha256 || integration.manifestSha256 !== input.manifestSha256) {
          throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "integration restoration requires the active startup journal and recorded manifest authority");
        }
      }
      finishStartupOwnerCleanup(prior) {
        const now = this.#now();
        this.#transaction(() => {
          const row = this.#requireProvenDeadStartupOwner(prior);
          const { bindings, journal } = this.#requireStartupCleanupJournal(row);
          const obligations = journal.obligations ?? {};
          for (const resource of ["androidMetroReverse", "recorder", "runner", "observe"]) {
            const entry = obligations[resource];
            if (entry && typeof entry === "object" && typeof entry.completedAt !== "number") {
              throw new SessionAuthorityError("AUTOMATION_CLEANUP_UNPROVEN", `${resource} cleanup has not been durably completed`);
            }
          }
          const metro = obligations.metro;
          if (metro && typeof metro === "object" && typeof metro.completedAt !== "number") {
            throw new SessionAuthorityError("METRO_CLEANUP_PENDING", "managed Metro cleanup has not been durably completed");
          }
          this.#requireIntegrationRestored(bindings);
          this.#database.prepare("DELETE FROM claims WHERE session_id = ? AND claim_epoch = ?").run(row.session_id, row.claim_epoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({ ...bindings, startupCleanup: { ...journal, finishedAt: now } }), now, row.session_id, row.claim_epoch);
        });
      }
      #requireProvenDeadStartupOwner(prior) {
        const row = asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key,
                  claim_epoch, state, supervisor_pid, supervisor_birth,
                  lease_until_ms, bindings_json
           FROM sessions WHERE session_id = ?`).get(prior.sessionId));
        if (!row || row.claim_epoch !== prior.claimEpoch) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "the startup cleanup owner no longer matches the proven claim epoch");
        }
        let status = "unknown";
        try {
          status = this.#ownerStatus({
            sessionId: row.session_id,
            pid: row.supervisor_pid,
            token: row.supervisor_birth
          });
        } catch {
          status = "unknown";
        }
        if (status === "match") {
          throw new SessionAuthorityError("RESOURCE_CLAIM_CONFLICT", OWNER_IDENTITY_REFUSAL_REASONS.sourceOwnerLive, { sessionId: row.session_id, claimEpoch: row.claim_epoch });
        }
        if (status !== "mismatch") {
          if (row.lease_until_ms < this.#now()) {
            throw new SessionAuthorityError("STALE_LEASE_NOT_RECLAIMABLE", OWNER_IDENTITY_REFUSAL_REASONS.leaseOwnerUnprovable, { sessionId: row.session_id, claimEpoch: row.claim_epoch });
          }
          throw new SessionAuthorityError("RESOURCE_CLAIM_CONFLICT", OWNER_IDENTITY_REFUSAL_REASONS.sourceOwnerUnprovable, { sessionId: row.session_id, claimEpoch: row.claim_epoch });
        }
        return row;
      }
      #requireStartupCleanupJournal(row) {
        const bindings = JSON.parse(row.bindings_json);
        const journal = bindings.startupCleanup;
        if (!journal || typeof journal !== "object") {
          throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "no startup cleanup is in progress");
        }
        return { bindings, journal };
      }
      #assertStartupSourceScope(row, input) {
        if (row.source_key !== input.sourceKey || row.worktree_key !== input.worktreeKey || row.app_root_key !== input.appRootKey) {
          throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "startup cleanup no longer matches the exact source and app root");
        }
      }
      #assertStartupObligationScope(row, resource, entry) {
        const claimType = resource === "observe" ? "observe-port" : resource === "metro" ? "metro-port" : resource === "androidMetroReverse" ? "device" : resource;
        const claimKey = String(entry.claimKey ?? "");
        const claim = this.#findClaim(claimType, claimKey);
        if (!claimKey || claim?.session_id !== row.session_id || claim.claim_epoch !== row.claim_epoch) {
          const codes = {
            androidMetroReverse: "PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN",
            recorder: "RECORDING_AUTHORITY_MISMATCH",
            runner: "RUNNER_OWNERSHIP_MISMATCH",
            observe: "OBSERVE_AUTHORITY_MISMATCH",
            metro: "METRO_AUTHORITY_MISMATCH"
          };
          throw new SessionAuthorityError(codes[resource], `startup ${resource} cleanup journal no longer owns its exact claim`);
        }
      }
      #requireStaleReleaseOwner(session2, workerInstance) {
        const row = this.#requireSession(session2);
        if (row.worker_instance !== workerInstance) {
          throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "stale device release is not owned by this worker");
        }
        const bindings = JSON.parse(row.bindings_json);
        const cleanup = bindings.staleDeviceCleanup;
        if (!cleanup || typeof cleanup !== "object") {
          throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "no stale device release is in progress");
        }
        const journal = cleanup;
        this.#assertStaleReleaseJournalScope(row, journal);
        return { row, bindings, cleanup: journal };
      }
      #assertNoStaleDeviceCleanup(bindings) {
        const cleanup = bindings.staleDeviceCleanup;
        if (!cleanup || typeof cleanup.platform !== "string" || typeof cleanup.deviceId !== "string") {
          return;
        }
        throw new SessionAuthorityError("AUTOMATION_CLEANUP_UNPROVEN", "stale device cleanup journal is incomplete", void 0, {
          axis: "D",
          nextAction: 'Resume it with rn_session({ action: "bind_device" }) for the exact journaled device or rn_session({ action: "release_stale_device" }) before binding any other device.'
        });
      }
      #assertStaleReleaseJournalScope(row, cleanup, target) {
        if (typeof cleanup.platform !== "string" || typeof cleanup.deviceId !== "string" || target && (cleanup.platform !== target.platform || cleanup.deviceId !== target.deviceId)) {
          throw new SessionAuthorityError("DEVICE_AUTHORITY_MISMATCH", "stale device cleanup journal does not match the requested exact device", void 0, { axis: "D", nextAction: 'Run rn_session with action "status" for the exact recovery.' });
        }
        const deviceKey = `${cleanup.platform}:${cleanup.deviceId}`;
        const deviceClaim = this.#findClaim("device", deviceKey);
        if (deviceClaim?.session_id !== row.session_id || deviceClaim.claim_epoch !== row.claim_epoch) {
          throw new SessionAuthorityError("DEVICE_AUTHORITY_MISMATCH", "stale device cleanup journal no longer owns its exact device claim");
        }
        const reverse = cleanup.androidMetroReverse;
        if (reverse && typeof reverse === "object" && typeof reverse.completedAt !== "number" && String(reverse.claimKey ?? "") !== deviceKey) {
          throw new SessionAuthorityError("PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN", "stale physical Android Metro cleanup journal no longer matches its exact device claim");
        }
        for (const resource of ["runner", "recorder"]) {
          const entry = cleanup[resource];
          if (!entry || typeof entry !== "object" || typeof entry.completedAt === "number") {
            continue;
          }
          const binding = entry;
          const claimType = resource === "runner" ? "runner" : "recorder";
          const expectedKey = resource === "runner" ? `${deviceKey}:${String(binding.port)}` : deviceKey;
          const claimKey = String(binding.claimKey ?? "");
          const claim = this.#findClaim(claimType, claimKey);
          if (claimKey !== expectedKey || claim?.session_id !== row.session_id || claim.claim_epoch !== row.claim_epoch) {
            throw new SessionAuthorityError(resource === "runner" ? "RUNNER_OWNERSHIP_MISMATCH" : "RECORDING_AUTHORITY_MISMATCH", `stale ${resource} cleanup journal no longer owns its exact claim`);
          }
        }
      }
      #deviceFamilyClaims(deviceKey) {
        return this.#database.prepare(`SELECT resource_type, resource_key, session_id, claim_epoch, lease_until_ms
         FROM claims
         WHERE (resource_type IN ('device', 'device-receipt', 'recorder') AND resource_key = ?)
            OR (resource_type IN ('runner', 'runner-receipt') AND resource_key LIKE ? ESCAPE '\\')
         ORDER BY resource_type, resource_key`).all(deviceKey, `${deviceKey.replace(/[\\%_]/g, "\\$&")}:%`);
      }
      #bindingMatchesDevice(binding, target) {
        if (!binding || typeof binding !== "object")
          return false;
        const record = binding;
        return record.platform === target.platform && record.deviceId === target.deviceId;
      }
      #requireProvenDeadOwner(sessionId, claimEpoch) {
        const prior = asSession(this.#database.prepare(`SELECT session_id, claim_epoch, state, supervisor_pid, supervisor_birth, bindings_json
           FROM sessions WHERE session_id = ?`).get(sessionId));
        if (!prior || prior.claim_epoch !== claimEpoch) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "the released owner no longer matches the proven claim epoch");
        }
        let status = "unknown";
        try {
          status = this.#ownerStatus({
            sessionId: prior.session_id,
            pid: prior.supervisor_pid,
            token: prior.supervisor_birth
          });
        } catch {
          status = "unknown";
        }
        if (status === "match") {
          throw new SessionAuthorityError("DEVICE_CLAIM_CONFLICT", "the device owner is live; a live owner is never released", { sessionId: prior.session_id, claimEpoch: prior.claim_epoch });
        }
        if (status !== "mismatch") {
          throw new SessionAuthorityError("STALE_LEASE_NOT_RECLAIMABLE", "the device owner identity could not be proven, so it is treated as live", { sessionId: prior.session_id, claimEpoch: prior.claim_epoch });
        }
        return prior;
      }
      updateBindings(session2, input) {
        const claimed = input.claimResources ?? [];
        const probes = input.probeClaimOwners && claimed.length > 0 ? this.#probeClaimOwners(session2, claimed) : null;
        const now = this.#now();
        this.#transaction(() => {
          const current = this.#requireSession(session2);
          if (input.expectedAuthorityVersion !== void 0 && current.authority_version !== input.expectedAuthorityVersion) {
            throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "session authority version changed before binding commit");
          }
          const bindings = {
            ...JSON.parse(current.bindings_json),
            ...input.bindings
          };
          this.#assertClaimsAvailable(session2, claimed, probes, now);
          if (Object.hasOwn(input.bindings, "device") || Object.hasOwn(input.bindings, "install")) {
            const currentBindings = JSON.parse(current.bindings_json);
            const platform = String((input.bindings.device ?? currentBindings.device)?.platform ?? "");
            if (platform) {
              this.#invalidatePlatformReceipt(session2, platform);
            }
          }
          for (const resource of input.releaseResources ?? []) {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(resource.type, resource.key, session2.sessionId, session2.claimEpoch);
          }
          const leaseUntil = now + this.#leaseMs;
          for (const resource of input.claimResources ?? []) {
            this.#database.prepare(`INSERT INTO claims(
              resource_type, resource_key, session_id, claim_epoch, lease_until_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(resource_type, resource_key) DO UPDATE SET
              session_id = excluded.session_id,
              claim_epoch = excluded.claim_epoch,
              lease_until_ms = excluded.lease_until_ms`).run(resource.type, resource.key, session2.sessionId, session2.claimEpoch, leaseUntil);
          }
          this.#database.prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(input.state ?? current.state, JSON.stringify(bindings), now, session2.sessionId, session2.claimEpoch);
          this.#advanceActiveOperationFence(session2, current.authority_version, current.authority_version + 1);
        }, input.assertBeforeCommit, input.onCommitted);
      }
      replaceBindingsDuringOperation(operation, input) {
        const now = this.#now();
        return this.#transaction(() => {
          const current = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`).get(operation.sessionId));
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          if (!current || !isOperationalState(current.state) || current.claim_epoch !== operation.claimEpoch || current.authority_version !== operation.authorityVersion || !active) {
            throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "operation fence no longer matches current authority");
          }
          for (const resource of input.claimResources ?? []) {
            const claim = this.#findConflictingClaim(resource);
            if (claim && (claim.session_id !== operation.sessionId || claim.claim_epoch !== operation.claimEpoch)) {
              throw claimConflict(claim);
            }
          }
          for (const resource of input.releaseResources ?? []) {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(resource.type, resource.key, operation.sessionId, operation.claimEpoch);
          }
          const leaseUntil = now + this.#leaseMs;
          for (const resource of input.claimResources ?? []) {
            this.#database.prepare(`INSERT INTO claims(
              resource_type, resource_key, session_id, claim_epoch, lease_until_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(resource_type, resource_key) DO UPDATE SET
              session_id = excluded.session_id,
              claim_epoch = excluded.claim_epoch,
              lease_until_ms = excluded.lease_until_ms`).run(resource.type, resource.key, operation.sessionId, operation.claimEpoch, leaseUntil);
          }
          const nextAuthorityVersion = operation.authorityVersion + 1;
          const bindings = {
            ...JSON.parse(current.bindings_json),
            ...input.bindings
          };
          this.#database.prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND authority_version = ?`).run(input.state ?? current.state, JSON.stringify(bindings), nextAuthorityVersion, now, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          this.#database.prepare(`UPDATE operations SET authority_version = ?, lease_until_ms = ?
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).run(nextAuthorityVersion, leaseUntil, operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          const context = this.#operationContext.getStore();
          if (context?.operationId === operation.operationId) {
            context.authorityVersion = nextAuthorityVersion;
          }
          return { ...operation, authorityVersion: nextAuthorityVersion };
        }, input.assertBeforeCommit, input.onCommitted);
      }
      endOperationWithBindings(operation, bindings) {
        const now = this.#now();
        this.#transaction(() => {
          const current = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`).get(operation.sessionId));
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          if (!current || !isOperationalState(current.state) || current.claim_epoch !== operation.claimEpoch || current.authority_version !== operation.authorityVersion || !active) {
            throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "operation fence no longer matches current authority");
          }
          const nextBindings = {
            ...JSON.parse(current.bindings_json),
            ...bindings
          };
          this.#database.prepare(`UPDATE sessions
           SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND authority_version = ?`).run(JSON.stringify(nextBindings), now, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          this.#database.prepare(`DELETE FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).run(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
      }
      getSessionStatus(sessionId) {
        const row = asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                  claim_epoch, authority_version, supervisor_pid, supervisor_birth,
                  worker_instance, worker_pid, worker_birth, lease_until_ms,
                  source_json, bindings_json
           FROM sessions WHERE session_id = ?`).get(sessionId));
        if (!row)
          return null;
        const claims = this.#database.prepare(`SELECT resource_type, resource_key, session_id, claim_epoch, lease_until_ms
         FROM claims WHERE session_id = ? AND claim_epoch = ?
         ORDER BY resource_type, resource_key`).all(sessionId, row.claim_epoch).map((claim) => {
          const typed = claim;
          return {
            type: typed.resource_type,
            key: typed.resource_key,
            sessionId: typed.session_id,
            claimEpoch: typed.claim_epoch,
            leaseUntilMs: typed.lease_until_ms
          };
        });
        return {
          sessionId: row.session_id,
          sourceKey: row.source_key,
          worktreeKey: row.worktree_key,
          appRootKey: row.app_root_key,
          state: row.state,
          claimEpoch: row.claim_epoch,
          authorityVersion: row.authority_version,
          leaseUntilMs: row.lease_until_ms,
          source: JSON.parse(row.source_json),
          bindings: JSON.parse(row.bindings_json),
          claims,
          worker: {
            instanceId: row.worker_instance,
            pid: row.worker_pid,
            birthAvailable: row.worker_birth !== null
          }
        };
      }
      countOtherOperationalSessions(sessionId) {
        const rows = this.#database.prepare(`SELECT state FROM sessions
         WHERE session_id <> ?`).all(sessionId);
        return rows.filter((row) => typeof row.state === "string" && isOperationalState(row.state)).length;
      }
      isMetroEvidenceSocketReferencedByOtherSession(sessionId, path) {
        const rows = this.#database.prepare(`SELECT bindings_json FROM sessions
         WHERE session_id <> ? AND state <> 'released'`).all(sessionId);
        return rows.some((row) => {
          try {
            return referencesMetroEvidenceSocket(JSON.parse(String(row.bindings_json)), path);
          } catch {
            return true;
          }
        });
      }
      // GH #706: released and proven-stale rows are not live sessions, so they never
      // count towards the "multiple live sessions match this worktree" refusal.
      findSessionsByWorktree(worktreeKey) {
        const rows = this.#database.prepare(`SELECT session_id, supervisor_pid, supervisor_birth FROM sessions
         WHERE worktree_key = ? AND state NOT IN ('released', 'stale')
         ORDER BY updated_ms DESC`).all(worktreeKey);
        return rows.filter((row) => !this.#supervisorProvenDead(row)).map((row) => this.getSessionStatus(row.session_id)).filter((status) => status !== null);
      }
      #supervisorProvenDead(row) {
        try {
          return this.#ownerStatus({
            sessionId: row.session_id,
            pid: row.supervisor_pid,
            token: row.supervisor_birth
          }) === "mismatch";
        } catch {
          return false;
        }
      }
      getControllerBinding(session2) {
        const row = this.#requireSession(session2);
        return this.#controllerBinding(row);
      }
      getHandoffCancellationControllerBinding(session2) {
        const row = this.#requireHandoffSession(session2);
        return this.#controllerBinding(row);
      }
      #controllerBinding(row) {
        return {
          sessionId: row.session_id,
          claimEpoch: row.claim_epoch,
          authorityVersion: row.authority_version,
          supervisor: { pid: row.supervisor_pid, token: row.supervisor_birth },
          worker: {
            instanceId: row.worker_instance,
            pid: row.worker_pid,
            token: row.worker_birth
          }
        };
      }
      beginSessionClose(session2) {
        const now = this.#now();
        const operationIds = this.#transaction(() => {
          const current = this.#requireSession(session2);
          const active = this.#database.prepare(`SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(session2.sessionId, session2.claimEpoch);
          const bindings = JSON.parse(current.bindings_json);
          this.#requireIntegrationRestored(bindings);
          const metro = bindings.metroCleanup ?? bindings.metro;
          if (active?.profile === "transition:ensure-metro" && metro?.mode !== "managed") {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "managed Metro transition has not published exact cleanup authority");
          }
          const rows = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ?`).all(session2.sessionId, session2.claimEpoch);
          this.#database.prepare("DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?").run(session2.sessionId, session2.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'closing', authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, session2.sessionId, session2.claimEpoch);
          return rows.map((row) => String(row.operation_id));
        });
        for (const operationId of operationIds) {
          this.#pendingPlatformReceipts.delete(operationId);
        }
        const status = this.getSessionStatus(session2.sessionId);
        if (!status || status.state !== "closing") {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "session close reservation did not persist");
        }
        return status;
      }
      completeSessionClose(session2) {
        const now = this.#now();
        this.#transaction(() => {
          const row = asSession(this.#database.prepare("SELECT state, claim_epoch, bindings_json FROM sessions WHERE session_id = ?").get(session2.sessionId));
          if (!row || row.state !== "closing" || row.claim_epoch !== session2.claimEpoch) {
            throw new SessionAuthorityError("SESSION_OWNER_LOST", "only the unchanged closing session may be released");
          }
          this.#requireIntegrationRestored(JSON.parse(String(row.bindings_json)));
          this.#database.prepare("DELETE FROM claims WHERE session_id = ? AND claim_epoch = ?").run(session2.sessionId, session2.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'closing'`).run(now, session2.sessionId, session2.claimEpoch);
        });
      }
      releaseSession(session2) {
        const now = this.#now();
        this.#transaction(() => {
          const current = this.#requireSession(session2);
          this.#requireIntegrationRestored(JSON.parse(current.bindings_json));
          const active = this.#database.prepare(`SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(session2.sessionId, session2.claimEpoch);
          if (active && !String(active.profile).startsWith("transition:")) {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "session cannot be released while an operation is active");
          }
          if (active) {
            const context = this.#operationContext.getStore();
            if (!context || context.operationId !== active.operation_id || context.sessionId !== session2.sessionId || context.claimEpoch !== session2.claimEpoch) {
              throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "session release is not owned by the active operation fence");
            }
            this.#database.prepare("DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?").run(session2.sessionId, session2.claimEpoch);
          }
          this.#database.prepare("DELETE FROM claims WHERE session_id = ? AND claim_epoch = ?").run(session2.sessionId, session2.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, session2.sessionId, session2.claimEpoch);
        });
      }
      #discardAbsentBlockedContenders(input) {
        if (this.#findClaim("source", input.worktreeKey))
          return;
        const rows = this.#database.prepare(`SELECT session_id, claim_epoch FROM sessions
         WHERE state = 'blocked' AND source_key = ? AND worktree_key = ? AND app_root_key = ?`).all(input.sourceKey, input.worktreeKey, input.appRootKey);
        const now = this.#now();
        for (const row of rows) {
          const requirement = this.inspectRecoveryRequirement(row.session_id);
          if (requirement.requirement !== "transport-restart" || requirement.priorOwner !== "absent") {
            continue;
          }
          const owned = this.#database.prepare("SELECT resource_key FROM claims WHERE session_id = ? LIMIT 1").get(row.session_id);
          if (owned)
            continue;
          this.#database.prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'blocked'`).run(now, row.session_id, row.claim_epoch);
        }
      }
      discardBlockedSession(session2) {
        const now = this.#now();
        this.#transaction(() => {
          const row = asSession(this.#database.prepare("SELECT state, claim_epoch FROM sessions WHERE session_id = ?").get(session2.sessionId));
          if (!row || row.state !== "blocked" || row.claim_epoch !== session2.claimEpoch) {
            throw new SessionAuthorityError("SESSION_OWNER_LOST", "only the unchanged blocked session may be discarded");
          }
          const claim = this.#database.prepare("SELECT resource_key FROM claims WHERE session_id = ? LIMIT 1").get(session2.sessionId);
          if (claim) {
            throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "blocked session unexpectedly owns resource claims");
          }
          this.#database.prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, session2.sessionId, session2.claimEpoch);
        });
      }
      /** GH #792: the ownership picture headless recovery reports; releases nothing. */
      inspectSourceOwnership(input) {
        const abandonedContenders = this.#countAbandonedBlockedContenders(input.worktreeKey);
        const claim = this.#findClaim("source", input.worktreeKey);
        if (!claim)
          return { owner: "absent", sameRoot: false, abandonedContenders };
        const row = asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, claim_epoch,
                  supervisor_pid, supervisor_birth, source_json, bindings_json
           FROM sessions WHERE session_id = ?`).get(claim.session_id));
        if (!row)
          return { owner: "absent", sameRoot: false, abandonedContenders };
        const ownerAppRoot = readSourceAppRoot(row.source_json);
        let status = "unknown";
        try {
          status = this.#ownerStatus({
            sessionId: row.session_id,
            pid: row.supervisor_pid,
            token: row.supervisor_birth
          });
        } catch {
          status = "unknown";
        }
        const blocked = readStartupCleanupBlocker(row.bindings_json);
        const sameAppRoot = row.worktree_key === input.worktreeKey && row.app_root_key === input.appRootKey;
        const sameSource = row.source_key === input.sourceKey;
        return {
          owner: status === "match" ? "live" : status === "mismatch" ? "stale" : "unprovable",
          sameRoot: sameAppRoot && sameSource,
          ...sameAppRoot ? sameSource ? {} : { mismatch: "source-identity" } : { mismatch: "app-root" },
          abandonedContenders,
          holder: {
            session: row.session_id.slice(0, 12),
            ...ownerAppRoot === void 0 ? {} : { appRoot: ownerAppRoot }
          },
          ...blocked ? { startupCleanupBlocked: blocked } : {}
        };
      }
      #countAbandonedBlockedContenders(worktreeKey) {
        const rows = this.#database.prepare(`SELECT session_id, supervisor_pid, supervisor_birth FROM sessions
         WHERE worktree_key = ? AND state = 'blocked'
           AND NOT EXISTS (SELECT 1 FROM claims WHERE claims.session_id = sessions.session_id)`).all(worktreeKey);
        return rows.filter((row) => this.#supervisorProvenDead(row)).length;
      }
      /**
       * GH #792: a blocked contender holds no authority, so an abandoned row must not survive
       * as the next attempt's prior owner. Proven-dead and claim-less only.
       */
      discardAbandonedBlockedContenders(worktreeKey) {
        const rows = this.#database.prepare(`SELECT session_id, claim_epoch, supervisor_pid, supervisor_birth
         FROM sessions WHERE worktree_key = ? AND state = 'blocked'
         ORDER BY updated_ms ASC`).all(worktreeKey);
        const discarded = [];
        for (const row of rows) {
          if (!this.#supervisorProvenDead(row))
            continue;
          try {
            const now = this.#now();
            const released = this.#transaction(() => {
              const claim = this.#database.prepare("SELECT resource_key FROM claims WHERE session_id = ? LIMIT 1").get(row.session_id);
              if (claim)
                return false;
              const update = this.#database.prepare(`UPDATE sessions
               SET state = 'released', claim_epoch = claim_epoch + 1,
                   authority_version = authority_version + 1, updated_ms = ?
               WHERE session_id = ? AND claim_epoch = ? AND state = 'blocked'`).run(now, row.session_id, row.claim_epoch);
              return update.changes === 1;
            });
            if (released)
              discarded.push(row.session_id);
          } catch {
          }
        }
        return discarded;
      }
      prepareHandoff(session2, input) {
        const now = this.#now();
        const handoffId = randomBytes(16).toString("hex");
        const token2 = randomBytes(32).toString("base64url");
        const tokenHash = createHash2("sha256").update(token2).digest("hex");
        this.#transaction(() => {
          const current = this.#requireSession(session2);
          let targetInstance = input.targetInstance;
          if (input.targetHandle) {
            const targets = this.#database.prepare(`SELECT session_id, bindings_json FROM sessions
             WHERE state = 'blocked' AND source_key = ? AND worktree_key = ? AND app_root_key = ?`).all(current.source_key, current.worktree_key, current.app_root_key);
            for (const target of targets) {
              const bindings = JSON.parse(target.bindings_json);
              const handles = bindings.recoveryHandles;
              const handle = handles?.handoffRecipient;
              if (handle && this.#recoveryHandleMatches(handle, input.targetHandle, now)) {
                targetInstance = typeof handle.workerInstance === "string" ? handle.workerInstance : void 0;
                this.#database.prepare("UPDATE sessions SET bindings_json = ? WHERE session_id = ?").run(JSON.stringify({
                  ...bindings,
                  recoveryHandles: { ...handles, handoffRecipient: null }
                }), target.session_id);
                break;
              }
            }
          }
          if (!targetInstance) {
            throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "handoff recipient capability is invalid or expired");
          }
          const active = this.#database.prepare(`SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(session2.sessionId, session2.claimEpoch);
          if (active && !String(active.profile).startsWith("transition:")) {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "session cannot enter handoff while an operation is active");
          }
          this.#database.prepare(`INSERT INTO handoffs(
            handoff_id, session_id, claim_epoch, target_instance,
            token_hash, source_state, expires_ms, consumed_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`).run(handoffId, session2.sessionId, session2.claimEpoch, targetInstance, tokenHash, this.#requireSession(session2).state, now + (input.ttlMs ?? 15e3));
          this.#database.prepare(`UPDATE sessions
           SET state = 'handoff', authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, session2.sessionId, session2.claimEpoch);
          this.#advanceActiveOperationFence(session2, current.authority_version, current.authority_version + 1);
        });
        return { handoffId, token: token2 };
      }
      prepareHandoffForHandle(session2, input) {
        return this.prepareHandoff(session2, input);
      }
      cancelHandoff(session2, handoffId) {
        const now = this.#now();
        this.#transaction(() => {
          const handoff = this.#database.prepare(`SELECT session_id, claim_epoch, source_state, consumed_ms
           FROM handoffs WHERE handoff_id = ?`).get(handoffId);
          if (!handoff || handoff.session_id !== session2.sessionId || handoff.claim_epoch !== session2.claimEpoch) {
            throw new SessionAuthorityError("HANDOFF_NOT_FOUND", "handoff does not belong to session");
          }
          if (handoff.consumed_ms !== null) {
            throw new SessionAuthorityError("HANDOFF_ALREADY_CONSUMED", "handoff is already terminal");
          }
          const row = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`).get(session2.sessionId));
          if (!row || row.state !== "handoff" || row.claim_epoch !== session2.claimEpoch) {
            throw new SessionAuthorityError("SESSION_OWNER_LOST", "handoff source owner changed");
          }
          const bindings = JSON.parse(row.bindings_json);
          if (bindings.managedMetroHandoffReservation) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff cancellation is fenced while managed Metro shutdown is reserved");
          }
          this.#database.prepare(`UPDATE sessions
           SET state = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(handoff.source_state, now, session2.sessionId, session2.claimEpoch);
          this.#database.prepare("UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?").run(now, handoffId);
          this.#advanceActiveOperationFence(session2, row.authority_version, row.authority_version + 1);
        });
      }
      getHandoffOwner(handoffId) {
        const row = this.#database.prepare("SELECT session_id FROM handoffs WHERE handoff_id = ?").get(handoffId);
        return typeof row?.session_id === "string" ? row.session_id : null;
      }
      reserveManagedMetroHandoffCleanup(target, input) {
        const now = this.#now();
        return this.#transaction(() => {
          const context = this.#requireHandoffIntoContext(target, input, {
            allowExactReservationAfterExpiry: true,
            commitRecipientRotation: true
          });
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ?
              OR (session_id = ? AND profile NOT LIKE 'transition:%')
           LIMIT 1`).get(context.prior.session_id, target.sessionId);
          if (active) {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "handoff cleanup cannot be reserved while either session has an active operation");
          }
          const managedMetro = context.bindings.metro && typeof context.bindings.metro === "object" && context.bindings.metro.mode === "managed" ? context.bindings.metro : null;
          if (!managedMetro)
            return null;
          if (context.reservation)
            return context.reservation;
          const reservation = {
            handoffId: context.handoff.handoff_id,
            sourceClaimEpoch: context.handoff.claim_epoch,
            targetSessionId: target.sessionId,
            targetClaimEpoch: target.claimEpoch,
            targetInstance: input.targetInstance,
            phase: "shutdown_reserved",
            metro: {
              ...managedMetro,
              sourceSessionId: context.prior.session_id,
              stopRequestedAt: now,
              completedAt: null
            }
          };
          this.#database.prepare(`UPDATE sessions
           SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`).run(JSON.stringify({
            ...context.bindings,
            managedMetroHandoffReservation: reservation
          }), now, context.prior.session_id, context.prior.claim_epoch);
          return reservation;
        });
      }
      completeManagedMetroHandoffCleanup(target, input) {
        const now = this.#now();
        return this.#transaction(() => {
          const context = this.#requireHandoffIntoContext(target, input, {
            allowExactReservationAfterExpiry: true,
            commitRecipientRotation: true
          });
          const reservation = context.reservation;
          if (!reservation) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro shutdown has no durable handoff reservation");
          }
          if (reservation.phase === "shutdown_completed")
            return reservation;
          const completed = {
            ...reservation,
            phase: "shutdown_completed",
            metro: { ...reservation.metro, completedAt: now }
          };
          this.#database.prepare(`UPDATE sessions
           SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`).run(JSON.stringify({
            ...context.bindings,
            managedMetroHandoffReservation: completed
          }), now, context.prior.session_id, context.prior.claim_epoch);
          return completed;
        });
      }
      refuseManagedMetroHandoffCleanup(target, input) {
        const now = this.#now();
        this.#transaction(() => {
          const context = this.#requireHandoffIntoContext(target, input, {
            allowExactReservationAfterExpiry: true,
            commitRecipientRotation: true
          });
          const reservation = context.reservation;
          if (!reservation || reservation.phase !== "shutdown_reserved") {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro shutdown refusal does not match an active reservation");
          }
          const sourceState2 = this.#database.prepare("SELECT source_state FROM handoffs WHERE handoff_id = ?").get(input.handoffId);
          if (typeof sourceState2?.source_state !== "string") {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff source state is unavailable for donor restoration");
          }
          this.#database.prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`).run(sourceState2.source_state, JSON.stringify({
            ...context.bindings,
            managedMetroHandoffReservation: null
          }), now, context.prior.session_id, context.prior.claim_epoch);
          this.#database.prepare("UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?").run(now, input.handoffId);
        });
      }
      validateHandoffInto(target, input) {
        this.#transaction(() => {
          this.#requireHandoffIntoContext(target, input, {
            allowExactReservationAfterExpiry: false,
            commitRecipientRotation: false
          });
        });
      }
      validateHandoffCleanupResumption(target, input) {
        this.#transaction(() => {
          const row = asSession(this.#database.prepare(`SELECT state, claim_epoch, worker_instance, bindings_json
             FROM sessions WHERE session_id = ?`).get(target.sessionId));
          const bindings = row ? JSON.parse(row.bindings_json) : {};
          const cleanup = bindings.handoffCleanup && typeof bindings.handoffCleanup === "object" ? bindings.handoffCleanup : null;
          const handoff = this.#database.prepare("SELECT token_hash, consumed_ms FROM handoffs WHERE handoff_id = ?").get(input.handoffId);
          const expected = Buffer.from(typeof handoff?.token_hash === "string" ? handoff.token_hash : "", "hex");
          const actual = createHash2("sha256").update(input.token).digest();
          const tokenMatches = expected.length === actual.length && timingSafeEqual(expected, actual);
          if (!row || row.state !== "handoff_cleanup" || row.claim_epoch !== target.claimEpoch || row.worker_instance !== input.targetInstance || cleanup?.handoffId !== input.handoffId || cleanup?.targetSessionId !== target.sessionId || cleanup?.targetClaimEpoch !== target.claimEpoch || typeof handoff?.consumed_ms !== "number" || !tokenMatches) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff cleanup resumption requires the original handoff capability");
          }
        });
      }
      acceptHandoff(input) {
        const now = this.#now();
        return this.#transaction(() => {
          const handoff = this.#database.prepare(`SELECT handoff_id, session_id, claim_epoch, target_instance,
                  token_hash, expires_ms, consumed_ms
           FROM handoffs WHERE handoff_id = ?`).get(input.handoffId);
          if (!handoff) {
            throw new SessionAuthorityError("HANDOFF_NOT_FOUND", "handoff does not exist");
          }
          if (handoff.consumed_ms !== null) {
            throw new SessionAuthorityError("HANDOFF_ALREADY_CONSUMED", "handoff was already accepted");
          }
          if (handoff.expires_ms < now) {
            throw new SessionAuthorityError("HANDOFF_EXPIRED", "handoff capability expired");
          }
          if (handoff.target_instance !== input.targetInstance) {
            throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "handoff target instance does not match");
          }
          const expected = Buffer.from(handoff.token_hash, "hex");
          const actual = Buffer.from(createHash2("sha256").update(input.token).digest("hex"), "hex");
          if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            throw new SessionAuthorityError("HANDOFF_TOKEN_INVALID", "handoff capability is invalid");
          }
          const session2 = asSession(this.#database.prepare(`SELECT session_id, state, claim_epoch, authority_version,
                    supervisor_pid, supervisor_birth, lease_until_ms, bindings_json
             FROM sessions WHERE session_id = ?`).get(handoff.session_id));
          if (!session2 || session2.state !== "handoff" || session2.claim_epoch !== handoff.claim_epoch) {
            throw new SessionAuthorityError("SESSION_OWNER_LOST", "handoff no longer matches the session claim epoch");
          }
          const sessionBindings = JSON.parse(session2.bindings_json);
          if (sessionBindings.metro && typeof sessionBindings.metro === "object" && sessionBindings.metro.mode === "managed") {
            throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "managed Metro handoff requires durable cleanup through a blocked recipient");
          }
          const nextEpoch = session2.claim_epoch + 1;
          const leaseUntil = now + this.#leaseMs;
          this.#database.prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device', 'recorder')`).run(session2.session_id, session2.claim_epoch);
          this.#database.prepare(`UPDATE claims SET claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(nextEpoch, leaseUntil, session2.session_id, session2.claim_epoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'source_bound', claim_epoch = ?, authority_version = authority_version + 1,
               supervisor_pid = ?, supervisor_birth = ?, heartbeat_ms = ?,
               lease_until_ms = ?, bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(nextEpoch, input.supervisor.pid, input.supervisor.token, now, leaseUntil, JSON.stringify({
            ...sessionBindings,
            bundle: null,
            runner: null,
            observe: null,
            proof: null,
            pendingBuild: null
          }), now, session2.session_id, session2.claim_epoch);
          this.#database.prepare("UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?").run(now, handoff.handoff_id);
          return { sessionId: session2.session_id, claimEpoch: nextEpoch };
        });
      }
      acceptHandoffInto(target, input) {
        const now = this.#now();
        return this.#transaction(() => {
          const context = this.#requireHandoffIntoContext(target, input, {
            allowExactReservationAfterExpiry: true,
            commitRecipientRotation: true
          });
          const { targetRow, handoff, prior, bindings } = context;
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ?
              OR (session_id = ? AND profile NOT LIKE 'transition:%')
           LIMIT 1`).get(prior.session_id, target.sessionId);
          if (active) {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "handoff cannot transfer while either session has an active operation");
          }
          const priorRunnerClaim = this.#database.prepare(`SELECT resource_key FROM claims
           WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'runner'`).get(prior.session_id, prior.claim_epoch);
          if (bindingsRunnerPresent(prior.bindings_json) && !priorRunnerClaim?.resource_key) {
            throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "handoff runner binding has no exclusive cleanup claim");
          }
          const managedMetro = bindings.metro && typeof bindings.metro === "object" && bindings.metro.mode === "managed" ? bindings.metro : null;
          if (managedMetro && (!context.reservation || context.reservation.phase !== "shutdown_completed" || typeof context.reservation.metro.completedAt !== "number")) {
            throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "managed Metro shutdown reservation must be durably completed before ownership transfers");
          }
          const priorRecorderClaim = this.#database.prepare(`SELECT resource_key FROM claims
           WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'recorder'`).get(prior.session_id, prior.claim_epoch);
          if (bindings.recorder && !priorRecorderClaim?.resource_key) {
            throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "handoff recorder binding has no exclusive cleanup claim");
          }
          this.#database.prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?`).run(target.sessionId, target.claimEpoch);
          this.#database.prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device', 'runner', 'recorder')`).run(prior.session_id, prior.claim_epoch);
          this.#database.prepare(`UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(target.sessionId, target.claimEpoch, now + this.#leaseMs, prior.session_id, prior.claim_epoch);
          const targetBindings = JSON.parse(targetRow.bindings_json);
          this.#database.prepare(`UPDATE sessions
           SET state = 'handoff_cleanup', bindings_json = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({
            ...bindings,
            managedMetroHandoffReservation: null,
            metro: managedMetro ? null : bindings.metro,
            bundle: null,
            runner: null,
            recorder: null,
            observe: null,
            proof: null,
            pendingBuild: null,
            recoveryCapabilityHash: targetBindings.recoveryCapabilityHash,
            handoffCleanup: {
              handoffId: handoff.handoff_id,
              targetSessionId: target.sessionId,
              targetClaimEpoch: target.claimEpoch,
              metro: null,
              observe: bindings.observe && typeof bindings.observe === "object" ? {
                ...bindings.observe,
                stopRequestedAt: null,
                completedAt: null
              } : null,
              runner: bindings.runner && typeof bindings.runner === "object" ? {
                ...bindings.runner,
                claimKey: priorRunnerClaim?.resource_key,
                stopRequestedAt: null,
                completedAt: null
              } : null,
              recorder: bindings.recorder && typeof bindings.recorder === "object" ? {
                ...bindings.recorder,
                claimKey: priorRecorderClaim?.resource_key,
                stopRequestedAt: null,
                completedAt: null
              } : null
            }
          }), now, target.sessionId, target.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, prior.session_id, prior.claim_epoch);
          this.#database.prepare("UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?").run(now, handoff.handoff_id);
          return {
            ...this.getSessionStatus(target.sessionId)?.bindings.handoffCleanup
          };
        });
      }
      beginHandoffCleanupResource(target, targetInstance, resource) {
        const now = this.#now();
        return this.#transaction(() => {
          const row = this.#requireHandoffCleanupOwner(target, targetInstance);
          const bindings = JSON.parse(row.bindings_json);
          const cleanup = bindings.handoffCleanup;
          const current = cleanup?.[resource];
          if (!current || typeof current !== "object")
            return null;
          const binding = current;
          if (typeof binding.completedAt === "number")
            return binding;
          if (resource === "runner") {
            const claimKey = String(binding.claimKey ?? "");
            const expectedClaimKey = `${String(binding.platform)}:${String(binding.deviceId)}:${String(binding.port)}`;
            const claim = this.#findClaim("runner", claimKey);
            if (!claimKey || claimKey !== expectedClaimKey || claim?.session_id !== target.sessionId || claim.claim_epoch !== target.claimEpoch || typeof binding.capability !== "string" || typeof binding.instanceId !== "string") {
              throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "handoff runner cleanup claim no longer matches the authenticated binding");
            }
          }
          if (resource === "recorder") {
            const claimKey = String(binding.claimKey ?? "");
            const expectedClaimKey = `${String(binding.platform)}:${String(binding.deviceId)}`;
            const claim = this.#findClaim("recorder", claimKey);
            if (!claimKey || claimKey !== expectedClaimKey || claim?.session_id !== target.sessionId || claim.claim_epoch !== target.claimEpoch || typeof binding.scope !== "string" || binding.phase !== "starting" && typeof binding.processBirth !== "string") {
              throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "handoff recorder cleanup claim no longer matches the authenticated binding");
            }
          }
          if (resource === "metro") {
            const claim = this.#findClaim("metro-port", String(binding.port));
            if (binding.port !== bindings.metroPort || claim?.session_id !== target.sessionId || claim.claim_epoch !== target.claimEpoch) {
              throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "handoff Metro cleanup claim no longer matches the authenticated binding");
            }
          }
          if (resource === "observe") {
            const claim = this.#findClaim("observe-port", String(binding.port));
            if (binding.port !== bindings.observePort || claim?.session_id !== target.sessionId || claim.claim_epoch !== target.claimEpoch) {
              throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "handoff Observe cleanup claim no longer matches the authenticated binding");
            }
          }
          const requested = {
            ...binding,
            stopRequestedAt: typeof binding.stopRequestedAt === "number" ? binding.stopRequestedAt : now
          };
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`).run(JSON.stringify({
            ...bindings,
            handoffCleanup: { ...cleanup, [resource]: requested }
          }), now, target.sessionId, target.claimEpoch);
          return requested;
        });
      }
      completeHandoffCleanupResource(target, targetInstance, resource) {
        const now = this.#now();
        this.#transaction(() => {
          const row = this.#requireHandoffCleanupOwner(target, targetInstance);
          const bindings = JSON.parse(row.bindings_json);
          const cleanup = bindings.handoffCleanup;
          const current = cleanup?.[resource];
          if (!current || typeof current !== "object")
            return;
          const binding = current;
          if (typeof binding.stopRequestedAt !== "number") {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", `${resource} cleanup was not durably requested`);
          }
          if (typeof binding.completedAt === "number")
            return;
          if (resource === "runner") {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = 'runner' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(String(binding.claimKey), target.sessionId, target.claimEpoch);
          }
          if (resource === "recorder") {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = 'recorder' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(String(binding.claimKey), target.sessionId, target.claimEpoch);
          }
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`).run(JSON.stringify({
            ...bindings,
            handoffCleanup: {
              ...cleanup,
              [resource]: { ...binding, completedAt: now }
            }
          }), now, target.sessionId, target.claimEpoch);
        });
      }
      finishHandoffCleanup(target, targetInstance) {
        const now = this.#now();
        this.#transaction(() => {
          const row = asSession(this.#database.prepare(`SELECT state, claim_epoch, worker_instance, bindings_json
             FROM sessions WHERE session_id = ?`).get(target.sessionId));
          if (!row || row.state !== "handoff_cleanup" || row.claim_epoch !== target.claimEpoch || row.worker_instance !== targetInstance) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff cleanup is not owned by this recovery worker");
          }
          const bindings = JSON.parse(row.bindings_json);
          const cleanup = bindings.handoffCleanup;
          for (const resource of ["metro", "runner", "observe", "recorder"]) {
            const binding = cleanup?.[resource];
            if (binding && typeof binding === "object" && typeof binding.completedAt !== "number") {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", `${resource} cleanup has not been durably completed`);
            }
          }
          const staleDeviceCleanup = bindings.staleDeviceCleanup;
          if (staleDeviceCleanup && typeof staleDeviceCleanup.platform === "string" && typeof staleDeviceCleanup.deviceId === "string") {
            const deviceKey = `${staleDeviceCleanup.platform}:${staleDeviceCleanup.deviceId}`;
            for (const claim of this.#deviceFamilyClaims(deviceKey)) {
              if (claim.session_id !== target.sessionId || claim.claim_epoch !== target.claimEpoch) {
                continue;
              }
              this.#database.prepare(`DELETE FROM claims
               WHERE resource_type = ? AND resource_key = ?
                 AND session_id = ? AND claim_epoch = ?`).run(claim.resource_type, claim.resource_key, target.sessionId, target.claimEpoch);
            }
          }
          this.#database.prepare(`UPDATE sessions
           SET state = 'source_bound', bindings_json = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`).run(JSON.stringify({
            ...bindings,
            handoffCleanup: null,
            recoveryHandles: null,
            staleDeviceCleanup: null,
            staleDeviceRelease: null
          }), now, target.sessionId, target.claimEpoch);
        });
      }
      recordPlatformAuthorityReceipt(session2, platform, receipt) {
        const operation = this.#operationContext.getStore();
        if (!operation || operation.sessionId !== session2.sessionId || operation.claimEpoch !== session2.claimEpoch) {
          throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "platform receipt recording requires the active operation fence");
        }
        this.verifyOperation(operation);
        const staged = this.#platformReceiptFromCurrentAuthority(session2, platform, receipt);
        const pending = this.#pendingPlatformReceipts.get(operation.operationId) ?? [];
        pending.push(staged);
        this.#pendingPlatformReceipts.set(operation.operationId, pending);
      }
      commitPlatformAuthorityReceipts(operation) {
        const pending = this.#pendingPlatformReceipts.get(operation.operationId) ?? [];
        if (pending.length === 0)
          return;
        const now = this.#now();
        this.#transaction(() => {
          this.verifyOperation(operation);
          for (const staged of pending) {
            const current = this.#platformReceiptFromCurrentAuthority(staged.session, staged.platform, staged.receipt);
            this.#invalidatePlatformReceipt(staged.session, staged.platform);
            this.#database.prepare(`INSERT INTO platform_authority_receipts(
               session_id, claim_epoch, platform, receipt_json, updated_ms
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id, platform) DO UPDATE SET
               claim_epoch = excluded.claim_epoch,
               receipt_json = excluded.receipt_json,
               updated_ms = excluded.updated_ms`).run(staged.session.sessionId, staged.session.claimEpoch, staged.platform, JSON.stringify({ receipt: staged.receipt, probe: current.probe }), now);
          }
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
      }
      validatePlatformAuthorityReceipt(session2, platform, receipt) {
        const row = this.#database.prepare(`SELECT claim_epoch, receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND platform = ?`).get(session2.sessionId, platform);
        const persisted = typeof row?.receipt_json === "string" ? JSON.parse(row.receipt_json) : null;
        const persistedReceipt = persisted?.receipt && typeof persisted.receipt === "object" ? persisted.receipt : persisted;
        return row?.claim_epoch === session2.claimEpoch && JSON.stringify(persistedReceipt) === JSON.stringify(receipt);
      }
      getPlatformAuthorityProbe(session2, platform, receipt) {
        if (!this.validatePlatformAuthorityReceipt(session2, platform, receipt))
          return null;
        const row = this.#database.prepare(`SELECT receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`).get(session2.sessionId, session2.claimEpoch, platform);
        if (typeof row?.receipt_json !== "string")
          return null;
        const persisted = JSON.parse(row.receipt_json);
        const probe = persisted.probe;
        if (!probe || createHash2("sha256").update(probe.capability).digest("hex") !== receipt.runnerCapabilityHash) {
          return null;
        }
        return probe;
      }
      adoptStaleIntoBlocked(target, priorSessionId, targetInstance, options = {}) {
        const priorStatus = this.getSessionStatus(priorSessionId);
        if (!priorStatus) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "stale session is unavailable");
        }
        const owner = asSession(this.#database.prepare(`SELECT supervisor_pid, supervisor_birth FROM sessions WHERE session_id = ?`).get(priorSessionId));
        if (!owner || this.#ownerStatus({
          sessionId: priorSessionId,
          pid: owner.supervisor_pid,
          token: owner.supervisor_birth
        }) !== "mismatch") {
          throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "prior source owner is not proven stale");
        }
        const now = this.#now();
        this.#transaction(() => {
          const targetRow = this.#requireRecoverableSession(target);
          if (targetRow.state !== "blocked") {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "stale adoption is not available during handoff cleanup");
          }
          if (options.expectedTargetAuthorityVersion !== void 0 && targetRow.authority_version !== options.expectedTargetAuthorityVersion) {
            throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "session authority version changed after the adoption preflight proof");
          }
          if (targetRow.worker_instance !== targetInstance) {
            throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "stale adoption target is not the recovery worker");
          }
          const prior = asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                    claim_epoch, bindings_json
             FROM sessions WHERE session_id = ?`).get(priorSessionId));
          if (!prior || prior.claim_epoch !== priorStatus.claimEpoch || prior.source_key !== targetRow.source_key || prior.worktree_key !== targetRow.worktree_key || prior.app_root_key !== targetRow.app_root_key) {
            throw new SessionAuthorityError("SOURCE_WORKTREE_MISMATCH", "stale session does not belong to this exact source worktree");
          }
          const priorBindings = JSON.parse(prior.bindings_json);
          const targetBindings = JSON.parse(targetRow.bindings_json);
          const priorStaleDeviceCleanup = priorBindings.staleDeviceCleanup && typeof priorBindings.staleDeviceCleanup === "object" ? priorBindings.staleDeviceCleanup : null;
          const priorCleanup = priorBindings.handoffCleanup && typeof priorBindings.handoffCleanup === "object" ? priorBindings.handoffCleanup : null;
          const resumesCleanup = prior.state === "handoff_cleanup" && priorCleanup !== null;
          if (prior.state === "handoff_cleanup" && !resumesCleanup) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "stale handoff cleanup state has no durable cleanup plan");
          }
          if (resumesCleanup) {
            const mergedCleanup = this.#mergeStaleDeviceCleanup(priorCleanup, priorStaleDeviceCleanup);
            const resumesMetroCleanup = mergedCleanup.metro !== null && typeof mergedCleanup.metro === "object";
            this.#database.prepare(`UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
             WHERE session_id = ? AND claim_epoch = ?`).run(target.sessionId, target.claimEpoch, now + this.#leaseMs, prior.session_id, prior.claim_epoch);
            this.#database.prepare(`UPDATE sessions
             SET state = 'handoff_cleanup', bindings_json = ?,
                 authority_version = authority_version + 1, updated_ms = ?
             WHERE session_id = ? AND claim_epoch = ? AND state = 'blocked'`).run(JSON.stringify({
              ...targetBindings,
              adoptionRequired: null,
              recoveryHandles: targetBindings.recoveryHandles,
              metro: resumesMetroCleanup ? null : priorBindings.metro ?? null,
              metroCleanup: resumesMetroCleanup ? null : priorBindings.metroCleanup ?? null,
              device: priorBindings.device ?? null,
              install: priorBindings.install ?? null,
              packageIntegration: priorBindings.packageIntegration ?? null,
              bundle: null,
              runner: null,
              recorder: null,
              observe: null,
              proof: null,
              handoffCleanup: mergedCleanup,
              staleDeviceCleanup: priorStaleDeviceCleanup
            }), now, target.sessionId, target.claimEpoch);
            this.#fenceSession(prior.session_id, now);
            return;
          }
          const activeOperation = this.#database.prepare(`SELECT profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(prior.session_id, prior.claim_epoch);
          const priorMetro = priorBindings.metro && typeof priorBindings.metro === "object" ? priorBindings.metro : null;
          const metroCleanup = priorBindings.metroCleanup && typeof priorBindings.metroCleanup === "object" ? priorBindings.metroCleanup : priorMetro?.mode === "managed" ? priorMetro : null;
          const runnerCleanup = priorBindings.runner && typeof priorBindings.runner === "object" ? priorBindings.runner : priorStaleDeviceCleanup?.runner && typeof priorStaleDeviceCleanup.runner === "object" ? priorStaleDeviceCleanup.runner : null;
          const observeCleanup = priorBindings.observe && typeof priorBindings.observe === "object" ? priorBindings.observe : null;
          const recorderCleanup = priorBindings.recorder && typeof priorBindings.recorder === "object" ? priorBindings.recorder : priorStaleDeviceCleanup?.recorder && typeof priorStaleDeviceCleanup.recorder === "object" ? priorStaleDeviceCleanup.recorder : null;
          const runnerFromStale = runnerCleanup === priorStaleDeviceCleanup?.runner;
          const recorderFromStale = recorderCleanup === priorStaleDeviceCleanup?.recorder;
          if (activeOperation?.profile === "transition:ensure-metro" && !metroCleanup && !priorBindings.metro) {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "stale Metro transition has not published exact cleanup authority");
          }
          let runnerClaimKey = null;
          if (runnerCleanup) {
            runnerClaimKey = runnerFromStale ? String(runnerCleanup.claimKey) : `${String(runnerCleanup.platform)}:${String(runnerCleanup.deviceId)}:${String(runnerCleanup.port)}`;
            if (typeof runnerCleanup.completedAt !== "number") {
              const runnerClaim = this.#findClaim("runner", runnerClaimKey);
              if (runnerClaim?.session_id !== prior.session_id || runnerClaim.claim_epoch !== prior.claim_epoch) {
                throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "stale runner cleanup claim no longer matches the authenticated binding");
              }
            }
          }
          let recorderClaimKey = null;
          if (recorderCleanup) {
            recorderClaimKey = recorderFromStale ? String(recorderCleanup.claimKey) : `${String(recorderCleanup.platform)}:${String(recorderCleanup.deviceId)}`;
            if (typeof recorderCleanup.completedAt !== "number") {
              const recorderClaim = this.#findClaim("recorder", recorderClaimKey);
              if (recorderClaim?.session_id !== prior.session_id || recorderClaim.claim_epoch !== prior.claim_epoch) {
                throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "stale recorder cleanup claim no longer matches the authenticated binding");
              }
            }
          }
          if (observeCleanup) {
            const observePort = String(observeCleanup.port);
            const observeClaim = this.#findClaim("observe-port", observePort);
            if (priorBindings.observePort !== observeCleanup.port || observeClaim?.session_id !== prior.session_id || observeClaim.claim_epoch !== prior.claim_epoch) {
              throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "stale Observe cleanup claim no longer matches the authenticated binding");
            }
          }
          this.#database.prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device', 'runner', 'recorder')`).run(prior.session_id, prior.claim_epoch);
          this.#database.prepare(`UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(target.sessionId, target.claimEpoch, now + this.#leaseMs, prior.session_id, prior.claim_epoch);
          const cleanupRequired = Boolean(metroCleanup || runnerCleanup || observeCleanup || recorderCleanup || priorStaleDeviceCleanup);
          const sameMetro = Number(priorMetro?.port) === Number(targetBindings.metroPort);
          this.#database.prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'blocked'`).run(cleanupRequired ? "handoff_cleanup" : sameMetro && priorBindings.device ? "device_bound" : "source_bound", JSON.stringify({
            ...targetBindings,
            adoptionRequired: null,
            recoveryHandles: cleanupRequired ? targetBindings.recoveryHandles : null,
            metro: metroCleanup ? null : sameMetro ? priorBindings.metro : null,
            metroCleanup: null,
            device: priorBindings.device ?? null,
            install: priorBindings.install ?? null,
            packageIntegration: priorBindings.packageIntegration ?? null,
            bundle: null,
            runner: null,
            recorder: null,
            observe: null,
            proof: null,
            staleDeviceCleanup: priorStaleDeviceCleanup,
            handoffCleanup: cleanupRequired ? {
              metro: metroCleanup ? {
                ...metroCleanup,
                sourceSessionId: prior.session_id,
                stopRequestedAt: null,
                completedAt: null
              } : null,
              runner: runnerCleanup ? runnerFromStale ? runnerCleanup : {
                ...runnerCleanup,
                claimKey: runnerClaimKey,
                stopRequestedAt: null,
                completedAt: null
              } : null,
              recorder: recorderCleanup ? recorderFromStale ? recorderCleanup : {
                ...recorderCleanup,
                claimKey: recorderClaimKey,
                stopRequestedAt: null,
                completedAt: null
              } : null,
              observe: observeCleanup ? {
                ...observeCleanup,
                stopRequestedAt: null,
                completedAt: null
              } : null
            } : null
          }), now, target.sessionId, target.claimEpoch);
          this.#fenceSession(prior.session_id, now);
        });
      }
      #requireStaleAdoptionContext(target, handle, targetInstance) {
        const targetStatus = this.getSessionStatus(target.sessionId);
        const recovery = targetStatus?.bindings.recoveryHandles;
        const adoption = recovery?.adoptStale;
        if (targetStatus?.state !== "blocked" || targetStatus.claimEpoch !== target.claimEpoch || typeof adoption?.token !== "string" || typeof adoption.expiresMs !== "number" || typeof adoption.priorSessionId !== "string" || !this.#recoveryHandleMatches(adoption, handle, this.#now())) {
          throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "stale adoption capability is invalid or expired");
        }
        if (targetStatus.worker.instanceId !== targetInstance) {
          throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "stale adoption target is not the recovery worker");
        }
        const prior = this.getSessionStatus(adoption.priorSessionId);
        if (!prior || prior.claimEpoch !== adoption.priorClaimEpoch) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "stale adoption capability no longer matches the prior claim epoch");
        }
        if (prior.sourceKey !== targetStatus.sourceKey || prior.worktreeKey !== targetStatus.worktreeKey || prior.appRootKey !== targetStatus.appRootKey) {
          throw new SessionAuthorityError("SOURCE_WORKTREE_MISMATCH", "stale session does not belong to this exact source worktree");
        }
        return { priorSessionId: adoption.priorSessionId };
      }
      validateStaleAdoption(target, handle, targetInstance) {
        this.#requireStaleAdoptionContext(target, handle, targetInstance);
      }
      adoptStaleWithHandle(target, handle, targetInstance, options = {}) {
        const { priorSessionId } = this.#requireStaleAdoptionContext(target, handle, targetInstance);
        this.adoptStaleIntoBlocked(target, priorSessionId, targetInstance, options);
      }
      verifyStaleAdoptionResumption(target, handle, targetInstance) {
        const status = this.getSessionStatus(target.sessionId);
        const recovery = status?.bindings.recoveryHandles;
        const adoption = recovery?.adoptStale;
        if (status?.state !== "handoff_cleanup" || status.claimEpoch !== target.claimEpoch || status.worker.instanceId !== targetInstance || !adoption || !this.#recoveryHandleMatches(adoption, handle, this.#now())) {
          throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "stale adoption resumption requires the original adoption capability");
        }
      }
      beginOperation(session2, operation) {
        return this.#beginOperation(session2, operation, false);
      }
      beginHandoffCancellationOperation(session2, operation) {
        return this.#beginOperation(session2, operation, true);
      }
      #beginOperation(session2, operation, handoffCancellation) {
        const now = this.#now();
        return this.#transaction(() => {
          const owner = handoffCancellation ? this.#requireHandoffSession(session2) : this.#requireSession(session2);
          if (handoffCancellation && JSON.parse(owner.bindings_json).managedMetroHandoffReservation) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff cancellation is fenced while managed Metro shutdown is reserved");
          }
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(session2.sessionId, session2.claimEpoch);
          if (active) {
            throw new SessionAuthorityError("OPERATION_ALREADY_IN_PROGRESS", "session already has an active fenced operation");
          }
          this.#database.prepare(`INSERT INTO operations(
            operation_id, session_id, claim_epoch, authority_version,
            tool, profile, started_ms, lease_until_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(operation.operationId, session2.sessionId, session2.claimEpoch, owner.authority_version, operation.tool, operation.profile, now, now + this.#leaseMs);
          return {
            operationId: operation.operationId,
            sessionId: session2.sessionId,
            claimEpoch: session2.claimEpoch,
            authorityVersion: owner.authority_version
          };
        });
      }
      refreshOperation(operation) {
        this.verifyOperation(operation);
        return operation;
      }
      endOperation(operation) {
        this.#transaction(() => {
          const session2 = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version
             FROM sessions WHERE session_id = ?`).get(operation.sessionId));
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          if (!session2 || !isFenceableState(session2.state) || session2.claim_epoch !== operation.claimEpoch || session2.authority_version !== operation.authorityVersion || !active) {
            throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "operation fence no longer matches current authority");
          }
          this.#database.prepare("DELETE FROM operations WHERE operation_id = ?").run(operation.operationId);
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
      }
      cancelOperation(operation) {
        this.#transaction(() => {
          this.#database.prepare(`DELETE FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).run(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
      }
      cancelActiveOperationForSession(session2) {
        const operationIds = this.#transaction(() => {
          this.#requireSession(session2);
          const rows = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ?`).all(session2.sessionId, session2.claimEpoch);
          this.#database.prepare("DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?").run(session2.sessionId, session2.claimEpoch);
          return rows.map((row) => String(row.operation_id));
        });
        for (const operationId of operationIds) {
          this.#pendingPlatformReceipts.delete(operationId);
        }
      }
      verifyOperation(operation) {
        const session2 = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version
           FROM sessions WHERE session_id = ?`).get(operation.sessionId));
        const active = this.#database.prepare(`SELECT operation_id FROM operations
         WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
           AND authority_version = ?`).get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        if (!session2 || !isFenceableState(session2.state) || session2.claim_epoch !== operation.claimEpoch || session2.authority_version !== operation.authorityVersion || !active) {
          throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "operation fence no longer matches current authority");
        }
      }
      renewOperation(operation) {
        const now = this.#now();
        this.#transaction(() => {
          this.verifyOperation(operation);
          this.#database.prepare("UPDATE operations SET lease_until_ms = ? WHERE operation_id = ?").run(now + this.#leaseMs, operation.operationId);
        });
      }
      getClaim(type, key) {
        const claim = this.#findClaim(type, key);
        return claim ? {
          type: claim.resource_type,
          key: claim.resource_key,
          sessionId: claim.session_id,
          claimEpoch: claim.claim_epoch,
          leaseUntilMs: claim.lease_until_ms
        } : null;
      }
      // GH #630: every allocated port for a service across all worktrees, own
      // session included — foreign-origin scanners must exclude their own port.
      allocatedServicePorts(service) {
        const rows = this.#database.prepare("SELECT port, worktree_key FROM allocations WHERE service = ?").all(service);
        return rows.map((row) => row.port).filter((port) => Number.isSafeInteger(port));
      }
      allocatePort(input) {
        if (!Number.isSafeInteger(input.base) || input.base < 1 || !Number.isSafeInteger(input.span) || input.span < 1 || input.base + input.span > 65536) {
          throw new SessionAuthorityError("INVALID_PORT_RANGE", "port allocation range is invalid");
        }
        return this.#transaction(() => {
          const existing = this.#database.prepare("SELECT port FROM allocations WHERE service = ? AND worktree_key = ?").get(input.service, input.worktreeKey);
          if (existing) {
            const claim = this.#findClaim(`${input.service}-port`, String(existing.port));
            const listenerStatus = claim ? "absent" : this.#listenerStatus(existing.port);
            if (listenerStatus === "absent")
              return existing.port;
            if (listenerStatus === "unknown") {
              throw new SessionAuthorityError("PORT_LISTENER_PROBE_UNAVAILABLE", `listener ownership for ${input.service} port ${existing.port} is unavailable`);
            }
            this.#database.prepare("DELETE FROM allocations WHERE service = ? AND worktree_key = ?").run(input.service, input.worktreeKey);
          }
          const digest2 = createHash2("sha256").update(`${input.uid}\0${input.worktreeKey}\0${input.service}`).digest();
          const preferred = digest2.readUInt32BE(0) % input.span;
          for (let offset = 0; offset < input.span; offset += 1) {
            const port = input.base + (preferred + offset) % input.span;
            const occupied = this.#database.prepare("SELECT worktree_key FROM allocations WHERE service = ? AND port = ?").get(input.service, port);
            if (occupied)
              continue;
            const listenerStatus = this.#listenerStatus(port);
            if (listenerStatus === "listening")
              continue;
            if (listenerStatus === "unknown") {
              throw new SessionAuthorityError("PORT_LISTENER_PROBE_UNAVAILABLE", `listener ownership for ${input.service} port ${port} is unavailable`);
            }
            this.#database.prepare(`INSERT INTO allocations(service, worktree_key, port, generation)
             VALUES (?, ?, ?, 1)`).run(input.service, input.worktreeKey, port);
            return port;
          }
          const orphanRows = this.#database.prepare(`SELECT allocation.worktree_key, allocation.port
           FROM allocations allocation
           WHERE allocation.service = ?
             AND allocation.port >= ?
             AND allocation.port < ?
             AND NOT EXISTS (
               SELECT 1 FROM sessions session
               WHERE session.worktree_key = allocation.worktree_key
                 AND session.state NOT IN ('released', 'stale')
             )
           ORDER BY allocation.generation ASC, allocation.worktree_key ASC
           `).all(input.service, input.base, input.base + input.span);
          for (const row of orphanRows) {
            if (!Number.isSafeInteger(row.port) || typeof row.worktree_key !== "string") {
              throw new SessionAuthorityError("AUTHORITY_STORE_INVALID", "persisted port allocation is malformed");
            }
            const orphan = { port: row.port, worktree_key: row.worktree_key };
            const listenerStatus = this.#listenerStatus(orphan.port);
            if (listenerStatus === "listening")
              continue;
            if (listenerStatus === "unknown") {
              throw new SessionAuthorityError("PORT_LISTENER_PROBE_UNAVAILABLE", `listener ownership for ${input.service} port ${orphan.port} is unavailable`);
            }
            this.#database.prepare(`DELETE FROM allocations
             WHERE service = ? AND worktree_key = ? AND port = ?`).run(input.service, orphan.worktree_key, orphan.port);
            this.#database.prepare(`INSERT INTO allocations(service, worktree_key, port, generation)
             VALUES (?, ?, ?, 1)`).run(input.service, input.worktreeKey, orphan.port);
            return orphan.port;
          }
          throw new SessionAuthorityError("PORT_RANGE_EXHAUSTED", `no ${input.service} port is available in the configured range`);
        });
      }
      #initialize() {
        const schema = this.#database.prepare("SELECT value FROM authority_meta WHERE key = ?").get("schema_version")?.value;
        const version = Number(schema);
        if (!Number.isSafeInteger(version) || version < 1 || version > AUTHORITY_REGISTRY_SCHEMA_VERSION) {
          throw new SessionAuthorityError("AUTHORITY_STORE_UNAVAILABLE", version > 4 ? `authority registry schema ${version} is newer than supported schema ${AUTHORITY_REGISTRY_SCHEMA_VERSION}` : "authority registry schema version is invalid");
        }
        this.#database.exec("BEGIN IMMEDIATE");
        try {
          this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        worktree_key TEXT NOT NULL,
        app_root_key TEXT NOT NULL,
        state TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        authority_version INTEGER NOT NULL,
        supervisor_pid INTEGER NOT NULL,
        supervisor_birth TEXT NOT NULL,
        worker_instance TEXT,
        worker_pid INTEGER,
        worker_birth TEXT,
        heartbeat_ms INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL,
        source_json TEXT NOT NULL,
        bindings_json TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claims (
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL,
        PRIMARY KEY(resource_type, resource_key)
      );
      CREATE INDEX IF NOT EXISTS claims_session_idx
        ON claims(session_id, claim_epoch);
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        authority_version INTEGER NOT NULL,
        tool TEXT NOT NULL,
        profile TEXT NOT NULL,
        started_ms INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operations_session_idx
        ON operations(session_id, claim_epoch);
      CREATE TABLE IF NOT EXISTS allocations (
        service TEXT NOT NULL,
        worktree_key TEXT NOT NULL,
        port INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY(service, worktree_key),
        UNIQUE(service, port)
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        target_instance TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_ms INTEGER NOT NULL,
        consumed_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS platform_authority_receipts (
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        platform TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        updated_ms INTEGER NOT NULL,
        PRIMARY KEY(session_id, platform)
      );
      `);
          if (version < 3) {
            const columns = this.#database.prepare("PRAGMA table_info(handoffs)").all();
            if (!columns.some((column) => column.name === "source_state")) {
              this.#database.exec("ALTER TABLE handoffs ADD COLUMN source_state TEXT NOT NULL DEFAULT 'active';");
            }
          }
          this.#database.exec(`UPDATE authority_meta SET value = '${AUTHORITY_REGISTRY_SCHEMA_VERSION}' WHERE key = 'schema_version';`);
          this.#database.exec("COMMIT");
        } catch (error) {
          this.#database.exec("ROLLBACK");
          throw error;
        }
        this.#secureFiles();
      }
      #initializeWithRetry() {
        const deadline = Date.now() + 1e3;
        for (; ; ) {
          try {
            this.#initialize();
            return;
          } catch (error) {
            const code = error.code;
            const message = error instanceof Error ? error.message : "";
            if (code !== "SQLITE_BUSY" && !/database is (?:locked|busy)/i.test(message))
              throw error;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
              throw error;
            Atomics.wait(INITIALIZATION_WAIT2, 0, 0, Math.min(25, remaining));
          }
        }
      }
      #probeClaimOwners(session2, resources) {
        const owners = /* @__PURE__ */ new Map();
        for (const resource of resources) {
          const claim = this.#findConflictingClaim(resource);
          if (!claim || claim.session_id === session2.sessionId || owners.has(claim.session_id)) {
            continue;
          }
          const owner = asSession(this.#database.prepare(`SELECT session_id, claim_epoch, supervisor_pid, supervisor_birth
             FROM sessions WHERE session_id = ?`).get(claim.session_id));
          let status = "unknown";
          if (owner && owner.claim_epoch === claim.claim_epoch) {
            try {
              status = this.#ownerStatus({
                sessionId: owner.session_id,
                pid: owner.supervisor_pid,
                token: owner.supervisor_birth
              });
            } catch {
              status = "unknown";
            }
          }
          owners.set(claim.session_id, { claimEpoch: claim.claim_epoch, status });
        }
        return owners;
      }
      #assertClaimsAvailable(session2, resources, probes, now) {
        for (const resource of resources) {
          const claim = this.#findConflictingClaim(resource);
          if (!claim || claim.session_id === session2.sessionId && claim.claim_epoch === session2.claimEpoch) {
            continue;
          }
          if (!probes)
            throw claimConflict(claim);
          const probe = probes.get(claim.session_id);
          if (!probe || probe.claimEpoch !== claim.claim_epoch) {
            throw claimConflict(claim);
          }
          if (probe.status === "match")
            throw claimConflict(claim);
          if (probe.status === "unknown") {
            if (claim.lease_until_ms < now) {
              throw new SessionAuthorityError("STALE_LEASE_NOT_RECLAIMABLE", OWNER_IDENTITY_REFUSAL_REASONS.leaseOwnerUnprovable, { sessionId: claim.session_id, claimEpoch: claim.claim_epoch });
            }
            throw claimConflict(claim);
          }
          throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "a proven-stale owner requires explicit adopt_stale before claims transfer", { sessionId: claim.session_id, claimEpoch: claim.claim_epoch });
        }
      }
      #requireSession(session2) {
        const row = asSession(this.#database.prepare(`SELECT session_id, state, claim_epoch, authority_version,
                  source_key, worktree_key, app_root_key,
                  supervisor_pid, supervisor_birth, worker_instance, worker_pid,
                  worker_birth, lease_until_ms, source_json, bindings_json
           FROM sessions WHERE session_id = ?`).get(session2.sessionId));
        if (!row || !isOperationalState(row.state) || row.claim_epoch !== session2.claimEpoch) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "session owner no longer matches the active claim epoch");
        }
        return row;
      }
      #requireIntegrationRestored(bindings) {
        if (bindings.packageIntegration) {
          throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "package integration must be restored before session release");
        }
      }
      #requireFenceableSession(session2) {
        const row = asSession(this.#database.prepare(`SELECT session_id, state, claim_epoch, authority_version,
                  source_key, worktree_key, app_root_key,
                  supervisor_pid, supervisor_birth, worker_instance, worker_pid,
                  worker_birth, lease_until_ms, source_json, bindings_json
           FROM sessions WHERE session_id = ?`).get(session2.sessionId));
        if (!row || !isFenceableState(row.state) || row.claim_epoch !== session2.claimEpoch) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "session owner no longer matches the fenceable claim epoch");
        }
        return row;
      }
      #requireHandoffSession(session2) {
        const row = this.#requireFenceableSession(session2);
        if (row.state !== "handoff") {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "session owner no longer matches the handoff claim epoch");
        }
        return row;
      }
      #requireRecoverableSession(session2) {
        const row = asSession(this.#database.prepare(`SELECT session_id, state, claim_epoch, authority_version,
                  source_key, worktree_key, app_root_key,
                  supervisor_pid, supervisor_birth, worker_instance, worker_pid,
                  worker_birth, lease_until_ms, source_json, bindings_json
           FROM sessions WHERE session_id = ?`).get(session2.sessionId));
        if (!row || row.state !== "blocked" && row.state !== "handoff_cleanup" || row.claim_epoch !== session2.claimEpoch) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "session is not an unchanged recovery contender");
        }
        return row;
      }
      #requireHandoffCleanupOwner(session2, targetInstance) {
        const row = this.#requireRecoverableSession(session2);
        if (row.state !== "handoff_cleanup" || row.worker_instance !== targetInstance) {
          throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff cleanup is not owned by this recovery worker");
        }
        return row;
      }
      #requireHandoffIntoContext(target, input, options) {
        const { allowExactReservationAfterExpiry, commitRecipientRotation } = options;
        const targetRow = this.#requireRecoverableSession(target);
        if (targetRow.state !== "blocked") {
          throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff acceptance is not available during cleanup");
        }
        if (targetRow.worker_instance !== input.targetInstance) {
          throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "handoff target is not the current fenced worker instance");
        }
        const handoff = this.#database.prepare(`SELECT handoff_id, session_id, claim_epoch, target_instance,
                token_hash, expires_ms, consumed_ms
         FROM handoffs WHERE handoff_id = ?`).get(input.handoffId);
        if (!handoff) {
          throw new SessionAuthorityError("HANDOFF_NOT_FOUND", "handoff does not exist");
        }
        const expected = Buffer.from(handoff.token_hash, "hex");
        const actual = createHash2("sha256").update(input.token).digest();
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          throw new SessionAuthorityError("HANDOFF_TOKEN_INVALID", "handoff capability is invalid");
        }
        if (handoff.consumed_ms !== null) {
          throw new SessionAuthorityError("HANDOFF_ALREADY_CONSUMED", "handoff was already accepted");
        }
        const prior = asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                  claim_epoch, authority_version, bindings_json
           FROM sessions WHERE session_id = ?`).get(handoff.session_id));
        if (!prior || prior.state !== "handoff" || prior.claim_epoch !== handoff.claim_epoch) {
          throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff no longer matches the live owner epoch");
        }
        if (prior.source_key !== targetRow.source_key || prior.worktree_key !== targetRow.worktree_key || prior.app_root_key !== targetRow.app_root_key) {
          throw new SessionAuthorityError("SOURCE_WORKTREE_MISMATCH", "handoff source does not match the target session");
        }
        let bindings = JSON.parse(prior.bindings_json);
        let reservation = managedMetroHandoffReservation(bindings);
        let exactReservation = reservation?.handoffId === handoff.handoff_id && reservation.sourceClaimEpoch === handoff.claim_epoch && reservation.targetSessionId === target.sessionId && reservation.targetClaimEpoch === target.claimEpoch && reservation.targetInstance === input.targetInstance && reservation.metro?.sourceSessionId === prior.session_id;
        if (handoff.target_instance !== input.targetInstance || reservation && !exactReservation) {
          const targetBindings = JSON.parse(targetRow.bindings_json);
          const adoptionRequired = targetBindings.adoptionRequired;
          const priorTarget = reservation ? asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                        claim_epoch, supervisor_pid, supervisor_birth
                 FROM sessions WHERE session_id = ?`).get(reservation.targetSessionId)) : null;
          const priorTargetTerminal = priorTarget !== null && (priorTarget.state === "released" || priorTarget.state === "stale") && priorTarget.claim_epoch === reservation.targetClaimEpoch + 1;
          let priorTargetDead = false;
          if (priorTarget?.state === "blocked" && priorTarget.claim_epoch === reservation?.targetClaimEpoch) {
            try {
              priorTargetDead = this.#ownerStatus({
                sessionId: priorTarget.session_id,
                pid: priorTarget.supervisor_pid,
                token: priorTarget.supervisor_birth
              }) === "mismatch";
            } catch {
              priorTargetDead = false;
            }
          }
          if (!reservation || reservation.handoffId !== handoff.handoff_id || reservation.sourceClaimEpoch !== handoff.claim_epoch || reservation.metro.sourceSessionId !== prior.session_id || reservation.targetInstance !== handoff.target_instance || adoptionRequired?.sessionId !== prior.session_id || adoptionRequired.claimEpoch !== prior.claim_epoch || !priorTarget || priorTarget.source_key !== targetRow.source_key || priorTarget.worktree_key !== targetRow.worktree_key || priorTarget.app_root_key !== targetRow.app_root_key || !priorTargetTerminal && !priorTargetDead) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro cleanup reservation belongs to a different handoff recipient");
          }
          if (handoff.expires_ms < this.#now() && !allowExactReservationAfterExpiry) {
            throw new SessionAuthorityError("HANDOFF_EXPIRED", "handoff capability expired");
          }
          const rotatedReservation = {
            ...reservation,
            targetSessionId: target.sessionId,
            targetClaimEpoch: target.claimEpoch,
            targetInstance: input.targetInstance
          };
          if (commitRecipientRotation) {
            const handoffChanged = this.#database.prepare(`UPDATE handoffs SET target_instance = ?
             WHERE handoff_id = ? AND target_instance = ? AND consumed_ms IS NULL`).run(input.targetInstance, handoff.handoff_id, reservation.targetInstance);
            if (handoffChanged.changes !== 1) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro handoff target changed during recipient rotation");
            }
            bindings = {
              ...bindings,
              managedMetroHandoffReservation: rotatedReservation
            };
            const donorChanged = this.#database.prepare(`UPDATE sessions
             SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
             WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`).run(JSON.stringify(bindings), this.#now(), prior.session_id, prior.claim_epoch);
            if (donorChanged.changes !== 1) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro donor authority changed during recipient rotation");
            }
            if (priorTarget.state === "blocked") {
              this.#fenceSession(priorTarget.session_id, this.#now());
            }
          }
          handoff.target_instance = input.targetInstance;
          reservation = rotatedReservation;
          exactReservation = true;
        }
        if (handoff.expires_ms < this.#now() && !(allowExactReservationAfterExpiry && exactReservation)) {
          throw new SessionAuthorityError("HANDOFF_EXPIRED", "handoff capability expired");
        }
        return {
          targetRow,
          handoff,
          prior,
          bindings,
          reservation: exactReservation ? reservation : null
        };
      }
      #advanceActiveOperationFence(session2, priorAuthorityVersion, nextAuthorityVersion, requireActiveFence = false) {
        const active = this.#database.prepare(`SELECT operation_id, authority_version FROM operations
         WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(session2.sessionId, session2.claimEpoch);
        const context = this.#operationContext.getStore();
        if (!active) {
          if (requireActiveFence && context?.sessionId === session2.sessionId && context.claimEpoch === session2.claimEpoch) {
            throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "active operation fence disappeared before authority commit");
          }
          return;
        }
        if (!context || context.operationId !== active.operation_id || context.sessionId !== session2.sessionId || context.claimEpoch !== session2.claimEpoch || context.authorityVersion !== priorAuthorityVersion || active.authority_version !== priorAuthorityVersion) {
          throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "authority mutation is not owned by the active operation fence");
        }
        const changed = this.#database.prepare(`UPDATE operations SET authority_version = ?, lease_until_ms = ?
         WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
           AND authority_version = ?`).run(nextAuthorityVersion, this.#now() + this.#leaseMs, context.operationId, session2.sessionId, session2.claimEpoch, priorAuthorityVersion);
        if (changed.changes === 0) {
          throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "operation fence did not advance atomically");
        }
        context.authorityVersion = nextAuthorityVersion;
      }
      #findClaim(type, key) {
        return asClaim(this.#database.prepare(`SELECT resource_type, resource_key, session_id, claim_epoch, lease_until_ms
           FROM claims WHERE resource_type = ? AND resource_key = ?`).get(type, key));
      }
      #findConflictingClaim(resource) {
        return this.#findClaim(resource.type, resource.key) ?? (resource.type === "runner" ? this.#findClaim("runner-receipt", resource.key) : resource.type === "device" ? this.#findClaim("device-receipt", resource.key) : null);
      }
      #platformReceiptFromCurrentAuthority(session2, platform, receipt) {
        const row = this.#requireSession(session2);
        const bindings = JSON.parse(row.bindings_json);
        const device = bindings.device;
        const install = bindings.install;
        const runner = bindings.runner;
        const runnerClaim = this.#database.prepare(`SELECT resource_key FROM claims
         WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'runner'`).get(session2.sessionId, session2.claimEpoch);
        const deviceClaim = this.#database.prepare(`SELECT resource_key FROM claims
         WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'device'`).get(session2.sessionId, session2.claimEpoch);
        const runnerCapabilityHash = typeof runner?.capability === "string" ? createHash2("sha256").update(runner.capability).digest("hex") : null;
        if (device?.platform !== platform || receipt.sessionId !== session2.sessionId || receipt.claimEpoch !== session2.claimEpoch || receipt.sourceKey !== row.source_key || receipt.worktreeKey !== row.worktree_key || receipt.appRootKey !== row.app_root_key || receipt.deviceId !== device.deviceId || receipt.appId !== device.appId || receipt.installGeneration !== install?.installGeneration || receipt.artifactDigest !== install?.artifactDigest || receipt.runnerInstanceId !== runner?.instanceId || receipt.runnerPid !== runner?.pid || receipt.runnerProcessBirth !== runner?.processBirth || receipt.runnerPort !== runner?.port || receipt.runnerClaim !== runnerClaim?.resource_key || receipt.deviceClaim !== deviceClaim?.resource_key || receipt.runnerCapabilityHash !== runnerCapabilityHash || typeof runner?.port !== "number" || typeof runner.capability !== "string" || typeof runner.instanceId !== "string" || typeof runner.pid !== "number" || typeof runner.processBirth !== "string" || typeof device?.deviceId !== "string" || typeof device.appId !== "string" || typeof install?.installGeneration !== "string") {
          throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "snapshot receipt does not match exact persistent platform authority");
        }
        return {
          session: session2,
          platform,
          receipt,
          probe: {
            platform,
            port: runner.port,
            capability: runner.capability,
            instanceId: runner.instanceId,
            sessionId: session2.sessionId,
            claimEpoch: session2.claimEpoch,
            deviceId: device.deviceId,
            appId: device.appId,
            pid: runner.pid,
            processBirth: runner.processBirth,
            installGeneration: install.installGeneration
          }
        };
      }
      #invalidatePlatformReceipt(session2, platform) {
        const row = this.#database.prepare(`SELECT receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`).get(session2.sessionId, session2.claimEpoch, platform);
        if (typeof row?.receipt_json === "string") {
          const persisted = JSON.parse(row.receipt_json);
          const receipt = persisted.receipt && typeof persisted.receipt === "object" ? persisted.receipt : persisted;
          if (typeof receipt.runnerClaim === "string") {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = 'runner-receipt' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(receipt.runnerClaim, session2.sessionId, session2.claimEpoch);
          }
          if (typeof receipt.deviceClaim === "string") {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = 'device-receipt' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(receipt.deviceClaim, session2.sessionId, session2.claimEpoch);
          }
        }
        this.#database.prepare(`DELETE FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`).run(session2.sessionId, session2.claimEpoch, platform);
      }
      #capabilityMatches(expected, actual) {
        const expectedDigest = createHash2("sha256").update(expected).digest();
        const actualDigest = createHash2("sha256").update(actual).digest();
        return timingSafeEqual(expectedDigest, actualDigest);
      }
      #recoveryHandleMatches(handle, actual, now) {
        if (typeof handle.token === "string" && typeof handle.expiresMs === "number" && handle.expiresMs >= now && this.#capabilityMatches(handle.token, actual)) {
          return true;
        }
        const previous = handle.previous;
        return Boolean(previous && typeof previous.token === "string" && typeof previous.expiresMs === "number" && previous.expiresMs >= now && this.#capabilityMatches(previous.token, actual));
      }
      #mergeStaleDeviceCleanup(cleanup, staleDeviceCleanup) {
        if (!staleDeviceCleanup)
          return cleanup;
        const merged = { ...cleanup };
        for (const resource of ["runner", "recorder"]) {
          const current = cleanup[resource];
          const stale = staleDeviceCleanup[resource];
          if (!stale || typeof stale !== "object")
            continue;
          if (current && typeof current === "object") {
            const currentKey = current.claimKey;
            const staleKey = stale.claimKey;
            if (currentKey !== staleKey) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", `stale ${resource} cleanup conflicts with the existing handoff plan`);
            }
          } else {
            merged[resource] = stale;
          }
        }
        return merged;
      }
      #fenceSession(sessionId, now) {
        this.#database.prepare("DELETE FROM claims WHERE session_id = ?").run(sessionId);
        this.#database.prepare("DELETE FROM operations WHERE session_id = ?").run(sessionId);
        this.#database.prepare(`UPDATE sessions
         SET state = 'stale', claim_epoch = claim_epoch + 1,
             authority_version = authority_version + 1, updated_ms = ?
         WHERE session_id = ?`).run(now, sessionId);
      }
      #transaction(operation, assertBeforeCommit, onCommitted) {
        this.#database.exec("BEGIN IMMEDIATE");
        const context = this.#operationContext.getStore();
        const priorContextAuthorityVersion = context?.authorityVersion;
        let committed = false;
        try {
          const result = operation();
          assertBeforeCommit?.();
          this.#database.exec("COMMIT");
          committed = true;
          try {
            onCommitted?.(result);
          } finally {
            this.#secureFiles();
          }
          return result;
        } catch (error) {
          if (!committed) {
            try {
              this.#database.exec("ROLLBACK");
            } finally {
              if (context && priorContextAuthorityVersion !== void 0) {
                context.authorityVersion = priorContextAuthorityVersion;
              }
              this.#secureFiles();
            }
          }
          throw error;
        }
      }
      async #retry(operation, timeoutMs, retryDelayMs) {
        const deadline = Date.now() + timeoutMs;
        for (; ; ) {
          try {
            return operation();
          } catch (error) {
            const code = error.code;
            const message = error instanceof Error ? error.message : "";
            if (code !== "SQLITE_BUSY" && !/database is (?:locked|busy)/i.test(message))
              throw error;
            if (Date.now() >= deadline) {
              throw new SessionAuthorityError("AUTHORITY_STORE_BUSY", "authority registry remained contended past the retry deadline");
            }
            await new Promise((resolve4) => setTimeout(resolve4, retryDelayMs));
          }
        }
      }
    };
  }
});

// packages/rn-dev-agent-core/dist/util/secure-state-file.js
import { readFileSync as readFileSync3, writeFileSync, unlinkSync as unlinkSync2, mkdirSync as mkdirSync2, renameSync, lstatSync as lstatSync4 } from "node:fs";
import { join as join3, dirname as dirname4 } from "node:path";
import { homedir } from "node:os";
function getStateDir() {
  if (process.env.XDG_STATE_HOME) {
    return join3(process.env.XDG_STATE_HOME, "rn-dev-agent");
  }
  if (process.platform === "darwin") {
    return join3(homedir(), "Library", "Application Support", "rn-dev-agent");
  }
  return join3(homedir(), ".rn-dev-agent");
}
function readJsonStateFile(path) {
  try {
    const stat = lstatSync4(path);
    if (stat.isSymbolicLink())
      return null;
    return JSON.parse(readFileSync3(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJsonStateFileAtomic(path, value) {
  mkdirSync2(dirname4(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(value), { encoding: "utf8", mode: 384 });
  renameSync(tmpPath, path);
}
var init_secure_state_file = __esm({
  "packages/rn-dev-agent-core/dist/util/secure-state-file.js"() {
    "use strict";
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

// packages/rn-dev-agent-core/dist/runners/runtime-paths.js
import { existsSync as existsSync6, statSync as statSync3 } from "node:fs";
import { join as join7 } from "node:path";
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
    return statSync3(path).isDirectory();
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
    runnerRoot ? join7(runnerRoot, runnerName) : void 0,
    repoRoot ? join7(repoRoot, "packages", runnerName) : void 0,
    repoRoot ? join7(repoRoot, "scripts", runnerName) : void 0,
    codexPluginRoot ? join7(codexPluginRoot, "scripts", runnerName) : void 0,
    claudePluginRoot ? join7(claudePluginRoot, "..", runnerName) : void 0,
    claudePluginRoot ? join7(claudePluginRoot, "..", "..", "packages", runnerName) : void 0,
    claudePluginRoot ? join7(claudePluginRoot, "..", "..", "scripts", runnerName) : void 0,
    claudePluginRoot ? join7(claudePluginRoot, "scripts", runnerName) : void 0,
    // Bundled Codex runtime: <plugin>/rn-dev-agent-core/dist.
    join7(baseDir, "..", "..", "scripts", runnerName),
    // Source checkout: packages/rn-dev-agent-core/dist/runners.
    // Also covers the legacy scripts/cdp-bridge/dist/runners layout.
    join7(baseDir, "..", "..", "..", runnerName),
    // Legacy source checkout: packages/rn-dev-agent-core/dist/runners before runner package split.
    join7(baseDir, "..", "..", "..", "..", "scripts", runnerName)
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
import { join as join8 } from "node:path";
function resolveReadyTimeoutMs() {
  const raw = Number(process.env.RN_FAST_RUNNER_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3e4;
}
var READY_TIMEOUT_MS, FAST_RUNNER_PROJECT, REBUILD_LOCK_DIR, REBUILD_LOCK_STALE_MS, REBUILD_BUDGET_FILE, fetchImpl;
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
    REBUILD_LOCK_DIR = join8(FAST_RUNNER_PROJECT, "build", ".rebuild-lock");
    REBUILD_LOCK_STALE_MS = 15 * 6e4;
    REBUILD_BUDGET_FILE = join8(FAST_RUNNER_PROJECT, "build", "commands-rebuild.json");
    fetchImpl = globalThis.fetch;
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
import { execFile, spawn as spawn3 } from "node:child_process";
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

// packages/rn-dev-agent-core/dist/logger.js
import { createWriteStream, mkdirSync as mkdirSync5, existsSync as existsSync7 } from "node:fs";
import { join as join9 } from "node:path";
import { tmpdir as tmpdir2, homedir as homedir2 } from "node:os";
function resolveLogPath() {
  if (process.argv.includes("--diagnostic-contract-probe"))
    return null;
  if (configuredLevel !== "debug" && configuredLevel !== "info")
    return null;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) {
    try {
      if (!existsSync7(pluginData))
        mkdirSync5(pluginData, { recursive: true });
      return join9(pluginData, "cdp-bridge.log");
    } catch {
    }
  }
  const fallbackDir = join9(homedir2(), ".claude", "logs");
  try {
    if (!existsSync7(fallbackDir))
      mkdirSync5(fallbackDir, { recursive: true });
    return join9(fallbackDir, "rn-dev-agent-cdp-bridge.log");
  } catch {
  }
  return join9(tmpdir2(), "rn-dev-agent-cdp-bridge.log");
}
var configuredLevel, logFilePath;
var init_logger = __esm({
  "packages/rn-dev-agent-core/dist/logger.js"() {
    "use strict";
    configuredLevel = process.env.LOG_LEVEL ?? process.env.RN_DEV_AGENT_LOG_LEVEL ?? "warn";
    logFilePath = resolveLogPath();
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
var init_project_config = __esm({
  "packages/rn-dev-agent-core/dist/project-config.js"() {
    "use strict";
    init_storage();
    init_logger();
    init_sources();
  }
});

// packages/rn-dev-agent-core/dist/agent-device-wrapper.js
import { join as join10 } from "node:path";
import { createHash as createHash5 } from "node:crypto";
function getSessionFilePath() {
  const projectId = createHash5("sha256").update(process.cwd()).digest("hex").slice(0, 12);
  return join10(getStateDir(), `session-${projectId}.json`);
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

// packages/rn-dev-agent-core/dist/domain/maestro-validator.js
var import_yaml2;
var init_maestro_validator = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-validator.js"() {
    "use strict";
    import_yaml2 = __toESM(require_dist(), 1);
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-runner-pin.json
var maestro_runner_pin_default;
var init_maestro_runner_pin = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-runner-pin.json"() {
    maestro_runner_pin_default = {
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
  }
});

// packages/rn-dev-agent-core/dist/domain/engine-pin.js
var MAESTRO_RUNNER_PIN, TRUSTED_DRIFT_SHA256, ACTION_ENGINE_PIN, HOST_PLUGIN_ROOT, PINNED_RUNNER_INSTALL_HINT, PINNED_RUNNER_DIAGNOSE_HINT;
var init_engine_pin = __esm({
  "packages/rn-dev-agent-core/dist/domain/engine-pin.js"() {
    "use strict";
    init_process_birth();
    init_maestro_runner_pin();
    MAESTRO_RUNNER_PIN = Object.freeze({
      version: maestro_runner_pin_default.version,
      sha256: Object.freeze({ ...maestro_runner_pin_default.sha256 }),
      archiveSha256: Object.freeze({ ...maestro_runner_pin_default.archiveSha256 }),
      knownQuirks: Object.freeze(maestro_runner_pin_default.knownQuirks.map((quirk) => Object.freeze({ ...quirk })))
    });
    TRUSTED_DRIFT_SHA256 = Object.freeze({
      "1.0.9": Object.freeze({
        "darwin-arm64": "7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923",
        "darwin-x64": "36f8a973c3231b6b8125db4a3e131b8c3193aec6774145584b18070be979fd5f",
        "linux-arm64": "a8e8197c63502fba874ce69b908174d46a47c6539025184e3003e70576d9451e",
        "linux-x64": "bf7e9ef297c35712e9fad0ad56a65b7fd94e1f30168733cf09459b4ea80c4c3e"
      })
    });
    ACTION_ENGINE_PIN = `maestro-runner@${MAESTRO_RUNNER_PIN.version}`;
    HOST_PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}";
    PINNED_RUNNER_INSTALL_HINT = `bash ${HOST_PLUGIN_ROOT}/scripts/ensure-maestro-runner.sh`;
    PINNED_RUNNER_DIAGNOSE_HINT = `node ${HOST_PLUGIN_ROOT}/rn-dev-agent-core/dist/maestro-runner-pin.js diagnose`;
  }
});

// packages/rn-dev-agent-core/dist/tools/maestro-dispatch.js
var init_maestro_dispatch = __esm({
  "packages/rn-dev-agent-core/dist/tools/maestro-dispatch.js"() {
    "use strict";
    init_engine_pin();
  }
});

// packages/rn-dev-agent-core/dist/domain/ansi.js
var ANSI_RE;
var init_ansi = __esm({
  "packages/rn-dev-agent-core/dist/domain/ansi.js"() {
    "use strict";
    ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-error-parser.js
var init_maestro_error_parser = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-error-parser.js"() {
    "use strict";
    init_ansi();
  }
});

// packages/rn-dev-agent-core/dist/domain/reusable-action.js
var init_reusable_action = __esm({
  "packages/rn-dev-agent-core/dist/domain/reusable-action.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/session/runtime-paths.js
var init_runtime_paths2 = __esm({
  "packages/rn-dev-agent-core/dist/session/runtime-paths.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/domain/sidecar-io.js
var init_sidecar_io = __esm({
  "packages/rn-dev-agent-core/dist/domain/sidecar-io.js"() {
    "use strict";
    init_reusable_action();
    init_runtime_paths2();
  }
});

// packages/rn-dev-agent-core/dist/domain/atomic-writer.js
var ORPHAN_MAX_AGE_MS, lockWaitBuffer;
var init_atomic_writer = __esm({
  "packages/rn-dev-agent-core/dist/domain/atomic-writer.js"() {
    "use strict";
    init_process_birth();
    ORPHAN_MAX_AGE_MS = 5 * 60 * 1e3;
    lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
  }
});

// packages/rn-dev-agent-core/dist/domain/path-safety.js
var init_path_safety = __esm({
  "packages/rn-dev-agent-core/dist/domain/path-safety.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/domain/unfollowed-file.js
var init_unfollowed_file = __esm({
  "packages/rn-dev-agent-core/dist/domain/unfollowed-file.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/domain/action-db.js
import { createRequire as createRequire2 } from "node:module";
var _require;
var init_action_db = __esm({
  "packages/rn-dev-agent-core/dist/domain/action-db.js"() {
    "use strict";
    init_runtime_paths2();
    _require = createRequire2(import.meta.url);
  }
});

// packages/rn-dev-agent-core/dist/domain/action-state-store.js
var init_action_state_store = __esm({
  "packages/rn-dev-agent-core/dist/domain/action-state-store.js"() {
    "use strict";
    init_logger();
    init_action_db();
    init_sidecar_io();
  }
});

// packages/rn-dev-agent-core/dist/session/worktree-repair-remedy.js
var WORKTREE_REPAIR_ENTRY, HEADLESS_WORKTREE_REPAIR_COMMAND;
var init_worktree_repair_remedy = __esm({
  "packages/rn-dev-agent-core/dist/session/worktree-repair-remedy.js"() {
    "use strict";
    WORKTREE_REPAIR_ENTRY = '"${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}/rn-dev-agent-core/dist/worktree-inheritance.js"';
    HEADLESS_WORKTREE_REPAIR_COMMAND = `node ${WORKTREE_REPAIR_ENTRY} repair --app-root "$PWD"`;
  }
});

// packages/rn-dev-agent-core/dist/session/worktree-inheritance.js
var init_worktree_inheritance = __esm({
  "packages/rn-dev-agent-core/dist/session/worktree-inheritance.js"() {
    "use strict";
    init_worktree_repair_remedy();
  }
});

// packages/rn-dev-agent-core/dist/domain/action-store.js
var init_action_store = __esm({
  "packages/rn-dev-agent-core/dist/domain/action-store.js"() {
    "use strict";
    init_reusable_action();
    init_sidecar_io();
    init_atomic_writer();
    init_path_safety();
    init_unfollowed_file();
    init_action_state_store();
    init_worktree_inheritance();
  }
});

// packages/rn-dev-agent-core/dist/domain/action-engine-compat.js
var ENGINE_PIN_LINE;
var init_action_engine_compat = __esm({
  "packages/rn-dev-agent-core/dist/domain/action-engine-compat.js"() {
    "use strict";
    init_engine_pin();
    init_maestro_validator();
    init_reusable_action();
    init_action_store();
    ENGINE_PIN_LINE = new RegExp(`^#\\s*enginePin\\s*:\\s*.+$`);
  }
});

// packages/rn-dev-agent-core/dist/tools/resolve-ios-app-file.js
var init_resolve_ios_app_file = __esm({
  "packages/rn-dev-agent-core/dist/tools/resolve-ios-app-file.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-step-parser.js
var init_maestro_step_parser = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-step-parser.js"() {
    "use strict";
    init_maestro_error_parser();
    init_ansi();
    init_ansi();
  }
});

// packages/rn-dev-agent-core/dist/domain/tap-latency.js
var init_tap_latency = __esm({
  "packages/rn-dev-agent-core/dist/domain/tap-latency.js"() {
    "use strict";
    init_maestro_step_parser();
  }
});

// packages/rn-dev-agent-core/dist/cdp/recovery.js
var init_recovery = __esm({
  "packages/rn-dev-agent-core/dist/cdp/recovery.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-device-authority.js
var init_maestro_device_authority = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-device-authority.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-runner-report.js
var init_maestro_runner_report = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-runner-report.js"() {
    "use strict";
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
    optionalHybridMutation = ["cdp_run_action"];
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
var init_authority_gate = __esm({
  "packages/rn-dev-agent-core/dist/session/authority-gate.js"() {
    "use strict";
    init_utils();
    init_registry();
    init_metro_origin();
    init_install_reissue();
    init_tool_profiles();
  }
});

// packages/rn-dev-agent-core/dist/tools/maestro-run.js
import { execFile as execFileCb2 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var defaultExecFile;
var init_maestro_run = __esm({
  "packages/rn-dev-agent-core/dist/tools/maestro-run.js"() {
    "use strict";
    init_utils();
    init_engine_pin();
    init_action_engine_compat();
    init_reusable_action();
    init_agent_device_wrapper();
    init_project_config();
    init_maestro_dispatch();
    init_resolve_ios_app_file();
    init_maestro_validator();
    init_maestro_error_parser();
    init_tap_latency();
    init_maestro_step_parser();
    init_rn_fast_runner_client();
    init_release_android_slot();
    init_recovery();
    init_maestro_device_authority();
    init_maestro_runner_report();
    init_authority_gate();
    init_registry();
    defaultExecFile = promisify3(execFileCb2);
  }
});

// packages/rn-dev-agent-core/dist/session/managed-automation.js
var OUTPUT_LIMIT;
var init_managed_automation = __esm({
  "packages/rn-dev-agent-core/dist/session/managed-automation.js"() {
    "use strict";
    OUTPUT_LIMIT = 10 * 1024 * 1024;
  }
});

// packages/rn-dev-agent-core/dist/runners/external-runner-detect.js
import { execFile as execFile3 } from "node:child_process";
import { promisify as promisify4 } from "node:util";
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
async function detectIosExternalRunner(execFileImpl = execFile3, udid) {
  try {
    const opts = { timeout: 2e3, encoding: "utf8" };
    const run = execFileImpl === execFile3 ? promisify4(execFileImpl) : execFileImpl;
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

// packages/rn-dev-agent-core/dist/maestro-invoke.js
var init_maestro_invoke = __esm({
  "packages/rn-dev-agent-core/dist/maestro-invoke.js"() {
    "use strict";
    init_project_config();
    init_maestro_validator();
    init_maestro_dispatch();
    init_maestro_error_parser();
    init_engine_pin();
    init_action_engine_compat();
    init_resolve_ios_app_file();
    init_maestro_run();
    init_agent_device_wrapper();
    init_maestro_device_authority();
    init_maestro_runner_report();
    init_managed_automation();
    init_device_arbiter();
    init_authority_gate();
    init_utils();
  }
});

// packages/rn-dev-agent-core/dist/tools/runner-leak-recovery.js
var init_runner_leak_recovery = __esm({
  "packages/rn-dev-agent-core/dist/tools/runner-leak-recovery.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/tools/app-lifecycle.js
import { execFile as execFileCb3 } from "node:child_process";
import { promisify as promisify5 } from "node:util";
var execFile4;
var init_app_lifecycle = __esm({
  "packages/rn-dev-agent-core/dist/tools/app-lifecycle.js"() {
    "use strict";
    execFile4 = promisify5(execFileCb3);
  }
});

// packages/rn-dev-agent-core/dist/runners/ensure-single-runner.js
import { homedir as homedir3 } from "node:os";
import { join as join11 } from "node:path";
var DAEMON_JSON, DAEMON_LOCK;
var init_ensure_single_runner = __esm({
  "packages/rn-dev-agent-core/dist/runners/ensure-single-runner.js"() {
    "use strict";
    init_discovery();
    DAEMON_JSON = join11(homedir3(), ".agent-device", "daemon.json");
    DAEMON_LOCK = join11(homedir3(), ".agent-device", "daemon.lock");
  }
});

// packages/rn-dev-agent-core/dist/runners/suppress-ios-autocorrect.js
import { execFile as execFileCb4 } from "node:child_process";
import { promisify as promisify6 } from "node:util";
var execFile5;
var init_suppress_ios_autocorrect = __esm({
  "packages/rn-dev-agent-core/dist/runners/suppress-ios-autocorrect.js"() {
    "use strict";
    execFile5 = promisify6(execFileCb4);
  }
});

// packages/rn-dev-agent-core/dist/cdp/recover-wedge.js
import { execFile as execFileCb5 } from "node:child_process";
import { promisify as promisify7 } from "node:util";
var execFile6;
var init_recover_wedge = __esm({
  "packages/rn-dev-agent-core/dist/cdp/recover-wedge.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_rn_fast_runner_client();
    init_device_arbiter();
    init_recovery();
    execFile6 = promisify7(execFileCb5);
  }
});

// packages/rn-dev-agent-core/dist/cdp/app-installed-probe.js
import { execFile as execFileCb6 } from "node:child_process";
import { promisify as promisify8 } from "node:util";
var execFile7;
var init_app_installed_probe = __esm({
  "packages/rn-dev-agent-core/dist/cdp/app-installed-probe.js"() {
    "use strict";
    execFile7 = promisify8(execFileCb6);
  }
});

// packages/rn-dev-agent-core/dist/cdp/recover-detached.js
import { execFile as execFileCb7 } from "node:child_process";
import { promisify as promisify9 } from "node:util";
var execFile8;
var init_recover_detached = __esm({
  "packages/rn-dev-agent-core/dist/cdp/recover-detached.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_rn_fast_runner_client();
    init_device_arbiter();
    init_recovery();
    init_app_installed_probe();
    init_maestro_validator();
    execFile8 = promisify9(execFileCb7);
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

// packages/rn-dev-agent-core/dist/tools/device-session.js
import { execFile as execFileCb8 } from "node:child_process";
import { promisify as promisify10 } from "node:util";
var execFile9;
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
    execFile9 = promisify10(execFileCb8);
  }
});

// packages/rn-dev-agent-core/dist/tools/fill-verify.js
var init_fill_verify = __esm({
  "packages/rn-dev-agent-core/dist/tools/fill-verify.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/tools/device-interact.js
import { execFile as execFileCb9 } from "node:child_process";
import { promisify as promisify11 } from "node:util";
var execFile10;
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
    init_maestro_invoke();
    init_runner_leak_recovery();
    init_device_session();
    init_fast_runner_ref_map();
    init_fill_verify();
    execFile10 = promisify11(execFileCb9);
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
var init_utils = __esm({
  "packages/rn-dev-agent-core/dist/utils.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_dev_client_picker();
    init_recovery();
  }
});

// packages/rn-dev-agent-core/dist/runners/free-port.js
var init_free_port = __esm({
  "packages/rn-dev-agent-core/dist/runners/free-port.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/runners/rn-android-runner-client.js
import { spawn as spawn4, execFile as execFile11 } from "node:child_process";
import { promisify as promisify12 } from "node:util";
import { join as join12 } from "node:path";
var execFileAsync2, RN_ANDROID_RUNNER_DIR, GRADLEW, APK_APP, APK_TEST, ANDROID_REBUILD_ROOT, ANDROID_REBUILD_LOCK_DATABASE, ANDROID_REBUILD_LOCK_STALE_MS, fetchImpl2;
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
    execFileAsync2 = promisify12(execFile11);
    RN_ANDROID_RUNNER_DIR = resolveNativeRunnerDir("rn-android-runner");
    GRADLEW = join12(RN_ANDROID_RUNNER_DIR, "gradlew");
    APK_APP = join12(RN_ANDROID_RUNNER_DIR, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
    APK_TEST = join12(RN_ANDROID_RUNNER_DIR, "app", "build", "outputs", "apk", "androidTest", "debug", "app-debug-androidTest.apk");
    ANDROID_REBUILD_ROOT = join12(RN_ANDROID_RUNNER_DIR, "app", "build");
    ANDROID_REBUILD_LOCK_DATABASE = join12(ANDROID_REBUILD_ROOT, ".authority-rebuild", "lock.sqlite");
    ANDROID_REBUILD_LOCK_STALE_MS = 15 * 6e4;
    fetchImpl2 = globalThis.fetch;
  }
});

// packages/rn-dev-agent-core/dist/runners/release-android-slot.js
import { execFile as execFileCb10 } from "node:child_process";
import { promisify as promisify13 } from "node:util";
import { homedir as homedir4 } from "node:os";
import { join as join13 } from "node:path";
var execFile12, DAEMON_JSON2, DAEMON_LOCK2, OWNED_PACKAGES;
var init_release_android_slot = __esm({
  "packages/rn-dev-agent-core/dist/runners/release-android-slot.js"() {
    "use strict";
    init_rn_android_runner_client();
    init_agent_device_wrapper();
    execFile12 = promisify13(execFileCb10);
    DAEMON_JSON2 = join13(homedir4(), ".agent-device", "daemon.json");
    DAEMON_LOCK2 = join13(homedir4(), ".agent-device", "daemon.lock");
    OWNED_PACKAGES = [
      "dev.lykhoyda.rndevagent.androidrunner.test",
      "dev.lykhoyda.rndevagent.androidrunner"
    ];
  }
});

// packages/rn-dev-agent-core/dist/session-doctor.js
init_declared_source_contract();

// packages/rn-dev-agent-core/dist/session/process-owner.js
init_process_birth();
function defaultProcessState(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = error.code;
    if (code === "ESRCH")
      return "dead";
    if (code === "EPERM")
      return "alive";
    return "unknown";
  }
}
function inspectSessionOwner(owner, dependencies = {}) {
  const state = (dependencies.processState ?? defaultProcessState)(owner.pid);
  if (state === "dead")
    return "mismatch";
  if (state === "unknown")
    return "unknown";
  const observed = (dependencies.probeBirth ?? probeProcessBirth)(owner.pid);
  if (observed.status === "absent")
    return "mismatch";
  if (observed.status === "unknown")
    return "unknown";
  return observed.birth.token === owner.token ? "match" : "mismatch";
}

// packages/rn-dev-agent-core/dist/session-doctor.js
init_registry();
init_recovery_remedy();

// packages/rn-dev-agent-core/dist/session/source-identity.js
init_metro_cwd();
import { createHash as createHash3, createHmac, randomBytes as randomBytes2, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { execFileSync as execFileSync3 } from "node:child_process";
import { closeSync as closeSync2, constants as constants2, existsSync as existsSync3, fstatSync as fstatSync2, lstatSync as lstatSync3, openSync as openSync2, readdirSync, readFileSync as readFileSync2, readlinkSync, readSync as readSync2, realpathSync as realpathSync2 } from "node:fs";
import { dirname as dirname3, isAbsolute, join as join2, relative, resolve } from "node:path";

// packages/rn-dev-agent-core/dist/session/authority-json.js
var intrinsicJsonStringify = JSON.stringify;
var intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var intrinsicObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
var intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
var intrinsicArrayIsArray = Array.isArray;
var intrinsicArraySort = Array.prototype.sort;
var intrinsicNumberIsFinite = Number.isFinite;
var intrinsicReflectApply = Reflect.apply;
var IntrinsicObject = Object;
var intrinsicObjectPrototype = Object.prototype;
var IntrinsicWeakSet = WeakSet;
var intrinsicWeakSetAdd = WeakSet.prototype.add;
var intrinsicWeakSetDelete = WeakSet.prototype.delete;
var intrinsicWeakSetHas = WeakSet.prototype.has;
function quoted(value) {
  return intrinsicReflectApply(intrinsicJsonStringify, JSON, [value]);
}
function sortedOwnNames(value) {
  const names = intrinsicReflectApply(intrinsicObjectGetOwnPropertyNames, IntrinsicObject, [
    value
  ]);
  const enumerable = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const descriptor = intrinsicReflectApply(intrinsicObjectGetOwnPropertyDescriptor, IntrinsicObject, [value, name]);
    if (descriptor?.enumerable)
      enumerable.push(name);
  }
  return intrinsicReflectApply(intrinsicArraySort, enumerable, []);
}
function canonicalAuthorityJson(value) {
  const active = new IntrinsicWeakSet();
  const encode = (candidate) => {
    if (candidate === null)
      return "null";
    if (typeof candidate === "string")
      return quoted(candidate);
    if (typeof candidate === "boolean")
      return candidate ? "true" : "false";
    if (typeof candidate === "number") {
      return intrinsicNumberIsFinite(candidate) ? quoted(candidate) : "null";
    }
    if (typeof candidate !== "object") {
      throw new TypeError("AUTHORITY_JSON_UNSUPPORTED_VALUE");
    }
    if (intrinsicReflectApply(intrinsicWeakSetHas, active, [candidate])) {
      throw new TypeError("AUTHORITY_JSON_CYCLE");
    }
    intrinsicReflectApply(intrinsicWeakSetAdd, active, [candidate]);
    try {
      if (intrinsicArrayIsArray(candidate)) {
        let serialized2 = "[";
        for (let index = 0; index < candidate.length; index += 1) {
          if (index > 0)
            serialized2 += ",";
          const descriptor = intrinsicReflectApply(intrinsicObjectGetOwnPropertyDescriptor, IntrinsicObject, [candidate, String(index)]);
          if (!descriptor || !("value" in descriptor)) {
            throw new TypeError("AUTHORITY_JSON_ACCESSOR");
          }
          serialized2 += encode(descriptor.value);
        }
        return `${serialized2}]`;
      }
      const prototype = intrinsicReflectApply(intrinsicObjectGetPrototypeOf, IntrinsicObject, [
        candidate
      ]);
      if (prototype !== intrinsicObjectPrototype && prototype !== null) {
        throw new TypeError("AUTHORITY_JSON_UNSUPPORTED_OBJECT");
      }
      const names = sortedOwnNames(candidate);
      let serialized = "{";
      for (let index = 0; index < names.length; index += 1) {
        if (index > 0)
          serialized += ",";
        const name = names[index];
        const descriptor = intrinsicReflectApply(intrinsicObjectGetOwnPropertyDescriptor, IntrinsicObject, [candidate, name]);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("AUTHORITY_JSON_ACCESSOR");
        }
        serialized += `${quoted(name)}:${encode(descriptor.value)}`;
      }
      return `${serialized}}`;
    } finally {
      intrinsicReflectApply(intrinsicWeakSetDelete, active, [candidate]);
    }
  };
  return encode(value);
}

// packages/rn-dev-agent-core/dist/session/source-identity.js
init_declared_source_contract();

// packages/rn-dev-agent-core/dist/session/managed-metro-enforcement.js
var PREFLIGHT_SOURCE = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { closeSync, constants, fstatSync, openSync, readFileSync, readSync, writeFileSync } = require('node:fs');
const { createConnection, createServer } = require('node:net');
const input = JSON.parse(process.argv[1]);
const logicalArgumentPrefix = 'rn-dev-agent-logical-path:';
const denied = (run) => {
  try {
    run();
    return false;
  } catch (error) {
    return error && (error.code === 'EPERM' || error.code === 'EACCES');
  }
};
const unauthorizedResult = spawnSync('/usr/bin/true', []);
const unauthorizedExecutableDenied =
  unauthorizedResult.status === null &&
  unauthorizedResult.error &&
  (unauthorizedResult.error.code === 'EPERM' || unauthorizedResult.error.code === 'EACCES');
const unmanifestedReadDenied = denied(() => readFileSync(input.canaryPath));
const unmanifestedWriteDenied = denied(() => writeFileSync(input.canaryPath, 'forged'));
const symlinkEscapeDenied = denied(() => readFileSync(input.symlinkCanaryPath));
const listen = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => resolve({ ok: false, code: error.code }));
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => resolve({ ok: !error, code: error && error.code })),
    );
  });
const waitUntil = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};
const processGroupExists = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== 'ESRCH';
  }
};
(async () => {
  const commandSnapshots = [];
  const boundPaths = new Map();
  const argumentPaths = new Set(
    input.commandArguments.map((argument) =>
      argument.startsWith(logicalArgumentPrefix)
        ? argument.slice(logicalArgumentPrefix.length)
        : argument,
    ),
  );
  for (const entry of input.commandChainAttestation) {
    if (!argumentPaths.has(entry.path)) continue;
    const descriptor = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = fstatSync(descriptor).size;
    const contents = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, contents, offset, size - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    closeSync(descriptor);
    const snapshot = contents.subarray(0, offset);
    if (createHash('sha256').update(snapshot).digest('hex') !== entry.sha256) {
      throw new Error('command-chain identity mismatch');
    }
    boundPaths.set(entry.path, '/dev/fd/' + (10 + commandSnapshots.length));
    commandSnapshots.push(snapshot);
  }
  const allocated = await listen(input.port);
  if (!allocated.ok) throw new Error('allocated listener unavailable before command');
  const commandEnvironment = JSON.parse(readFileSync(input.preflightEnvironmentPath, 'utf8'));
  const stdio = ['ignore', 'ignore', 'ignore', 'ipc'];
  while (stdio.length < 9) stdio.push('ignore');
  stdio[8] = 'pipe';
  stdio.push('pipe');
  stdio.push(...commandSnapshots.map(() => 'pipe'));
  const command = spawn(
    input.commandExecutable,
    input.commandArguments.map((argument) =>
      argument.startsWith(logicalArgumentPrefix)
        ? argument.slice(logicalArgumentPrefix.length)
        : boundPaths.get(argument) ?? argument,
    ),
    {
    cwd: input.appRoot,
    detached: true,
    env: commandEnvironment,
    stdio,
    },
  );
  command.stdio[8].end('admitted\n');
  for (let index = 0; index < commandSnapshots.length; index += 1) {
    command.stdio[10 + index].end(commandSnapshots[index]);
  }
  command.stdio[9].resume();
  command.once('error', () => {});
  const resolvedCommandAllowed = await waitUntil(async () => {
    const probe = await listen(input.port);
    return !probe.ok && probe.code === 'EADDRINUSE';
  }, 15000);
  let commandCleanupConfirmed = false;
  if (Number.isSafeInteger(command.pid)) {
    try {
      command.kill('SIGTERM');
    } catch {}
    try {
      process.kill(-command.pid, 'SIGTERM');
    } catch {}
    await waitUntil(() => command.exitCode !== null, 2000);
    commandCleanupConfirmed = !processGroupExists(command.pid);
    if (!commandCleanupConfirmed) {
      try {
        command.kill('SIGKILL');
      } catch {}
      try {
        process.kill(-command.pid, 'SIGKILL');
      } catch {}
      await waitUntil(() => command.exitCode !== null, 2000);
      commandCleanupConfirmed = !processGroupExists(command.pid);
    }
  }
  const released = await listen(input.port);
  commandCleanupConfirmed = commandCleanupConfirmed && released.ok;
  const commandChainStable = true;
  const descendantCreationAllowed = resolvedCommandAllowed && commandCleanupConfirmed;
  const unallocated = await listen(input.unallocatedPort);
  const networkOutboundDenied = await new Promise((resolve) => {
    const connection = createConnection(input.port, '127.0.0.1');
    connection.once('connect', () => {
      connection.destroy();
      resolve(false);
    });
    connection.once('error', (error) =>
      resolve(error.code === 'EPERM' || error.code === 'EACCES'),
    );
  });
  const receipt = {
    descendantCreationAllowed,
    unauthorizedExecutableDenied: Boolean(unauthorizedExecutableDenied),
    unmanifestedReadDenied,
    unmanifestedWriteDenied,
    symlinkEscapeDenied,
    unallocatedListenerDenied:
      !unallocated.ok && (unallocated.code === 'EPERM' || unallocated.code === 'EACCES'),
    allocatedListenerAllowed: allocated.ok,
    networkOutboundDenied,
    resolvedCommandAllowed,
    commandCleanupConfirmed,
    commandChainStable,
  };
  process.stdout.write(JSON.stringify(receipt));
  process.exit(Object.values(receipt).every(Boolean) ? 0 : 1);
})().catch(() => process.exit(1));
`;

// packages/rn-dev-agent-core/dist/session/source-identity.js
function digest(parts) {
  const hash = createHash3("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}
var MAX_STRICT_PROOF_FILE_BYTES = 16 * 1024 * 1024;
var MAX_STRICT_PROOF_TOTAL_BYTES = 64 * 1024 * 1024;
var MAX_STRICT_PROOF_DEPENDENCY_FILE_BYTES = 128 * 1024 * 1024;
var MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES = 512 * 1024 * 1024;
var STRICT_PROOF_READ_BUFFER_BYTES = 64 * 1024;
var EXCLUDED_RUNTIME_DIRECTORIES = [
  ".gradle",
  ".expo",
  ".cache",
  "ios/Pods",
  "ios/build",
  "ios/DerivedData",
  "android/build",
  "android/app/build",
  "android/app/.cxx"
];
var IGNORED_RUNTIME_INPUT_PATHS = [
  ":(top,glob)**",
  ":(top,exclude,glob)**/node_modules/**",
  ":(top,exclude,glob)**/.yarn/cache/**",
  ":(top,exclude,glob)**/.yarn/unplugged/**",
  ...EXCLUDED_RUNTIME_DIRECTORIES.map((entry) => `:(top,exclude,glob)**/${entry}/**`)
];
var METRO_INTEGRATION_START = "// rn-dev-agent session integration: begin";
var METRO_INTEGRATION_END = "// rn-dev-agent session integration: end";
var METRO_INTEGRATION_BLOCK = `${METRO_INTEGRATION_START}
module.exports = require('./.rn-agent/integration/rn-session-metro.cjs')(module.exports);
${METRO_INTEGRATION_END}`;
var METRO_EVIDENCE_HEAD_CLIENT = String.raw`
const { createConnection } = require('node:net');
const socket = createConnection(process.argv[1]);
let response = '';
socket.setEncoding('utf8');
socket.setTimeout(1500);
socket.once('connect', () => socket.write(process.argv[2] + '\n'));
socket.on('data', (chunk) => {
  response += chunk;
  if (response.length > 4096) process.exit(2);
});
socket.once('end', () => process.stdout.write(response));
socket.once('timeout', () => process.exit(3));
socket.once('error', () => process.exit(4));
`;
function defaultGit(root, args) {
  return execFileSync3("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5e3,
    maxBuffer: 64 * 1024 * 1024
  }).trim();
}
function isDefinitiveNonGitError(error) {
  if (!(error instanceof Error))
    return false;
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "stderr" in error && Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : "";
  return `${error.message}
${stderr}`.toLowerCase().includes("not a git repository");
}
function assertContained(root, candidate, code) {
  const child = relative(root, candidate);
  if (child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) {
    throw new Error(`${code}: path is outside the declared content root`);
  }
}
function resolveDeclaredIdentity(appRoot, dependencies, canonicalize) {
  if (!dependencies.declaredRoot)
    throw new Error(missingDeclaredRootMessage());
  if (!dependencies.declaredManifests?.length) {
    throw new Error(missingDeclaredManifestListMessage());
  }
  const pathExists = dependencies.exists ?? existsSync3;
  const contentRoot = canonicalize(resolve(dependencies.declaredRoot));
  assertContained(contentRoot, appRoot, "NON_GIT_ROOT_MISMATCH");
  const manifestParts = [];
  for (const entry of [...dependencies.declaredManifests].sort()) {
    const declared = resolve(contentRoot, entry);
    if (!pathExists(declared))
      throw new Error(missingDeclaredManifestMessage(entry));
    const manifest = canonicalize(declared);
    assertContained(contentRoot, manifest, "NON_GIT_MANIFEST_OUTSIDE_ROOT");
    manifestParts.push(relative(contentRoot, manifest), readFileSync2(manifest));
  }
  const manifestDigest = digest(manifestParts);
  const appRelative = relative(contentRoot, appRoot) || ".";
  return {
    kind: "declared-root",
    contentRoot,
    appRoot,
    sourceKey: digest(["declared-source", contentRoot, manifestDigest]),
    worktreeKey: digest(["declared-root", contentRoot]),
    appRootKey: digest(["declared-app", appRelative]),
    manifestDigest,
    declaredManifests: [...dependencies.declaredManifests]
  };
}
function resolveSourceIdentity(inputRoot, dependencies = {}) {
  const canonicalize = dependencies.canonicalize ?? realpathSync2;
  const appRoot = canonicalize(resolve(inputRoot));
  const git = dependencies.git ?? defaultGit;
  try {
    const contentRoot = canonicalize(git(appRoot, ["rev-parse", "--show-toplevel"]));
    assertContained(contentRoot, appRoot, "APP_ROOT_OUTSIDE_WORKTREE");
    const commonRaw = git(appRoot, ["rev-parse", "--git-common-dir"]);
    const commonDirectory = canonicalize(isAbsolute(commonRaw) ? commonRaw : join2(appRoot, commonRaw));
    const head = git(appRoot, ["rev-parse", "HEAD"]);
    const appRelative = relative(contentRoot, appRoot) || ".";
    return {
      kind: "git",
      contentRoot,
      appRoot,
      sourceKey: digest(["git-source", commonDirectory]),
      worktreeKey: digest(["git-worktree", contentRoot]),
      appRootKey: digest(["git-app", appRelative]),
      head
    };
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("APP_ROOT_OUTSIDE_WORKTREE") || error.message.startsWith("NON_GIT_"))) {
      throw error;
    }
    if (!isDefinitiveNonGitError(error))
      throw error;
    return resolveDeclaredIdentity(appRoot, dependencies, canonicalize);
  }
}

// packages/rn-dev-agent-core/dist/session/startup-cleanup.js
init_secure_state_file();
import { createHash as createHash6 } from "node:crypto";
import { join as join14 } from "node:path";

// packages/rn-dev-agent-core/dist/session/managed-metro.js
import { execFileSync as execFileSync4, spawn } from "node:child_process";
import { createHash as createHash4, createHmac as createHmac2, timingSafeEqual as timingSafeEqual3 } from "node:crypto";
import { closeSync as closeSync3, existsSync as existsSync4, fstatSync as fstatSync3, mkdirSync as mkdirSync3, openSync as openSync3, readFileSync as readFileSync4, readSync as readSync3, realpathSync as realpathSync3, rmSync } from "node:fs";
init_metro_binding();
init_trusted_system_executable();
init_process_birth();
var METRO_LAUNCHER_SOURCE = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { createHash, createHmac } = require('node:crypto');
const { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } = require('node:fs');
const { createServer } = require('node:net');
const { basename, dirname, isAbsolute, relative, sep } = require('node:path');
const intrinsicJsonStringify = JSON.stringify;
const intrinsicGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicGetOwnPropertyNames = Object.getOwnPropertyNames;
const intrinsicGetPrototypeOf = Object.getPrototypeOf;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicArraySort = Array.prototype.sort;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicReflectApply = Reflect.apply;
const intrinsicObjectPrototype = Object.prototype;
const IntrinsicObject = Object;
const IntrinsicWeakSet = WeakSet;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicWeakSetDelete = WeakSet.prototype.delete;
const intrinsicWeakSetHas = WeakSet.prototype.has;
function canonicalAuthorityJson(value) {
  const active = new IntrinsicWeakSet();
  const encode = (candidate) => {
    if (candidate === null) return 'null';
    if (typeof candidate === 'string') {
      return intrinsicReflectApply(intrinsicJsonStringify, JSON, [candidate]);
    }
    if (typeof candidate === 'number') {
      return intrinsicNumberIsFinite(candidate)
        ? intrinsicReflectApply(intrinsicJsonStringify, JSON, [candidate])
        : 'null';
    }
    if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
    if (typeof candidate !== 'object') throw new TypeError('AUTHORITY_JSON_UNSUPPORTED_VALUE');
    if (intrinsicReflectApply(intrinsicWeakSetHas, active, [candidate])) {
      throw new TypeError('AUTHORITY_JSON_CYCLE');
    }
    intrinsicReflectApply(intrinsicWeakSetAdd, active, [candidate]);
    try {
      if (intrinsicArrayIsArray(candidate)) {
        let serialized = '[';
        for (let index = 0; index < candidate.length; index += 1) {
          if (index > 0) serialized += ',';
          const descriptor = intrinsicReflectApply(
            intrinsicGetOwnPropertyDescriptor,
            IntrinsicObject,
            [candidate, String(index)],
          );
          if (!descriptor || !('value' in descriptor)) throw new TypeError('AUTHORITY_JSON_ACCESSOR');
          serialized += encode(descriptor.value);
        }
        return serialized + ']';
      }
      const prototype = intrinsicReflectApply(
        intrinsicGetPrototypeOf,
        IntrinsicObject,
        [candidate],
      );
      if (prototype !== intrinsicObjectPrototype && prototype !== null) {
        throw new TypeError('AUTHORITY_JSON_UNSUPPORTED_OBJECT');
      }
      const names = intrinsicReflectApply(
        intrinsicGetOwnPropertyNames,
        IntrinsicObject,
        [candidate],
      );
      const enumerable = [];
      for (let index = 0; index < names.length; index += 1) {
        const descriptor = intrinsicReflectApply(
          intrinsicGetOwnPropertyDescriptor,
          IntrinsicObject,
          [candidate, names[index]],
        );
        if (descriptor?.enumerable) enumerable.push(names[index]);
      }
      intrinsicReflectApply(intrinsicArraySort, enumerable, []);
      let serialized = '{';
      for (let index = 0; index < enumerable.length; index += 1) {
        if (index > 0) serialized += ',';
        const name = enumerable[index];
        const descriptor = intrinsicReflectApply(
          intrinsicGetOwnPropertyDescriptor,
          IntrinsicObject,
          [candidate, name],
        );
        if (!descriptor || !('value' in descriptor)) throw new TypeError('AUTHORITY_JSON_ACCESSOR');
        serialized +=
          intrinsicReflectApply(intrinsicJsonStringify, JSON, [name]) +
          ':' +
          encode(descriptor.value);
      }
      return serialized + '}';
    } finally {
      intrinsicReflectApply(intrinsicWeakSetDelete, active, [candidate]);
    }
  };
  return encode(value);
}
const launcherDiagnosticPath = process.env.RN_DEV_AGENT_METRO_LAUNCHER_DIAGNOSTIC;
function failLauncher(code, stage, detail) {
  const diagnostic = { version: 1, code, stage, detail };
  if (launcherDiagnosticPath) {
    try {
      writeFileSync(launcherDiagnosticPath, intrinsicJsonStringify(diagnostic), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {}
  }
  try {
    process.stderr.write(code + ': stage=' + stage + '; detail=' + detail + '\n');
  } catch {}
  process.exit(1);
}
const executable = process.env.RN_DEV_AGENT_METRO_EXECUTABLE;
let args;
try {
  args = JSON.parse(process.env.RN_DEV_AGENT_METRO_ARGS || '[]');
} catch {
  failLauncher('METRO_LAUNCHER_ENVIRONMENT_INVALID', 'environment', 'arguments-invalid');
}
const evidencePath = process.env.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE;
const evidenceSocket = process.env.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE_SOCKET;
const policyPath = process.env.RN_DEV_AGENT_METRO_RUNTIME_POLICY;
const capability = process.env.RN_DEV_AGENT_METRO_POLICY_CAPABILITY;
const sessionId = process.env.RN_DEV_AGENT_SESSION_ID;
const metroInstanceId = process.env.RN_DEV_AGENT_METRO_INSTANCE_ID;
const childNodeOptions = process.env.RN_DEV_AGENT_METRO_CHILD_NODE_OPTIONS;
const contentRoot = process.env.RN_DEV_AGENT_METRO_CONTENT_ROOT;
const appRoot = process.env.RN_DEV_AGENT_METRO_APP_ROOT;
const childEnvironmentSource = process.env.RN_DEV_AGENT_METRO_CHILD_ENVIRONMENT;
const runtimeManifestSource = process.env.RN_DEV_AGENT_METRO_RUNTIME_MANIFEST;
const runtimeEnforcementSource = process.env.RN_DEV_AGENT_METRO_RUNTIME_ENFORCEMENT;
const nativeAddonAcknowledgmentRoot = process.env.RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT;
const requiredEnvironment = [
  [launcherDiagnosticPath, 'diagnostic-path-missing'],
  [executable, 'executable-missing'],
  [evidencePath, 'evidence-path-missing'],
  [evidenceSocket, 'evidence-socket-missing'],
  [policyPath, 'policy-path-missing'],
  [capability, 'policy-capability-missing'],
  [sessionId, 'session-id-missing'],
  [metroInstanceId, 'metro-instance-id-missing'],
  [childNodeOptions, 'child-node-options-missing'],
  [contentRoot, 'content-root-missing'],
  [appRoot, 'app-root-missing'],
  [childEnvironmentSource, 'child-environment-missing'],
  [runtimeManifestSource, 'runtime-manifest-missing'],
  [runtimeEnforcementSource, 'runtime-enforcement-missing'],
  [nativeAddonAcknowledgmentRoot, 'native-addon-ack-root-missing'],
];
const missingEnvironment = requiredEnvironment.find(([value]) => !value);
if (missingEnvironment) {
  failLauncher(
    'METRO_LAUNCHER_ENVIRONMENT_INVALID',
    'environment',
    missingEnvironment[1],
  );
}
const policyDirectoryPath = dirname(policyPath);
const policyName = basename(policyPath);
const launcherWorkingDirectory = process.cwd();
let policyDirectoryDescriptor;
let policyDescriptor;
let policyDirectoryIdentity;
let policyIdentity;
try {
  policyDirectoryDescriptor = openSync(
    policyDirectoryPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  policyDirectoryIdentity = fstatSync(policyDirectoryDescriptor, { bigint: true });
  if (!policyDirectoryIdentity.isDirectory()) throw new Error('policy-directory-not-regular');
  process.chdir(policyDirectoryPath);
  const boundDirectory = statSync('.', { bigint: true });
  if (
    boundDirectory.dev !== policyDirectoryIdentity.dev ||
    boundDirectory.ino !== policyDirectoryIdentity.ino
  ) {
    throw new Error('policy-directory-identity-mismatch');
  }
  policyDescriptor = openSync(
    policyName,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  policyIdentity = fstatSync(policyDescriptor, { bigint: true });
  const publishedPolicy = lstatSync(policyPath, { bigint: true });
  if (
    !policyIdentity.isFile() ||
    policyIdentity.nlink !== 1n ||
    publishedPolicy.dev !== policyIdentity.dev ||
    publishedPolicy.ino !== policyIdentity.ino
  ) {
    throw new Error('policy-file-identity-mismatch');
  }
  fchmodSync(policyDescriptor, 0o600);
  process.chdir(launcherWorkingDirectory);
} catch (error) {
  try {
    process.chdir(launcherWorkingDirectory);
  } catch {}
  const detail =
    error instanceof Error && /^policy-[a-z-]+$/.test(error.message)
      ? error.message
      : 'policy-binding-failed';
  failLauncher(
    'METRO_LAUNCHER_POLICY_UNAVAILABLE',
    'policy-binding',
    detail,
  );
}
function assertPolicyIdentity() {
  const retainedDirectory = fstatSync(policyDirectoryDescriptor, { bigint: true });
  const retainedPolicy = fstatSync(policyDescriptor, { bigint: true });
  const publishedPolicy = lstatSync(policyPath, { bigint: true });
  if (
    !retainedDirectory.isDirectory() ||
    retainedDirectory.dev !== policyDirectoryIdentity.dev ||
    retainedDirectory.ino !== policyDirectoryIdentity.ino ||
    !retainedPolicy.isFile() ||
    retainedPolicy.nlink !== 1n ||
    retainedPolicy.dev !== policyIdentity.dev ||
    retainedPolicy.ino !== policyIdentity.ino ||
    publishedPolicy.dev !== policyIdentity.dev ||
    publishedPolicy.ino !== policyIdentity.ino
  ) {
    throw new Error('policy-publication-identity-mismatch');
  }
}
let runtimeManifest;
let runtimeEnforcement;
try {
  runtimeManifest = JSON.parse(runtimeManifestSource);
  runtimeEnforcement = JSON.parse(runtimeEnforcementSource);
} catch {
  failLauncher('METRO_LAUNCHER_ENVIRONMENT_INVALID', 'environment', 'manifest-invalid');
}
const logicalArgumentPrefix = 'rn-dev-agent-logical-path:';
const enforcementReceipt = runtimeEnforcement.receipt;
const snapshotAttestedFiles = (entries, arguments_, firstDescriptor) => {
  if (!Array.isArray(entries)) throw new Error('invalid command-chain attestation');
  const snapshots = [];
  const paths = new Map();
  const argumentPaths = new Set(
    arguments_.map((argument) =>
      argument.startsWith(logicalArgumentPrefix)
        ? argument.slice(logicalArgumentPrefix.length)
        : argument,
    ),
  );
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error('invalid command-chain attestation');
    }
    const descriptor = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = fstatSync(descriptor).size;
    const contents = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, contents, offset, size - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    closeSync(descriptor);
    const snapshot = contents.subarray(0, offset);
    if (createHash('sha256').update(snapshot).digest('hex') !== entry.sha256) {
      throw new Error('command-chain identity mismatch');
    }
    if (!argumentPaths.has(entry.path)) continue;
    paths.set(entry.path, '/dev/fd/' + (firstDescriptor + snapshots.length));
    snapshots.push(snapshot);
  }
  return { snapshots, paths };
};
const liveCodeIdentityMatches = (pid, identity) => {
  if (
    !Number.isSafeInteger(pid) ||
    !identity ||
    typeof identity.identifier !== 'string' ||
    typeof identity.cdHash !== 'string'
  ) {
    return false;
  }
  const verification = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '+' + pid], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (verification.status !== 0) return false;
  const details = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', '+' + pid], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (details.status !== 0) return false;
  const fields = new Map(
    details.stderr
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1).trim()];
      }),
  );
  return (
    fields.get('Identifier') === identity.identifier &&
    fields.get('CDHash') === identity.cdHash
  );
};
const waitForLiveCodeIdentity = (pid, identity) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (liveCodeIdentityMatches(pid, identity)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return false;
};
let child;
let commandChainSnapshot = null;
try {
  commandChainSnapshot = snapshotAttestedFiles(
    enforcementReceipt?.commandChainAttestation ?? [],
    args,
    10,
  );
} catch {
  commandChainSnapshot = null;
}
let managedSandbox =
  runtimeEnforcement.status === 'enforced' &&
  runtimeEnforcement.kind === 'darwin-seatbelt-v2' &&
  runtimeEnforcement.sandboxExecutable === '/usr/bin/sandbox-exec' &&
  typeof runtimeEnforcement.profile === 'string' &&
  /^[a-f0-9]{64}$/.test(runtimeEnforcement.profileSha256 || '') &&
  createHash('sha256').update(runtimeEnforcement.profile).digest('hex') ===
    runtimeEnforcement.profileSha256 &&
  enforcementReceipt?.version === 2 &&
  enforcementReceipt.kind === runtimeEnforcement.kind &&
  enforcementReceipt.profileSha256 === runtimeEnforcement.profileSha256 &&
  enforcementReceipt.sandboxExecutableSha256 ===
    runtimeEnforcement.sandboxExecutableSha256 &&
  enforcementReceipt.sandboxExecutableCdHash ===
    runtimeEnforcement.sandboxExecutableCdHash &&
  enforcementReceipt.commandLaunchSha256 === runtimeEnforcement.commandLaunchSha256 &&
  enforcementReceipt.resolvedCommandSha256 === runtimeEnforcement.resolvedCommandSha256 &&
  enforcementReceipt.descendantCreationAllowed === true &&
  enforcementReceipt.unauthorizedExecutableDenied === true &&
  enforcementReceipt.unmanifestedReadDenied === true &&
  enforcementReceipt.unmanifestedWriteDenied === true &&
  enforcementReceipt.symlinkEscapeDenied === true &&
  enforcementReceipt.unallocatedListenerDenied === true &&
  enforcementReceipt.allocatedListenerAllowed === true &&
  enforcementReceipt.networkOutboundDenied === true &&
  enforcementReceipt.resolvedCommandAllowed === true &&
  enforcementReceipt.commandCleanupConfirmed === true &&
  enforcementReceipt.commandChainStable === true &&
  commandChainSnapshot !== null &&
  canonicalAuthorityJson(enforcementReceipt.nodeRuntimeAttestation) ===
    canonicalAuthorityJson(runtimeEnforcement.nodeRuntimeAttestation) &&
  canonicalAuthorityJson(enforcementReceipt.commandChainAttestation) ===
    canonicalAuthorityJson(runtimeEnforcement.commandChainAttestation);
let runtimeEvidenceAuthority = managedSandbox ? 'managed-sandbox-v1' : 'reported-v1';
const evidenceDescriptor = 9;
let journalDescriptor;
try {
  journalDescriptor = openSync(evidencePath, 'w', 0o600);
} catch {
  failLauncher('METRO_LAUNCHER_EVIDENCE_UNAVAILABLE', 'evidence-journal', 'journal-open-failed');
}
let sequence = 0;
let previousSignature = null;
let buffered = '';
function appendEvidence(payload) {
  const chainedPayload = {
    ...payload,
    runtimeEvidenceAuthority,
    sequence: ++sequence,
    previousSignature,
  };
  const signature = createHmac('sha256', capability)
    .update(canonicalAuthorityJson(chainedPayload))
    .digest('hex');
  writeSync(
    journalDescriptor,
    canonicalAuthorityJson({ ...chainedPayload, signature }) + '\n',
  );
  previousSignature = signature;
}
const violations = [];
function publishPolicy() {
  const payload = {
    version: 1,
    runtimeEvidenceAuthority,
    sessionId,
    metroInstanceId,
    contentRoot,
    appRoot,
    runtimeEnforcement: managedSandbox ? 'os-enforced-v1' : 'unsupported',
    runtimeEnforcementReceipt: managedSandbox ? enforcementReceipt : null,
    runtimeManifest,
    runtimeInputs: runtimeManifest.runtimeInputs,
    violations: [...violations],
  };
  const signature = createHmac('sha256', capability)
    .update(canonicalAuthorityJson(payload))
    .digest('hex');
  const publication = Buffer.from(
    canonicalAuthorityJson({ ...payload, signature }) + '\n',
    'utf8',
  );
  assertPolicyIdentity();
  ftruncateSync(policyDescriptor, 0);
  let offset = 0;
  while (offset < publication.length) {
    offset += writeSync(
      policyDescriptor,
      publication,
      offset,
      publication.length - offset,
      offset,
    );
  }
  fsyncSync(policyDescriptor);
  assertPolicyIdentity();
}
function appendViolation(value) {
  if (!violations.includes(value)) violations.push(value);
  publishPolicy();
  appendEvidence({
    version: 1,
    sessionId,
    metroInstanceId,
    kind: 'violation',
    value,
    digest: null,
  });
}
function publishNativeAddonAcknowledgment(requestId, acknowledgment) {
  writeFileSync(
    nativeAddonAcknowledgmentRoot + '/' + requestId + '.json',
    canonicalAuthorityJson({ version: 1, requestId, ...acknowledgment }),
    { encoding: 'utf8', flag: 'wx', mode: 0o400 },
  );
}
const pendingNativeAddons = new Map();
function digestNativeAddon(candidate) {
  const sourceDescriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(sourceDescriptor);
    if (!initial.isFile()) {
      const error = new Error('native addon is not a regular file');
      error.code = 'NATIVE_ADDON_NOT_REGULAR';
      throw error;
    }
    if (initial.size > 128 * 1024 * 1024) {
      const error = new Error('native addon exceeds the 128 MiB evidence limit');
      error.code = 'NATIVE_ADDON_TOO_LARGE';
      throw error;
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < initial.size) {
      const bytesRead = readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.length, initial.size - position),
        position,
      );
      if (bytesRead === 0 || position + bytesRead > 128 * 1024 * 1024) {
        const error = new Error('native addon changed while reading evidence');
        error.code = 'NATIVE_ADDON_CHANGED';
        throw error;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (readSync(sourceDescriptor, buffer, 0, 1, position) !== 0) {
      const error = new Error('native addon changed while reading evidence');
      error.code = 'NATIVE_ADDON_CHANGED';
      throw error;
    }
    const final = fstatSync(sourceDescriptor);
    if (
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      const error = new Error('native addon changed while reading evidence');
      error.code = 'NATIVE_ADDON_CHANGED';
      throw error;
    }
    return hash.digest('hex');
  } finally {
    closeSync(sourceDescriptor);
  }
}
function runtimeInputWithinRoot(candidate, root) {
  const nested = relative(root, candidate);
  return nested === '' || (
    nested !== '..' &&
    !nested.startsWith('..' + sep) &&
    !isAbsolute(nested)
  );
}
function handleNativeAddonRequest(payload) {
  let request;
  try {
    request = JSON.parse(payload.value);
    if (
      !request ||
      !/^[a-f0-9]{32}$/.test(request.requestId || '') ||
      typeof request.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(request.digest || '')
    ) {
      throw new Error('invalid request');
    }
    const candidate = realpathSync(request.path);
    const allowedRoots = runtimeManifest.nativeAddonRoots;
    if (
      !Array.isArray(allowedRoots) ||
      !allowedRoots.some(
        (root) => typeof root === 'string' && runtimeInputWithinRoot(candidate, root),
      )
    ) {
      const error = new Error('outside:' + basename(request.path));
      error.code = 'NATIVE_ADDON_OUTSIDE_ROOTS';
      throw error;
    }
    const digest = digestNativeAddon(candidate);
    if (digest !== request.digest) {
      const error = new Error('native addon changed before signed evidence');
      error.code = 'NATIVE_ADDON_CHANGED';
      throw error;
    }
    appendEvidence({
      version: 1,
      sessionId,
      metroInstanceId,
      kind: 'input',
      value: candidate,
      digest,
    });
    fsyncSync(journalDescriptor);
    pendingNativeAddons.set(request.requestId, { path: candidate, digest });
    publishNativeAddonAcknowledgment(request.requestId, {
      accepted: true,
      digest,
      path: candidate,
      reason: null,
    });
  } catch (error) {
    const reason =
      error?.code === 'NATIVE_ADDON_OUTSIDE_ROOTS'
        ? 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON: ' + error.message
        : 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: ' +
          (error instanceof Error ? error.message : 'native addon bytes could not be verified');
    appendViolation(reason);
    if (request && /^[a-f0-9]{32}$/.test(request.requestId || '')) {
      try {
        publishNativeAddonAcknowledgment(request.requestId, {
          accepted: false,
          digest: typeof request.digest === 'string' ? request.digest : null,
          path: null,
          reason,
        });
      } catch {}
    }
  }
}
function handleNativeAddonCompletion(payload) {
  let completion;
  try {
    completion = JSON.parse(payload.value);
    if (
      !completion ||
      !/^[a-f0-9]{32}$/.test(completion.requestId || '') ||
      typeof completion.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(completion.digest || '') ||
      !['success', 'failure'].includes(completion.outcome)
    ) {
      throw new Error('completion record is invalid');
    }
    const pending = pendingNativeAddons.get(completion.requestId);
    if (
      !pending ||
      pending.path !== completion.path ||
      pending.digest !== completion.digest ||
      digestNativeAddon(pending.path) !== pending.digest
    ) {
      throw new Error('native addon changed during load');
    }
    pendingNativeAddons.delete(completion.requestId);
    rmSync(nativeAddonAcknowledgmentRoot + '/' + completion.requestId + '.json', {
      force: true,
    });
    if (completion.outcome === 'success') {
      appendEvidence({
        version: 1,
        sessionId,
        metroInstanceId,
        kind: 'stability',
        value: pending.path,
        digest: pending.digest,
      });
    } else {
      appendViolation('METRO_NATIVE_ADDON_LOAD_FAILED: ' + basename(pending.path));
    }
  } catch (error) {
    if (completion && /^[a-f0-9]{32}$/.test(completion.requestId || '')) {
      pendingNativeAddons.delete(completion.requestId);
      rmSync(nativeAddonAcknowledgmentRoot + '/' + completion.requestId + '.json', {
        force: true,
      });
    }
    appendViolation(
      'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: ' +
        (error instanceof Error ? error.message : 'native addon stability could not be verified'),
    );
  }
}
if (process.platform !== 'win32') rmSync(evidenceSocket, { force: true });
const headConnections = new Set();
const pendingHeads = new Map();
function closeHeadConnection(connection) {
  headConnections.delete(connection);
  for (const [challenge, pending] of pendingHeads) {
    if (pending === connection) pendingHeads.delete(challenge);
  }
}
function respondWithHead(connection, challenge) {
  if (pendingNativeAddons.size > 0) {
    connection.destroy();
    return;
  }
  const payload = {
    version: 1,
    runtimeEvidenceAuthority,
    sessionId,
    metroInstanceId,
    challenge,
    sequence,
    journalSignature: previousSignature,
  };
  const signature = createHmac('sha256', capability)
    .update(canonicalAuthorityJson(payload))
    .digest('hex');
  connection.end(canonicalAuthorityJson({ ...payload, signature }) + '\n');
}
const headServer = createServer((connection) => {
  headConnections.add(connection);
  let request = '';
  connection.setEncoding('utf8');
  connection.setTimeout(1500, () => connection.destroy());
  connection.once('close', () => closeHeadConnection(connection));
  connection.on('data', (chunk) => {
    request += chunk;
    if (request.length > 256) {
      connection.destroy();
      return;
    }
    const newline = request.indexOf('\n');
    if (newline < 0) return;
    const challenge = request.slice(0, newline);
    if (!/^[a-f0-9]{64}$/.test(challenge)) {
      connection.destroy();
      return;
    }
    if (pendingHeads.has(challenge) || evidenceFinished || !child?.connected) {
      connection.destroy();
      return;
    }
    pendingHeads.set(challenge, connection);
    try {
      child.send({ type: 'rn-dev-agent:evidence-barrier', challenge }, (error) => {
        if (error) connection.destroy();
      });
    } catch {
      connection.destroy();
    }
  });
});
headServer.once('error', () =>
  failLauncher(
    'METRO_LAUNCHER_EVIDENCE_UNAVAILABLE',
    'evidence-listener',
    'evidence-listener-error',
  ),
);
headServer.listen(evidenceSocket, () => {
  if (process.platform !== 'win32') chmodSync(evidenceSocket, 0o600);
});
const childEnvironment = JSON.parse(childEnvironmentSource);
const environmentDigest = createHash('sha256')
  .update(canonicalAuthorityJson(childEnvironment))
  .digest('hex');
if (environmentDigest !== runtimeManifest.environmentDigest) {
  failLauncher(
    'METRO_LAUNCHER_ENVIRONMENT_INVALID',
    'environment-digest',
    'child-environment-mismatch',
  );
}
if (runtimeEnforcement.status === 'enforced' && !managedSandbox) {
  failLauncher(
    'METRO_LAUNCHER_ENFORCEMENT_REFUSED',
    'enforcement',
    'sandbox-admission-invalid',
  );
}
const sandboxExecutable = runtimeEnforcement.sandboxExecutable;
const boundArgs = args.map((argument) =>
  argument.startsWith(logicalArgumentPrefix)
    ? argument.slice(logicalArgumentPrefix.length)
    : commandChainSnapshot?.paths.get(argument) ?? argument,
);
const sandboxArgs = managedSandbox
  ? ['-p', runtimeEnforcement.profile, executable, ...boundArgs]
  : boundArgs;
child = spawn(managedSandbox ? sandboxExecutable : executable, sandboxArgs, {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: [
    'inherit',
    'inherit',
    'inherit',
    'ipc',
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    'pipe',
    'pipe',
    ...(commandChainSnapshot?.snapshots.map(() => 'pipe') ?? []),
  ],
});
if (!Number.isSafeInteger(child.pid)) {
  failLauncher(
    'METRO_LAUNCHER_CHILD_SPAWN_FAILED',
    'child-spawn',
    'child-pid-unavailable',
  );
}
for (let index = 0; index < (commandChainSnapshot?.snapshots.length ?? 0); index += 1) {
  child.stdio[10 + index].end(commandChainSnapshot.snapshots[index]);
}
if (
  managedSandbox &&
  !waitForLiveCodeIdentity(
    child.pid,
    enforcementReceipt.commandChainAttestation?.find(
      (entry) => entry.path === executable,
    )?.signingIdentity,
  )
) {
  managedSandbox = false;
  runtimeEvidenceAuthority = 'reported-v1';
  appendViolation('Metro command executable kernel identity did not match attestation');
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  failLauncher(
    'METRO_LAUNCHER_ENFORCEMENT_REFUSED',
    'child-admission',
    'command-identity-mismatch',
  );
}
child.stdio[8].end('admitted\n');
runtimeManifest.descendantAuthority.rootIdentity = 'process:' + child.pid;
appendEvidence({
  version: 1,
  sessionId,
  metroInstanceId,
  kind: 'semantics',
  value: canonicalAuthorityJson(runtimeManifest),
  digest: null,
});
publishPolicy();
const evidence = child.stdio[evidenceDescriptor];
let childOutcome = null;
let evidenceFinished = false;
let launcherFinished = false;
function finishLauncher() {
  if (launcherFinished || childOutcome === null || !evidenceFinished) return;
  launcherFinished = true;
  if (buffered) appendViolation('Metro runtime evidence record is incomplete');
  for (const requestId of pendingNativeAddons.keys()) {
    pendingNativeAddons.delete(requestId);
    rmSync(nativeAddonAcknowledgmentRoot + '/' + requestId + '.json', { force: true });
    appendViolation('METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: stability receipt is missing');
  }
  for (const connection of headConnections) connection.destroy();
  pendingHeads.clear();
  closeSync(journalDescriptor);
  headServer.close(() => {
    if (process.platform !== 'win32') rmSync(evidenceSocket, { force: true });
    process.exit(childOutcome.signal ? 1 : childOutcome.code);
  });
}
function finishEvidence() {
  if (evidenceFinished) return;
  if (child.exitCode === null && child.signalCode === null) {
    appendViolation('Metro runtime evidence stream ended before Metro exited');
  }
  evidenceFinished = true;
  finishLauncher();
}
evidence.setEncoding('utf8');
evidence.on('data', (chunk) => {
  buffered += chunk;
  if (buffered.length > 1024 * 1024) {
    appendViolation('Metro runtime evidence record exceeds the limit');
    buffered = '';
    return;
  }
  let newline;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    try {
      const payload = JSON.parse(line);
      if (
        payload.version !== 1 ||
        payload.sessionId !== sessionId ||
        payload.metroInstanceId !== metroInstanceId ||
        ![
          'input',
          'violation',
          'launch',
          'attestation',
          'semantics',
          'pending',
          'completion',
          'barrier',
          'native-addon-request',
          'native-addon-completion',
          'stability',
          'unattested-utility',
        ].includes(payload.kind) ||
        typeof payload.value !== 'string' ||
        (payload.kind === 'input' || payload.kind === 'stability'
          ? typeof payload.digest !== 'string'
          : payload.digest !== null)
      ) {
        throw new Error('invalid evidence');
      }
      if (payload.kind === 'native-addon-request') {
        handleNativeAddonRequest(payload);
        continue;
      }
      if (payload.kind === 'native-addon-completion') {
        handleNativeAddonCompletion(payload);
        continue;
      }
      if (payload.kind === 'barrier') {
        const connection = pendingHeads.get(payload.value);
        if (connection) {
          pendingHeads.delete(payload.value);
          respondWithHead(connection, payload.value);
        }
        continue;
      }
      if (payload.kind === 'violation') {
        appendViolation(payload.value);
        continue;
      }
      if (payload.kind === 'input') {
        let candidate;
        let digest;
        try {
          candidate = realpathSync(payload.value);
          digest = candidate.toLowerCase().endsWith('.node')
            ? digestNativeAddon(candidate)
            : createHash('sha256').update(readFileSync(candidate)).digest('hex');
        } catch {
          appendViolation('Metro runtime input could not be observed by the managed sandbox');
          continue;
        }
        const allowedRoots = [
          runtimeManifest.contentRoot,
          runtimeManifest.appRoot,
          ...runtimeManifest.runtimeInputs,
        ];
        const withinManifest = allowedRoots.some(
          (root) =>
            typeof root === 'string' && runtimeInputWithinRoot(candidate, root),
        );
        if (!withinManifest || digest !== payload.digest) {
          appendViolation('Metro runtime input is outside the managed sandbox manifest');
          continue;
        }
        appendEvidence({ ...payload, value: candidate });
        continue;
      }
      appendEvidence(payload);
    } catch {
      appendViolation('Metro runtime evidence record is invalid');
    }
  }
});
child.once('error', () =>
  failLauncher(
    'METRO_LAUNCHER_CHILD_SPAWN_FAILED',
    'child-spawn',
    'child-process-error',
  ),
);
evidence.once('end', finishEvidence);
evidence.once('close', finishEvidence);
evidence.once('error', () => {
  appendViolation('Metro runtime evidence stream failed');
  finishEvidence();
});
child.once('exit', (code, signal) => {
  childOutcome = { code: code ?? 1, signal };
  finishLauncher();
});
setInterval(() => {}, 1 << 30);
`;
function probeManagedMetroListener(port, platform = process.platform, execute2 = execFileSync4, executableDependencies = {}) {
  return probeMetroListener(port, platform, execute2, executableDependencies);
}
function managementProof(sessionId, authority, signerCapability) {
  return createHmac2("sha256", signerCapability).update(canonicalAuthorityJson({
    sessionId,
    port: authority.port,
    pid: authority.pid,
    birth: authority.birth,
    launcherPid: authority.launcherPid,
    launcherBirth: authority.launcherBirth,
    instanceId: authority.instanceId,
    runtimeEvidencePath: authority.runtimeEvidencePath,
    runtimeEvidenceSocket: authority.runtimeEvidenceSocket,
    runtimeEvidenceAuthority: authority.runtimeEvidenceAuthority,
    runtimeEvidenceProtocol: authority.runtimeEvidenceProtocol,
    servingRoot: authority.servingRoot,
    buildGeneration: authority.buildGeneration
  })).digest("hex");
}
function legacyManagementProof(sessionId, authority, signerCapability) {
  return createHmac2("sha256", signerCapability).update([
    sessionId,
    authority.port,
    authority.pid,
    authority.birth,
    authority.launcherPid,
    authority.launcherBirth,
    authority.instanceId,
    authority.runtimeEvidencePath,
    authority.runtimeEvidenceSocket
  ].join("\0")).digest("hex");
}
function managedSandboxManagementProofV1(sessionId, authority, signerCapability) {
  return createHmac2("sha256", signerCapability).update(canonicalAuthorityJson({
    sessionId,
    ...authority
  })).digest("hex");
}
function signalManagedMetroProcessTree(input, platform = process.platform, execute2 = execFileSync4, executableDependencies = {}) {
  if (platform === "win32") {
    const executable = resolveTrustedSystemExecutable("taskkill", platform, executableDependencies);
    if (!executable)
      throw new Error("METRO_CLEANUP_EXECUTABLE_UNAVAILABLE");
    const pid = input.launcherPresent ? input.launcherPid : input.listenerPid;
    execute2(executable, ["/PID", String(pid), "/T"], {
      stdio: "ignore",
      timeout: 2e3
    });
    return;
  }
  process.kill(-input.launcherPid, input.signal);
}
var signalProcessTree = signalManagedMetroProcessTree;
var MANAGED_METRO_STOP_TIMEOUT_MS = 5e3;
function removeManagedMetroEvidenceSocket(path) {
  if (process.platform === "win32")
    return;
  if (!/^\/tmp\/rn-dev-agent-[a-f0-9]{32}\.sock$/.test(path)) {
    throw new Error("METRO_EVIDENCE_SOCKET_INVALID");
  }
  rmSync(path, { force: true });
}
function removeManagedMetroEvidenceSocketSafely(path, dependencies) {
  if (process.platform === "win32" && !/^\\\\\.\\pipe\\rn-dev-agent-[a-f0-9]{32}$/.test(path) || process.platform !== "win32" && !/^\/tmp\/rn-dev-agent-[a-f0-9]{32}\.sock$/.test(path)) {
    return false;
  }
  try {
    (dependencies.removeEvidenceSocket ?? removeManagedMetroEvidenceSocket)(path);
    return true;
  } catch {
    return false;
  }
}
function exactProcessState(expected, probe) {
  if (probe.status === "unknown")
    return "unknown";
  if (probe.status === "absent")
    return "stopped";
  return probe.birth.token === expected.birth ? "present" : "stopped";
}
async function stopManagedMetroProcesses(input, dependencies) {
  const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
  const probeListener = dependencies.probeListener ?? probeManagedMetroListener;
  const signalTree = dependencies.signalTree ?? signalProcessTree;
  const wait = dependencies.wait ?? ((ms) => new Promise((resolve4) => setTimeout(resolve4, ms)));
  const inspect2 = () => {
    const launcher = exactProcessState(input.launcher, probeBirth(input.launcher.pid));
    const listener = input.listener ? exactProcessState(input.listener, probeBirth(input.listener.pid)) : "stopped";
    const port = probeListener(input.port);
    return { launcher, listener, port };
  };
  const initial = inspect2();
  if (initial.launcher === "unknown" || initial.listener === "unknown" || initial.port.status === "unknown") {
    return false;
  }
  if (initial.port.status === "listening" && (input.listener ? initial.port.pid !== input.listener.pid || initial.listener !== "present" : initial.launcher !== "present")) {
    return false;
  }
  if (initial.launcher === "stopped" && initial.listener === "stopped" && initial.port.status === "absent") {
    return true;
  }
  try {
    signalTree({
      launcherPid: input.launcher.pid,
      listenerPid: input.listener?.pid ?? input.launcher.pid,
      launcherPresent: initial.launcher === "present",
      signal: "SIGTERM"
    });
  } catch {
    return false;
  }
  const deadline = Date.now() + MANAGED_METRO_STOP_TIMEOUT_MS;
  while (true) {
    const current = inspect2();
    const uncertain = current.launcher === "unknown" || current.listener === "unknown" || current.port.status === "unknown";
    if (!uncertain) {
      if (current.launcher === "stopped" && current.listener === "stopped" && current.port.status === "absent") {
        return true;
      }
      if (current.port.status === "listening" && input.listener && (current.port.pid !== input.listener.pid || current.listener !== "present")) {
        return false;
      }
    }
    if (Date.now() >= deadline)
      return false;
    await wait(25);
  }
}
async function stopManagedMetro(binding, input, dependencies = {}) {
  if (binding?.mode !== "managed" || typeof binding.port !== "number" || typeof binding.pid !== "number" || typeof binding.birth !== "string" || typeof binding.launcherPid !== "number" || typeof binding.launcherBirth !== "string" || typeof binding.instanceId !== "string" || typeof binding.runtimeEvidencePath !== "string" || typeof binding.runtimeEvidenceSocket !== "string" || binding.runtimeEvidenceAuthority !== void 0 && binding.runtimeEvidenceAuthority !== "reported-v1" && binding.runtimeEvidenceAuthority !== "managed-sandbox-v1" || binding.runtimeEvidenceAuthority === "managed-sandbox-v1" && binding.runtimeEvidenceProtocol !== 2 || typeof binding.managementProof !== "string") {
    return false;
  }
  const legacyAuthority = {
    port: binding.port,
    pid: binding.pid,
    birth: binding.birth,
    launcherPid: binding.launcherPid,
    launcherBirth: binding.launcherBirth,
    instanceId: binding.instanceId,
    runtimeEvidencePath: binding.runtimeEvidencePath,
    runtimeEvidenceSocket: binding.runtimeEvidenceSocket
  };
  const observedBuffer = Buffer.from(binding.managementProof, "hex");
  const expectedProofs = binding.runtimeEvidenceAuthority === void 0 ? [legacyManagementProof(input.sessionId, legacyAuthority, input.signerCapability)] : binding.runtimeEvidenceAuthority === "reported-v1" ? [
    createHmac2("sha256", input.signerCapability).update(canonicalAuthorityJson({
      sessionId: input.sessionId,
      ...legacyAuthority,
      runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority
    })).digest("hex"),
    ...binding.runtimeEvidenceProtocol === 2 && typeof binding.servingRoot === "string" && Number.isSafeInteger(binding.buildGeneration) && binding.buildGeneration >= 0 ? [
      managementProof(input.sessionId, {
        ...legacyAuthority,
        runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
        runtimeEvidenceProtocol: 2,
        servingRoot: binding.servingRoot,
        buildGeneration: binding.buildGeneration
      }, input.signerCapability)
    ] : []
  ] : [
    managedSandboxManagementProofV1(input.sessionId, {
      ...legacyAuthority,
      runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
      runtimeEvidenceProtocol: 2
    }, input.signerCapability),
    ...typeof binding.servingRoot === "string" && Number.isSafeInteger(binding.buildGeneration) && binding.buildGeneration >= 0 ? [
      managementProof(input.sessionId, {
        ...legacyAuthority,
        runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
        runtimeEvidenceProtocol: 2,
        servingRoot: binding.servingRoot,
        buildGeneration: binding.buildGeneration
      }, input.signerCapability)
    ] : []
  ];
  if (!expectedProofs.some((expected) => {
    const expectedBuffer = Buffer.from(expected, "hex");
    return expectedBuffer.length === observedBuffer.length && timingSafeEqual3(expectedBuffer, observedBuffer);
  })) {
    return false;
  }
  const stopped = await stopManagedMetroProcesses({
    port: binding.port,
    launcher: { pid: binding.launcherPid, birth: binding.launcherBirth },
    listener: { pid: binding.pid, birth: binding.birth }
  }, dependencies);
  if (!stopped)
    return false;
  return removeManagedMetroEvidenceSocketSafely(binding.runtimeEvidenceSocket, dependencies);
}

// packages/rn-dev-agent-core/dist/session/android-metro-reverse.js
import { execFileSync as execFileSync5 } from "node:child_process";
function execute(dependencies, file, args) {
  if (dependencies.execute)
    return dependencies.execute(file, args);
  return execFileSync5(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 1e4
  });
}
function endpoint(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PHYSICAL_ANDROID_METRO_UNREACHABLE: authority-bound Metro port is invalid");
  }
  return `tcp:${port}`;
}
var AndroidDeviceDisconnectedError = class extends Error {
};
var DEVICE_DISCONNECTED = /device\s+('[^']*'\s+)?not found|no devices\/emulators found|device offline/i;
function describeExecutionFailure(error) {
  const parts = error && typeof error === "object" ? [
    error.message,
    error.stderr,
    error.stdout
  ] : [String(error)];
  return parts.map((part) => typeof part === "string" ? part : Buffer.isBuffer(part) ? part.toString("utf8") : "").filter((part) => part.length > 0).join("\n");
}
function adb(deviceId, args, dependencies) {
  try {
    return execute(dependencies, "adb", ["-s", deviceId, ...args]);
  } catch (error) {
    const details = describeExecutionFailure(error);
    const message = `PHYSICAL_ANDROID_METRO_UNREACHABLE: adb could not configure Metro reachability on exact device ${deviceId}: ${details || String(error)}`;
    throw DEVICE_DISCONNECTED.test(details) ? new AndroidDeviceDisconnectedError(message) : new Error(message);
  }
}
function listReverseForwards(deviceId, dependencies) {
  return adb(deviceId, ["reverse", "--list"], dependencies).split("\n").map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2).map((parts) => ({
    local: parts[parts.length - 2],
    remote: parts[parts.length - 1]
  })).filter((forward) => forward.local.startsWith("tcp:") && forward.remote.startsWith("tcp:"));
}
function assertBindingMatches(binding, deviceId, metroPort) {
  const exact = endpoint(metroPort);
  if (binding.platform !== "android" || binding.deviceId !== deviceId || binding.metroPort !== metroPort || binding.local !== exact || binding.remote !== exact) {
    throw new Error("PHYSICAL_ANDROID_METRO_UNREACHABLE: retained adb reverse authority does not match the exact device and Metro port");
  }
}
function removeAndroidMetroReverse(binding, dependencies = {}) {
  assertBindingMatches(binding, binding.deviceId, binding.metroPort);
  try {
    const matchingLocal = listReverseForwards(binding.deviceId, dependencies).filter((forward) => forward.local === binding.local);
    if (matchingLocal.length === 0)
      return;
    if (matchingLocal.length !== 1 || matchingLocal[0].remote !== binding.remote) {
      throw new Error(`PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN: ${binding.local} on exact device ${binding.deviceId} changed to a foreign forward; refusing to remove it. After confirming nothing else owns it, clear it manually with: adb -s ${binding.deviceId} reverse --remove ${binding.local}`);
    }
    adb(binding.deviceId, ["reverse", "--remove", binding.local], dependencies);
    if (listReverseForwards(binding.deviceId, dependencies).some((forward) => forward.local === binding.local)) {
      throw new Error(`PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN: session-owned ${binding.local} remains on exact device ${binding.deviceId}`);
    }
  } catch (error) {
    if (error instanceof AndroidDeviceDisconnectedError)
      return;
    throw error;
  }
}

// packages/rn-dev-agent-core/dist/session/package-integration.js
import { basename, isAbsolute as isAbsolute2, join as join6, relative as relative2, resolve as resolve3, sep } from "node:path";

// packages/rn-dev-agent-core/dist/session/bound-directory.js
import { spawn as spawn2 } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";
import { closeSync as closeSync4, constants as constants3, existsSync as existsSync5, fstatSync as fstatSync4, lstatSync as lstatSync6, mkdtempSync, openSync as openSync4, readFileSync as readFileSync6, realpathSync as realpathSync4, renameSync as renameSync3, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join5 } from "node:path";

// packages/rn-dev-agent-core/dist/session/state-root.js
init_secure_state_file();
import { randomBytes as randomBytes3, randomUUID } from "node:crypto";
import { chmodSync as chmodSync3, linkSync, lstatSync as lstatSync5, mkdirSync as mkdirSync4, readFileSync as readFileSync5, renameSync as renameSync2, rmSync as rmSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4, resolve as resolve2 } from "node:path";
function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}
function ensurePrivateDirectory(path) {
  try {
    mkdirSync4(path, { recursive: true, mode: 448 });
    const link = lstatSync5(path);
    const stat = statSync2(path);
    if (link.isSymbolicLink() || !link.isDirectory() || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      fail("AUTHORITY_STATE_ROOT_UNSAFE", "state directory is not private and user-owned");
    }
    chmodSync3(path, 448);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AUTHORITY_STATE_ROOT_UNSAFE")) {
      throw error;
    }
    fail("AUTHORITY_STATE_ROOT_UNSAFE", error instanceof Error ? error.message : "state directory could not be secured");
  }
}
function authorityStateLayout(stateDir2) {
  const resolvedStateDir = resolve2(stateDir2);
  const root = join4(resolvedStateDir, "v2");
  return {
    root,
    registry: join4(root, "registry.sqlite3"),
    sessions: join4(root, "sessions"),
    runners: join4(root, "runner"),
    observe: join4(root, "observe"),
    migrations: join4(root, "migrations")
  };
}
function createAuthorityStateLayout(stateDir2 = getStateDir()) {
  const layout = authorityStateLayout(stateDir2);
  ensurePrivateDirectory(resolve2(stateDir2));
  const root = layout.root;
  ensurePrivateDirectory(root);
  for (const path of [layout.sessions, layout.runners, layout.observe, layout.migrations]) {
    ensurePrivateDirectory(path);
  }
  return layout;
}
function openAuthorityStateLayout(stateDir2) {
  const layout = authorityStateLayout(stateDir2);
  try {
    const registry = lstatSync5(layout.registry);
    if (registry.isSymbolicLink() || !registry.isFile()) {
      fail("AUTHORITY_STATE_HOME_UNKNOWN", "requested state home has no regular authority registry");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AUTHORITY_STATE_HOME_UNKNOWN")) {
      throw error;
    }
    if (error.code === "ENOENT") {
      fail("AUTHORITY_STATE_HOME_UNKNOWN", "requested state home has no authority registry; refusing to initialize an empty registry");
    }
    fail("AUTHORITY_STATE_HOME_UNKNOWN", error instanceof Error ? error.message : "requested authority registry is unavailable");
  }
  ensurePrivateDirectory(resolve2(stateDir2));
  ensurePrivateDirectory(layout.root);
  for (const path of [layout.sessions, layout.runners, layout.observe, layout.migrations]) {
    ensurePrivateDirectory(path);
  }
  return layout;
}
function resolveAuthorityStateLayout(requestedStateHome) {
  return requestedStateHome ? openAuthorityStateLayout(requestedStateHome) : createAuthorityStateLayout();
}
function getBoundDirectoryJournalKey(layout = createAuthorityStateLayout()) {
  const path = join4(layout.root, "bound-directory.key");
  const temporary = join4(layout.root, `.bound-directory.${randomUUID()}.key`);
  try {
    try {
      writeFileSync2(temporary, randomBytes3(32), { flag: "wx", mode: 384, flush: true });
      try {
        linkSync(temporary, path);
      } catch (error) {
        if (error.code !== "EEXIST")
          throw error;
      }
    } finally {
      rmSync2(temporary, { force: true });
    }
    const link = lstatSync5(path);
    const stat = statSync2(path);
    const key = readFileSync5(path);
    if (link.isSymbolicLink() || !link.isFile() || key.length !== 32 || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      fail("AUTHORITY_STATE_ROOT_UNSAFE", "bound-directory journal key is invalid");
    }
    chmodSync3(path, 384);
    return key.toString("base64url");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AUTHORITY_STATE_ROOT_UNSAFE")) {
      throw error;
    }
    fail("AUTHORITY_STATE_ROOT_UNSAFE", error instanceof Error ? error.message : "bound-directory journal key is unavailable");
  }
}

// packages/rn-dev-agent-core/dist/session/bound-directory.js
var WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
var WORKER_READY_TIMEOUT_MS = 3e4;
var WORKER_OPERATION_TIMEOUT_MS = 3e4;
var ANCESTRY_MONITOR_TIMEOUT_MS = 2e4;
var ANCESTRY_MONITOR_POLL_MS = 50;
var BOUND_DIRECTORY_LIFECYCLE_MONITOR = String.raw`
const fs = require('node:fs');
const path = require('node:path');

const controlPath = process.argv[1];
const lifecycleCapability = process.argv[2];
const transactionLock = '.rn-bound-transaction.lock';
process.on('disconnect', () => {
  try {
    const lock = JSON.parse(fs.readFileSync(transactionLock, 'utf8'));
    if (lock.owner === lifecycleCapability) fs.unlinkSync(transactionLock);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try {
        fs.writeFileSync(path.join(controlPath, 'lock-retained'), '', {
          flag: 'wx',
          mode: 0o600,
        });
      } catch {}
    }
  }
  try {
    fs.writeFileSync(path.join(controlPath, 'stopped'), '', { flag: 'wx', mode: 0o600 });
  } catch {}
  process.exit(0);
});
fs.writeFileSync(path.join(controlPath, 'monitor-ready'), '', { flag: 'wx', mode: 0o600 });
`;
var BOUND_DIRECTORY_TERMINATION_WATCHDOG = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { workerData } = require('node:worker_threads');

function poll() {
  try {
    const request = JSON.parse(
      fs.readFileSync(path.join(workerData.controlPath, 'terminate'), 'utf8'),
    );
    if (
      request.lifecycleCapability === workerData.lifecycleCapability &&
      (request.signal === 'SIGTERM' || request.signal === 'SIGKILL')
    ) {
      process.kill(process.pid, request.signal);
      return;
    }
  } catch {}
  setTimeout(poll, 5);
}

poll();
`;
var BOUND_DIRECTORY_ANCESTRY_MONITOR = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { workerData } = require('node:worker_threads');

const state = new Int32Array(workerData.stateBuffer);
const watchers = [];
const records = [];

function invalidate() {
  Atomics.add(state, 1, 1);
  Atomics.notify(state, 1);
}

function progress() {
  Atomics.add(state, 6, 1);
}

function fail() {
  Atomics.store(state, 2, 1);
  invalidate();
  Atomics.store(state, 4, Atomics.load(state, 3));
  Atomics.notify(state, 4);
}

try {
  for (const ancestor of workerData.ancestors) {
    const parentPath = path.dirname(ancestor.publicPath);
    let parent = fs.statSync(parentPath, { bigint: true });
    const sameParent = (left, right) =>
      left.isDirectory() &&
      right.isDirectory() &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.ctimeNs === right.ctimeNs &&
      left.mtimeNs === right.mtimeNs;
    const inspectFence = (captureBaseline) => {
      let current;
      try {
        current = fs.statSync(parentPath, { bigint: true });
      } catch {
        invalidate();
        return;
      }
      if (!sameParent(current, parent)) {
        if (!captureBaseline) invalidate();
        parent = current;
      }
    };
    const parentWatcher = fs.watch(parentPath, () => {});
    const contentWatcher = fs.watch(ancestor.publicPath, () => {});
    parentWatcher.on('error', fail);
    contentWatcher.on('error', fail);
    watchers.push(parentWatcher, contentWatcher);
    records.push({ inspectFence });
  }
  let barrierPending = false;
  const barrier = setInterval(() => {
    progress();
    const requested = Atomics.load(state, 3);
    if (barrierPending || requested === Atomics.load(state, 4)) return;
    barrierPending = true;
    setImmediate(() => {
      progress();
      setImmediate(() => {
        progress();
        setImmediate(() => {
          const captureBaseline = Atomics.load(state, 5) === 1;
          for (const record of records) {
            progress();
            record.inspectFence(captureBaseline);
          }
          Atomics.store(state, 4, requested);
          barrierPending = false;
          Atomics.notify(state, 4);
        });
      });
    });
  }, 1);
  barrier.unref();
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
} catch {
  fail();
  Atomics.store(state, 0, -1);
  Atomics.notify(state, 0);
}
`;
var BOUND_DIRECTORY_ANCESTRY_SYNC = String.raw`
function createAncestrySynchronizer(state, timeoutMs, pollMs, AncestryError, clock) {
  const now = clock || Date.now;
  return function synchronize(captureBaseline) {
    Atomics.store(state, 5, captureBaseline ? 1 : 0);
    const requested = Atomics.add(state, 3, 1) + 1;
    Atomics.notify(state, 3);
    let progress = Atomics.load(state, 6);
    let deadline = now() + timeoutMs;
    while (Atomics.load(state, 4) !== requested) {
      if (Atomics.load(state, 2) !== 0) {
        throw new AncestryError('bound-directory ancestry monitor failed');
      }
      Atomics.wait(state, 4, Atomics.load(state, 4), pollMs);
      const observed = Atomics.load(state, 6);
      if (observed !== progress) {
        progress = observed;
        deadline = now() + timeoutMs;
      } else if (now() >= deadline) {
        throw new AncestryError('bound-directory ancestry monitor synchronization failed');
      }
    }
  };
}
`;
var BOUND_DIRECTORY_WORKER = String.raw`
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

class ConflictError extends Error {}
class AncestryError extends Error {}

const controlPath = process.argv[1];
const binding = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
const childWorkers = new Map();
const transactionLock = '.rn-bound-transaction.lock';
process.on('disconnect', () => process.exit(0));
process.channel?.unref();

const lifecycleMonitor = childProcess.spawn(
  process.execPath,
  [
    '-e',
    ${JSON.stringify(BOUND_DIRECTORY_LIFECYCLE_MONITOR)},
    controlPath,
    binding.lifecycleCapability,
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
);
lifecycleMonitor.on('error', () => {});
lifecycleMonitor.on('exit', () => process.exit(1));
lifecycleMonitor.channel?.unref();
lifecycleMonitor.unref();
const terminationWatchdog = new Worker(${JSON.stringify(BOUND_DIRECTORY_TERMINATION_WATCHDOG)}, {
  eval: true,
  workerData: {
    controlPath,
    lifecycleCapability: binding.lifecycleCapability,
  },
});
terminationWatchdog.on('error', () => process.exit(1));
terminationWatchdog.unref();
const agentAncestorIndex = binding.ancestors.findIndex(
  (ancestor) => path.basename(ancestor.publicPath) === '.rn-agent',
);
const monitoredAncestors =
  agentAncestorIndex === -1
    ? []
    : binding.ancestors.slice(agentAncestorIndex);
const ancestryState = new Int32Array(new SharedArrayBuffer(7 * 4));
if (monitoredAncestors.length > 0) {
  const ancestryMonitor = new Worker(${JSON.stringify(BOUND_DIRECTORY_ANCESTRY_MONITOR)}, {
    eval: true,
    workerData: {
      ancestors: monitoredAncestors,
      stateBuffer: ancestryState.buffer,
    },
  });
  ancestryMonitor.on('error', () => {
    Atomics.store(ancestryState, 2, 1);
    Atomics.add(ancestryState, 1, 1);
  });
  ancestryMonitor.unref();
  if (
    Atomics.wait(ancestryState, 0, 0, ${ANCESTRY_MONITOR_TIMEOUT_MS}) === 'timed-out' ||
    Atomics.load(ancestryState, 0) !== 1
  ) {
    process.exit(1);
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

${BOUND_DIRECTORY_ANCESTRY_SYNC}
const ancestrySynchronizer = createAncestrySynchronizer(
  ancestryState,
  ${ANCESTRY_MONITOR_TIMEOUT_MS},
  ${ANCESTRY_MONITOR_POLL_MS},
  AncestryError,
);

function synchronizeAncestryMonitor(captureBaseline = false) {
  if (monitoredAncestors.length === 0) return;
  ancestrySynchronizer(captureBaseline);
}

function mutateBoundDirectory(mutation) {
  try {
    return mutation();
  } finally {
    synchronizeAncestryMonitor();
  }
}

function validateName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    path.basename(name) !== name
  ) {
    throw new Error('invalid bound-directory filename');
  }
}

function assertBoundDirectory(expectedGuard, settle = false) {
  if (settle) synchronizeAncestryMonitor();
  if (Atomics.load(ancestryState, 2) !== 0) {
    throw new AncestryError('bound-directory ancestry monitor failed');
  }
  const guardBefore = Atomics.load(ancestryState, 1);
  const current = fs.statSync('.', { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev.toString() !== binding.dev ||
    current.ino.toString() !== binding.ino ||
    fs.realpathSync('.') !== binding.realPath
  ) {
    throw new AncestryError('bound-directory identity changed');
  }
  for (const ancestor of binding.ancestors) {
    const publicPath = fs.lstatSync(ancestor.publicPath, { bigint: true });
    if (
      !publicPath.isDirectory() ||
      publicPath.isSymbolicLink() ||
      publicPath.dev.toString() !== ancestor.dev ||
      publicPath.ino.toString() !== ancestor.ino ||
      fs.realpathSync(ancestor.publicPath) !== ancestor.realPath
    ) {
      throw new AncestryError('bound-directory ancestor changed');
    }
  }
  const guardAfter = Atomics.load(ancestryState, 1);
  if (guardBefore !== guardAfter || (expectedGuard !== undefined && guardAfter !== expectedGuard)) {
    throw new AncestryError('bound-directory ancestor changed during operation');
  }
  return guardAfter;
}

function readRegularFile(name) {
  validateName(name);
  let before;
  try {
    before = fs.lstatSync(name, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('bound-directory input is not a regular file');
  }
  const descriptor = fs.openSync(
    name,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(name, { bigint: true });
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new Error('bound-directory input changed while opening');
    }
    return {
      contents: fs.readFileSync(descriptor).toString('base64'),
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
      mode: Number(opened.mode & 0o777n),
      name,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameContentsAndMode(snapshot, encoded, mode) {
  return (
    snapshot !== null &&
    encoded !== null &&
    (mode === undefined ||
      (process.platform === 'win32'
        ? ((snapshot.mode & 0o222) !== 0) === ((mode & 0o222) !== 0)
        : snapshot.mode === mode)) &&
    Buffer.from(encoded, 'base64').equals(Buffer.from(snapshot.contents, 'base64'))
  );
}

function sameIdentity(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function removeOptional(name) {
  try {
    mutateBoundDirectory(() => fs.unlinkSync(name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function signedPayload(value) {
  const { signature, ...payload } = value;
  return JSON.stringify(payload);
}

function sign(value) {
  return crypto
    .createHmac('sha256', Buffer.from(binding.journalKey, 'base64url'))
    .update(signedPayload(value))
    .digest('hex');
}

function authenticate(value) {
  if (!value || typeof value.signature !== 'string') return false;
  const expected = Buffer.from(sign(value), 'hex');
  const actual = Buffer.from(value.signature, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function readTransactionLock() {
  try {
    return JSON.parse(fs.readFileSync(transactionLock, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateTransactionLock(lock) {
  return (
    lock !== null &&
    lock.version === 1 &&
    typeof lock.controlPath === 'string' &&
    typeof lock.owner === 'string' &&
    authenticate(lock)
  );
}

function publishTransactionLock(lock) {
  const temporary = transactionLock + '.' + binding.lifecycleCapability + '.initial';
  removeOptional(temporary);
  mutateBoundDirectory(() =>
    fs.writeFileSync(temporary, JSON.stringify(lock), {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    }),
  );
  try {
    mutateBoundDirectory(() =>
      fs.linkSync(temporary, transactionLock),
    );
  } finally {
    removeOptional(temporary);
  }
}

function acquireTransactionLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = {
      controlPath,
      owner: binding.lifecycleCapability,
      version: 1,
    };
    lock.signature = sign(lock);
    try {
      publishTransactionLock(lock);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try {
        existing = readTransactionLock();
      } catch {
        throw new Error('bound-directory transaction lock is invalid');
      }
      if (!validateTransactionLock(existing)) {
        throw new Error('bound-directory transaction lock is invalid');
      }
      if (!fs.existsSync(path.join(existing.controlPath, 'stopped'))) {
        throw new Error('bound-directory transaction is active');
      }
      mutateBoundDirectory(() => fs.unlinkSync(transactionLock));
      fs.rmSync(existing.controlPath, { force: true, recursive: true });
    }
  }
  throw new Error('bound-directory transaction lock is unavailable');
}

function ensureTransactionLock() {
  const lock = readTransactionLock();
  if (
    validateTransactionLock(lock) &&
    lock.owner === binding.lifecycleCapability
  ) {
    return;
  }
  acquireTransactionLock();
}

function releaseTransactionLock() {
  const lock = readTransactionLock();
  if (lock === null) return;
  if (
    !validateTransactionLock(lock) ||
    lock.owner !== binding.lifecycleCapability ||
    typeof lock.owner !== 'string'
  ) {
    throw new Error('bound-directory transaction lock is invalid');
  }
  mutateBoundDirectory(() => fs.unlinkSync(transactionLock));
}

function writeJournal(name, value, exclusive) {
  validateName(name);
  value.signature = sign(value);
  const contents = JSON.stringify(value);
  if (exclusive) {
    const temporary = name + '.initial';
    removeOptional(temporary);
    mutateBoundDirectory(() =>
      fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600, flush: true }),
    );
    try {
      mutateBoundDirectory(() => fs.linkSync(temporary, name));
    } finally {
      removeOptional(temporary);
    }
    return;
  }
  const temporary = name + '.next';
  removeOptional(temporary);
  mutateBoundDirectory(() =>
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600, flush: true }),
  );
  mutateBoundDirectory(() => fs.renameSync(temporary, name));
}

function readJournal(name) {
  validateName(name);
  try {
    const snapshot = readRegularFile(name);
    return snapshot === null
      ? null
      : JSON.parse(Buffer.from(snapshot.contents, 'base64').toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateWrite(write) {
  validateName(write.name);
  validateName(write.temporary);
  validateName(write.captured);
}

function prepareReplacement(write) {
  if (write.replacement === null) return;
  mutateBoundDirectory(() =>
    fs.writeFileSync(write.temporary, Buffer.from(write.replacement, 'base64'), {
      flag: 'wx',
      mode: write.mode,
    }),
  );
  mutateBoundDirectory(() => fs.chmodSync(write.temporary, write.mode));
}

function applyWrite(write) {
  validateWrite(write);
  prepareReplacement(write);
  if (write.expected === null) {
    if (readRegularFile(write.name) !== null) {
      throw new ConflictError('bound-directory input changed before commit');
    }
  } else {
    try {
      mutateBoundDirectory(() =>
        fs.renameSync(write.name, write.captured),
      );
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ConflictError('bound-directory input changed before commit');
      }
      throw error;
    }
    if (write.afterCaptureDelayMs > 0) wait(write.afterCaptureDelayMs);
    const observed = readRegularFile(write.captured);
    if (!sameContentsAndMode(observed, write.expected, write.expectedMode)) {
      throw new ConflictError('bound-directory input changed before commit');
    }
  }
  if (write.replacement !== null) {
    try {
      mutateBoundDirectory(() =>
        fs.linkSync(write.temporary, write.name),
      );
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new ConflictError('bound-directory input changed before commit');
      }
      throw error;
    }
  }
  if (write.afterReplacementDelayMs > 0) wait(write.afterReplacementDelayMs);
}

function cleanupArtifacts(writes) {
  for (const write of writes) {
    removeOptional(write.temporary);
    removeOptional(write.captured);
  }
}

function cleanupJournal(name) {
  removeOptional(name + '.next');
  removeOptional(name);
}

function rollbackOwnedWrites(writes, recoveryDelayAfterUnlinkMs) {
  for (const write of [...writes].reverse()) {
    validateWrite(write);
    const captured = readRegularFile(write.captured);
    const temporary = readRegularFile(write.temporary);
    const target = readRegularFile(write.name);
    if (captured !== null) {
      if (target === null) {
        mutateBoundDirectory(() =>
          fs.linkSync(write.captured, write.name),
        );
      } else if (!sameIdentity(target, captured)) {
        if (!sameIdentity(target, temporary)) {
          throw new ConflictError('bound-directory input changed during recovery');
        }
        mutateBoundDirectory(() => fs.unlinkSync(write.name));
        if (recoveryDelayAfterUnlinkMs > 0) wait(recoveryDelayAfterUnlinkMs);
        mutateBoundDirectory(() =>
          fs.linkSync(write.captured, write.name),
        );
      }
      removeOptional(write.captured);
      removeOptional(write.temporary);
      continue;
    }
    if (write.expected === null && sameIdentity(target, temporary)) {
      mutateBoundDirectory(() => fs.unlinkSync(write.name));
    }
    removeOptional(write.temporary);
  }
}

function recoverTransaction(
  journalName,
  requestedWrites,
  recoveryDelayAfterUnlinkMs = 0,
  releaseLock = true,
  ancestryGuard,
) {
  const journal = readJournal(journalName);
  if (journal === null) {
    throw new Error('bound-directory transaction outcome is unknown');
  }
  if (
    journal.version !== 1 ||
    journal.name !== journalName ||
    !authenticate(journal) ||
    JSON.stringify(journal.writes) !== JSON.stringify(requestedWrites)
  ) {
    throw new Error('bound-directory transaction journal is invalid');
  }
  if (journal.state === 'committed') {
    cleanupArtifacts(journal.writes);
    assertBoundDirectory(ancestryGuard, true);
    cleanupJournal(journalName);
    assertBoundDirectory(ancestryGuard, true);
    if (releaseLock) {
      releaseTransactionLock();
      assertBoundDirectory(ancestryGuard, true);
    }
    return { committed: true };
  }
  if (journal.state !== 'applying') {
    throw new Error('bound-directory transaction state is invalid');
  }
  rollbackOwnedWrites(journal.writes, recoveryDelayAfterUnlinkMs);
  assertBoundDirectory(ancestryGuard, true);
  cleanupJournal(journalName);
  assertBoundDirectory(ancestryGuard, true);
  if (releaseLock) {
    releaseTransactionLock();
    assertBoundDirectory(ancestryGuard, true);
  }
  return { committed: false };
}

function transactionJournalNames() {
  return fs
    .readdirSync('.')
    .filter((name) => /^\.rn-bound-([0-9a-f-]{36})\.journal$/.test(name));
}

function inspectTransactions() {
  const invalidJournals = [];
  const transactions = transactionJournalNames()
      .map((journalName) => {
      let journal;
      try {
        journal = readJournal(journalName);
      } catch {
        invalidJournals.push(journalName);
        return null;
      }
      if (
        journal === null ||
        journal.version !== 1 ||
        journal.name !== journalName ||
        typeof journal.owner !== 'string' ||
        !authenticate(journal) ||
        (journal.state !== 'applying' && journal.state !== 'committed') ||
        !Array.isArray(journal.writes)
      ) {
        invalidJournals.push(journalName);
        return null;
      }
      const transactionId = journalName.slice('.rn-bound-'.length, -'.journal'.length);
      if (journal.writes.length > 100) {
        throw new Error('bound-directory transaction journal is too large');
      }
      for (const [index, write] of journal.writes.entries()) {
        validateName(write.name);
        validateName(write.temporary);
        validateName(write.captured);
        if (
          write.temporary !== '.rn-bound-' + transactionId + '-' + index + '.tmp' ||
          write.captured !== '.rn-bound-' + transactionId + '-' + index + '.captured' ||
          (write.expected !== null && typeof write.expected !== 'string') ||
          (write.replacement !== null && typeof write.replacement !== 'string') ||
          !Number.isSafeInteger(write.mode) ||
          (write.expectedMode !== undefined && !Number.isSafeInteger(write.expectedMode))
        ) {
          throw new Error('bound-directory transaction journal write is invalid');
        }
      }
      return {
        journal: journalName,
        state: journal.state,
        transactionId,
        writes: journal.writes,
      };
      })
      .filter((transaction) => transaction !== null);
  if (transactions.length > 1) {
    throw new Error('bound-directory has multiple pending transactions');
  }
  return { invalidJournals, transactions };
}

function quarantineInvalidTransactions(journalNames) {
  return journalNames.map((journal) => {
    const quarantine = journal + '.invalid-' + crypto.randomUUID();
    mutateBoundDirectory(() =>
      fs.renameSync(journal, quarantine),
    );
    return { journal, quarantine };
  });
}

function restoreQuarantinedTransactions(quarantined) {
  for (const entry of [...quarantined].reverse()) {
    mutateBoundDirectory(() =>
      fs.renameSync(entry.quarantine, entry.journal),
    );
  }
}

function discoverTransactions(ancestryGuard) {
  if (transactionJournalNames().length === 0) {
    const lock = readTransactionLock();
    if (
      lock === null ||
      !validateTransactionLock(lock) ||
      lock.owner !== binding.lifecycleCapability
    ) {
      return [];
    }
    assertBoundDirectory(ancestryGuard, true);
    releaseTransactionLock();
    assertBoundDirectory(ancestryGuard, true);
    return [];
  }
  ensureTransactionLock();
  let quarantined = [];
  try {
    const inspection = inspectTransactions();
    assertBoundDirectory(ancestryGuard, true);
    quarantined = quarantineInvalidTransactions(inspection.invalidJournals);
    assertBoundDirectory(ancestryGuard, true);
    if (inspection.transactions.length === 0) {
      releaseTransactionLock();
      assertBoundDirectory(ancestryGuard, true);
    }
    return inspection.transactions;
  } catch (error) {
    if (error instanceof AncestryError) {
      try {
        const rollbackGuard = assertBoundDirectory();
        restoreQuarantinedTransactions(quarantined);
        assertBoundDirectory(rollbackGuard, true);
        releaseTransactionLock();
        assertBoundDirectory(rollbackGuard, true);
      } catch {}
    } else {
      try {
        releaseTransactionLock();
      } catch {}
    }
    throw error;
  }
}

function applyBatch(request, ancestryGuard) {
  acquireTransactionLock();
  const inspection = inspectTransactions();
  if (inspection.invalidJournals.length > 0) {
    releaseTransactionLock();
    throw new Error('bound-directory transaction journal is invalid');
  }
  const pending = inspection.transactions;
  if (pending.length === 1) {
    recoverTransaction(pending[0].journal, pending[0].writes, 0, false, ancestryGuard);
  } else {
    assertBoundDirectory(ancestryGuard, true);
  }
  const journal = {
    version: 1,
    name: request.journal,
    owner: binding.lifecycleCapability,
    state: 'applying',
    writes: request.writes,
  };
  let committed = false;
  try {
    writeJournal(request.journal, journal, true);
    for (const write of request.writes) applyWrite(write);
    assertBoundDirectory(ancestryGuard, true);
    journal.state = 'committed';
    writeJournal(request.journal, journal, false);
    committed = true;
    assertBoundDirectory(ancestryGuard, true);
    if (request.failCleanupAfterCommit) {
      throw new Error('bound-directory cleanup unavailable');
    }
    cleanupArtifacts(request.writes);
    assertBoundDirectory(ancestryGuard, true);
    cleanupJournal(request.journal);
    assertBoundDirectory(ancestryGuard, true);
    releaseTransactionLock();
    if (request.afterLockReleaseDelayMs) wait(request.afterLockReleaseDelayMs);
    assertBoundDirectory(ancestryGuard, true);
    return { committed: true };
  } catch (error) {
    if (committed) {
      return {
        cleanupPending: true,
        committed: true,
        ...(error instanceof AncestryError ? { cleanupError: error.message } : {}),
      };
    }
    try {
      recoverTransaction(
        request.journal,
        request.writes,
        0,
        true,
        assertBoundDirectory(),
      );
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError]);
    }
    throw error;
  }
}

function spawnChildWorker(request, directory) {
  const existing = childWorkers.get(request.childId);
  if (existing) {
    throw new Error('bound-directory child worker already exists');
  }
  const childBinding = Buffer.from(
    JSON.stringify({
      dev: directory.dev.toString(),
      ino: directory.ino.toString(),
      ancestors: [
        ...binding.ancestors,
        {
          dev: directory.dev.toString(),
          ino: directory.ino.toString(),
          publicPath: request.publicPath,
          realPath: directory.realPath,
        },
      ],
      lifecycleCapability: request.lifecycleCapability,
      controlPath: request.controlPath,
      journalKey: binding.journalKey,
      publicPath: request.publicPath,
      realPath: directory.realPath,
    }),
  ).toString('base64url');
  const child = childProcess.spawn(
    process.execPath,
    [...process.execArgv, request.controlPath, childBinding],
    {
      cwd: request.name,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  child.on('error', () => {});
  child.on('exit', () => {
    if (childWorkers.get(request.childId) === child) {
      childWorkers.delete(request.childId);
    }
  });
  child.channel?.unref();
  child.unref();
  childWorkers.set(request.childId, child);
}

function execute(request) {
  synchronizeAncestryMonitor(true);
  const ancestryGuard = assertBoundDirectory();
  if (request.operation === 'directory') {
    validateName(request.childId);
    validateName(request.name);
    let created = false;
    if (request.create) {
      try {
        mutateBoundDirectory(() =>
          fs.mkdirSync(request.name, { mode: request.mode }),
        );
        created = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    let before;
    try {
      before = fs.lstatSync(request.name, { bigint: true });
    } catch (error) {
      if (request.optional && error.code === 'ENOENT') {
        if (request.optionalMissingDelayMs) wait(request.optionalMissingDelayMs);
        assertBoundDirectory(ancestryGuard, true);
        return { directoryMissing: true };
      }
      throw error;
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('bound-directory child is not a directory');
    }
    const realPath = fs.realpathSync(request.name);
    if (realPath !== path.join(binding.realPath, request.name)) {
      throw new Error('bound-directory child escaped retained parent');
    }
    const after = fs.lstatSync(request.name, { bigint: true });
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('bound-directory child changed while binding');
    }
    const directory = { dev: after.dev, ino: after.ino, realPath };
    try {
      assertBoundDirectory(ancestryGuard, true);
    } catch (error) {
      if (created) {
        mutateBoundDirectory(() => fs.rmdirSync(request.name));
      }
      throw error;
    }
    spawnChildWorker(request, directory);
    return {
      directoryIdentity: {
        dev: directory.dev.toString(),
        ino: directory.ino.toString(),
        realPath,
      },
    };
  }
  if (request.operation === 'child-identity') {
    const child = childWorkers.get(request.childId);
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('bound-directory child worker is unavailable');
    }
    assertBoundDirectory(ancestryGuard, true);
    return {};
  }
  if (request.operation === 'read') {
    const snapshots = request.names.map((name) => {
      const snapshot = readRegularFile(name);
      return snapshot ?? { contents: null, mode: 0o600, name };
    });
    assertBoundDirectory(ancestryGuard, true);
    return { snapshots };
  }
  if (request.operation === 'cas') {
    return applyBatch(request, ancestryGuard);
  }
  if (request.operation === 'recover') {
    ensureTransactionLock();
    if (request.cleanupRecoveryDelayMs) wait(request.cleanupRecoveryDelayMs);
    if (request.failCleanupRecovery) {
      throw new Error('bound-directory cleanup recovery unavailable');
    }
    return recoverTransaction(
      request.journal,
      request.writes,
      request.recoveryDelayAfterUnlinkMs,
      true,
      ancestryGuard,
    );
  }
  if (request.operation === 'discover') {
    if (request.discoveryQuarantineDelayMs) wait(request.discoveryQuarantineDelayMs);
    return { transactions: discoverTransactions(ancestryGuard) };
  }
  if (request.operation === 'identity') {
    assertBoundDirectory(ancestryGuard, true);
    return {};
  }
  throw new Error('invalid bound-directory operation');
}

function respond(requestPath, responsePath) {
  let response;
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    response = { ok: true, ...execute(request) };
    synchronizeAncestryMonitor();
  } catch (error) {
    const conflict =
      error instanceof ConflictError ||
      (error instanceof AggregateError &&
        error.errors.some((entry) => entry instanceof ConflictError));
    response = {
      ok: false,
      code: conflict ? 'CONFLICT' : 'UNSAFE',
      message:
        error instanceof AggregateError
          ? error.errors
              .map((entry) => (entry instanceof Error ? entry.message : String(entry)))
              .join('; ')
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
  const temporary = responsePath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(response), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, responsePath);
  if (request?.operation === 'cas' && response.ok && !response.cleanupPending) {
    cleanupJournal(request.journal);
  }
  removeOptional(requestPath);
}

function publishReady(record) {
  const readyPath = path.join(controlPath, 'ready');
  const temporaryPath = path.join(controlPath, 'ready.' + process.pid + '.tmp');
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(record), {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, readyPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

async function run() {
  assertBoundDirectory();
  while (!fs.existsSync(path.join(controlPath, 'monitor-ready'))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  publishReady({
    lifecycleCapability: binding.lifecycleCapability,
    ok: true,
    pid: process.pid,
  });
  while (!fs.existsSync(path.join(controlPath, 'stop'))) {
    for (const entry of fs.readdirSync(controlPath)) {
      if (!entry.endsWith('.request')) continue;
      const requestPath = path.join(controlPath, entry);
      const responsePath = path.join(controlPath, entry.replace(/\.request$/, '.response'));
      respond(requestPath, responsePath);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

run().catch((error) => {
  try {
    publishReady({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  } catch {}
  process.exitCode = 1;
});
`;
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync5(path))
      return true;
    Atomics.wait(WAIT_BUFFER, 0, 0, 5);
  }
  return existsSync5(path);
}
function stopWorker(worker, signal = "SIGTERM") {
  const stoppedPath = join5(worker.controlPath, "stopped");
  if (signal === "SIGTERM") {
    try {
      writeFileSync3(join5(worker.controlPath, "stop"), "", { flag: "wx", mode: 384 });
    } catch {
    }
    if (waitForFile(stoppedPath, 1e3)) {
      if (!existsSync5(join5(worker.controlPath, "lock-retained"))) {
        rmSync3(worker.controlPath, { force: true, recursive: true });
      }
      return;
    }
  }
  try {
    writeFileSync3(join5(worker.controlPath, "terminate"), JSON.stringify({
      lifecycleCapability: worker.lifecycleCapability,
      signal: "SIGKILL"
    }), { flag: "wx", mode: 384 });
  } catch {
  }
  if (!waitForFile(stoppedPath, 1e4)) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker exit was not confirmed");
  }
  if (!existsSync5(join5(worker.controlPath, "lock-retained"))) {
    rmSync3(worker.controlPath, { force: true, recursive: true });
  }
}
function bindWorker(controlPath, child, owner, childId, lifecycleCapability = "") {
  const rejectWorker = (message) => {
    if (typeof lifecycleCapability === "string") {
      try {
        stopWorker({
          child,
          childId,
          controlPath,
          lifecycleCapability,
          owner,
          pid: child?.pid ?? 0,
          sequence: 0
        }, "SIGKILL");
      } catch {
      }
    }
    throw new Error(message);
  };
  const readyPath = join5(controlPath, "ready");
  if (!waitForFile(readyPath, WORKER_READY_TIMEOUT_MS)) {
    rejectWorker("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable");
  }
  let ready = {};
  try {
    ready = JSON.parse(readFileSync6(readyPath, "utf8"));
  } catch {
    rejectWorker("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable");
  }
  const readyPid = ready.pid;
  if (ready.ok !== true || lifecycleCapability.length === 0 || ready.lifecycleCapability !== lifecycleCapability || typeof readyPid !== "number" || !Number.isSafeInteger(readyPid) || readyPid <= 0 || child?.pid !== void 0 && child.pid !== readyPid) {
    rejectWorker("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker rejected path");
  }
  return {
    child,
    childId,
    controlPath,
    lifecycleCapability,
    owner,
    pid: readyPid,
    sequence: 0
  };
}
function startWorker(path, identity, realPath) {
  const controlPath = mkdtempSync(join5(tmpdir(), "rn-bound-directory-"));
  const lifecycleCapability = randomUUID2();
  const binding = Buffer.from(JSON.stringify({
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    ancestors: [
      {
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
        publicPath: path,
        realPath
      }
    ],
    lifecycleCapability,
    controlPath,
    journalKey: getBoundDirectoryJournalKey(),
    publicPath: path,
    realPath
  })).toString("base64url");
  const child = spawn2(process.execPath, ["-e", BOUND_DIRECTORY_WORKER, controlPath, binding], {
    cwd: path,
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  child.on("error", () => {
  });
  child.channel?.unref();
  child.unref();
  return bindWorker(controlPath, child, void 0, void 0, lifecycleCapability);
}
function startSubdirectoryWorker(parent, name, expectedIdentity, expectedRealPath) {
  const controlPath = mkdtempSync(join5(tmpdir(), "rn-bound-directory-"));
  const childId = randomUUID2();
  const lifecycleCapability = randomUUID2();
  let worker;
  let childStarted = false;
  try {
    const result = runBoundOperation(parent, {
      operation: "directory",
      childId,
      controlPath,
      lifecycleCapability,
      name,
      publicPath: join5(parent.path, name),
      create: false,
      mode: 448
    });
    childStarted = true;
    worker = bindWorker(controlPath, void 0, parent, childId, lifecycleCapability);
    if (!result.directoryIdentity || BigInt(result.directoryIdentity.dev) !== expectedIdentity.dev || BigInt(result.directoryIdentity.ino) !== expectedIdentity.ino || result.directoryIdentity.realPath !== expectedRealPath) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory child identity changed");
    }
    return worker;
  } catch (error) {
    try {
      if (worker)
        stopWorker(worker, "SIGKILL");
      else if (childStarted || error instanceof Error && error.message === "SESSION_INTEGRATION_WORKER_TIMEOUT") {
        stopWorker({
          childId,
          controlPath,
          lifecycleCapability,
          owner: parent,
          pid: 0,
          sequence: 0
        }, "SIGKILL");
      } else {
        rmSync3(controlPath, { force: true, recursive: true });
      }
    } catch (cleanupError) {
      throw new AggregateError([
        error instanceof Error ? error : new Error(String(error)),
        cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
      ], "bound-directory child cleanup failed");
    }
    throw error;
  }
}
function restartWorker(directory) {
  const descendants = [...directory.children];
  stopDescendantWorkers(directory);
  stopWorker(directory.worker, "SIGKILL");
  if (directory.parent && directory.name) {
    directory.worker = startSubdirectoryWorker(directory.parent, directory.name, directory.identity, directory.realPath);
  } else {
    directory.worker = startWorker(directory.path, directory.identity, directory.realPath);
  }
  for (const descendant of descendants) {
    descendant.worker = startSubdirectoryWorker(directory, descendant.name, descendant.identity, descendant.realPath);
    rebindDescendants(descendant);
  }
}
function stopDescendantWorkers(directory) {
  for (const descendant of directory.children) {
    stopDescendantWorkers(descendant);
    stopWorker(descendant.worker, "SIGKILL");
  }
}
function rebindDescendants(directory) {
  for (const descendant of directory.children) {
    descendant.worker = startSubdirectoryWorker(directory, descendant.name, descendant.identity, descendant.realPath);
    rebindDescendants(descendant);
  }
}
function sendOperation(directory, request, timeoutMs) {
  const sequence = ++directory.worker.sequence;
  const prefix = String(sequence).padStart(8, "0");
  const pendingPath = join5(directory.worker.controlPath, `${prefix}.pending`);
  const requestPath = join5(directory.worker.controlPath, `${prefix}.request`);
  const responsePath = join5(directory.worker.controlPath, `${prefix}.response`);
  writeFileSync3(pendingPath, JSON.stringify(request), { flag: "wx", mode: 384 });
  renameSync3(pendingPath, requestPath);
  if (!waitForFile(responsePath, timeoutMs)) {
    throw new Error("SESSION_INTEGRATION_WORKER_TIMEOUT");
  }
  let result;
  try {
    result = JSON.parse(readFileSync6(responsePath, "utf8"));
  } catch {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation returned invalid output");
  } finally {
    rmSync3(responsePath, { force: true });
  }
  return result;
}
function throwOperationFailure(result) {
  const prefix = result.code === "CONFLICT" ? "SESSION_INTEGRATION_CONFLICT" : "SESSION_INTEGRATION_PATH_UNSAFE";
  throw new Error(`${prefix}: ${result.message ?? "bound-directory operation failed"}`);
}
function runBoundOperation(directory, request, dependencies = {}) {
  if (directory.closed) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound directory is closed");
  }
  if (directory.descriptor !== void 0) {
    const retained = fstatSync4(directory.descriptor, { bigint: true });
    if (!retained.isDirectory() || retained.dev !== directory.identity.dev || retained.ino !== directory.identity.ino) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: retained directory identity changed");
    }
  }
  let current;
  let currentRealPath;
  try {
    current = lstatSync6(directory.path, { bigint: true });
    currentRealPath = realpathSync4(directory.path);
  } catch {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound directory path is unavailable");
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, directory.identity) || currentRealPath !== directory.realPath) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound directory path changed");
  }
  try {
    const result = sendOperation(directory, request, dependencies.timeoutMs ?? WORKER_OPERATION_TIMEOUT_MS);
    if (!result.ok)
      throwOperationFailure(result);
    if (request.operation === "cas" && result.cleanupPending) {
      if (result.cleanupError)
        return result;
      try {
        dependencies.beforeCleanupRecovery?.();
        const cleanup = sendOperation(directory, {
          operation: "recover",
          failCleanupRecovery: dependencies.failCleanupRecovery ?? false,
          cleanupRecoveryDelayMs: dependencies.cleanupRecoveryDelayMs ?? 0,
          journal: request.journal,
          writes: request.writes
        }, dependencies.recoveryTimeoutMs ?? WORKER_OPERATION_TIMEOUT_MS);
        if (!cleanup.ok)
          throwOperationFailure(cleanup);
        if (!cleanup.committed) {
          throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: committed bound-directory cleanup was not preserved");
        }
        return { ...result, cleanupPending: false };
      } catch (cleanupError) {
        let unresolvedCleanup = cleanupError;
        if (cleanupError instanceof Error && cleanupError.message === "SESSION_INTEGRATION_WORKER_TIMEOUT") {
          try {
            restartWorker(directory);
            const cleanup = sendOperation(directory, {
              operation: "recover",
              failCleanupRecovery: dependencies.failCleanupRecovery ?? false,
              journal: request.journal,
              writes: request.writes
            }, dependencies.recoveryTimeoutMs ?? WORKER_OPERATION_TIMEOUT_MS);
            if (!cleanup.ok)
              throwOperationFailure(cleanup);
            if (!cleanup.committed) {
              throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: committed bound-directory cleanup was not preserved");
            }
            return { ...result, cleanupPending: false };
          } catch (retryError) {
            unresolvedCleanup = retryError;
          }
        }
        return {
          ...result,
          cleanupPending: true,
          cleanupError: unresolvedCleanup instanceof Error ? unresolvedCleanup.message : String(unresolvedCleanup)
        };
      }
    }
    return result;
  } catch (error) {
    if (request.operation !== "cas" || !(error instanceof Error) || error.message !== "SESSION_INTEGRATION_WORKER_TIMEOUT") {
      throw error;
    }
    restartWorker(directory);
    let recovery;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        recovery = sendOperation(directory, {
          operation: "recover",
          journal: request.journal,
          writes: request.writes,
          recoveryDelayAfterUnlinkMs: dependencies.recoveryDelayAfterUnlinkMs ?? 0
        }, dependencies.recoveryTimeoutMs ?? WORKER_OPERATION_TIMEOUT_MS);
        if (!recovery.ok)
          throwOperationFailure(recovery);
        break;
      } catch (recoveryError) {
        if (!(recoveryError instanceof Error) || recoveryError.message !== "SESSION_INTEGRATION_WORKER_TIMEOUT") {
          throw recoveryError;
        }
        restartWorker(directory);
      }
    }
    if (!recovery) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory recovery failed");
    }
    if (recovery.committed)
      return recovery;
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation unavailable");
  }
}
function recoverDiscoveredTransactions(directory, discoveryQuarantineDelayMs = 0) {
  const result = runBoundOperation(directory, {
    operation: "discover",
    discoveryQuarantineDelayMs
  });
  if (!result.transactions) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory discovery returned invalid output");
  }
  for (const transaction of result.transactions) {
    if (!/^[0-9a-f-]{36}$/.test(transaction.transactionId) || transaction.journal !== `.rn-bound-${transaction.transactionId}.journal` || transaction.state !== "applying" && transaction.state !== "committed") {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory discovery returned invalid transaction");
    }
    directory.pendingCleanups.set(transaction.transactionId, {
      journal: transaction.journal,
      knownCommitted: transaction.state === "committed",
      writes: transaction.writes
    });
    retryBoundDirectoryCleanup(directory, {
      transactionId: transaction.transactionId
    });
  }
}
function openValidatedDirectory(path, expected) {
  let descriptor;
  let worker;
  try {
    const before = lstatSync6(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is not a directory");
    }
    descriptor = openSync4(path, constants3.O_RDONLY | (constants3.O_DIRECTORY ?? 0) | (constants3.O_NOFOLLOW ?? 0));
    const opened = fstatSync4(descriptor, { bigint: true });
    const after = lstatSync6(path, { bigint: true });
    const realPath = realpathSync4(path);
    if (!opened.isDirectory() || !sameIdentity(before, opened) || !sameIdentity(after, opened) || expected !== void 0 && (!sameIdentity(expected.identity, opened) || expected.realPath !== realPath)) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor changed while opening");
    }
    const identity = { dev: opened.dev, ino: opened.ino };
    worker = startWorker(path, identity, realPath);
    const directory = {
      children: /* @__PURE__ */ new Set(),
      descriptor,
      identity,
      path,
      pendingCleanups: /* @__PURE__ */ new Map(),
      realPath,
      worker,
      closed: false
    };
    recoverDiscoveredTransactions(directory);
    return directory;
  } catch (error) {
    const cleanupErrors = [];
    if (worker !== void 0) {
      try {
        stopWorker(worker, "SIGKILL");
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
      }
    }
    if (descriptor !== void 0) {
      try {
        closeSync4(descriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error instanceof Error ? error : new Error(String(error)), ...cleanupErrors], "bound-directory open cleanup failed");
    }
    if (error instanceof Error && error.message.includes("SESSION_INTEGRATION_PATH_UNSAFE")) {
      throw error;
    }
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is unavailable");
  }
}
function openBoundDirectory(path) {
  return openValidatedDirectory(path);
}
function closeBoundDirectory(directory) {
  if (directory.closed)
    return;
  const cleanupErrors = [];
  for (const child of directory.children) {
    try {
      closeBoundDirectory(child);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  for (const transactionId of directory.pendingCleanups.keys()) {
    try {
      retryBoundDirectoryCleanup(directory, { transactionId });
    } catch (error) {
      cleanupErrors.push(new Error(`bound-directory cleanup ${transactionId} failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  directory.closed = true;
  try {
    stopWorker(directory.worker);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(`bound-directory close failed: ${String(error)}`));
  }
  directory.parent?.children.delete(directory);
  if (directory.descriptor !== void 0) {
    try {
      closeSync4(directory.descriptor);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "bound-directory cleanup failed");
  }
}
function closeBoundDirectories(directories, primaryError) {
  const closeErrors = [];
  for (const directory of directories) {
    if (!directory)
      continue;
    try {
      closeBoundDirectory(directory);
    } catch (error) {
      closeErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (closeErrors.length === 0)
    return;
  const errors = primaryError === void 0 ? closeErrors : [
    primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
    ...closeErrors
  ];
  throw new AggregateError(errors, "bound-directory cleanup failed");
}
function assertBoundDirectoryCurrent(directory) {
  runBoundOperation(directory, { operation: "identity" });
}
function openBoundSubdirectoryInternal(parent, name, options = {}) {
  const controlPath = mkdtempSync(join5(tmpdir(), "rn-bound-directory-"));
  const childId = randomUUID2();
  const lifecycleCapability = randomUUID2();
  let worker;
  let childStarted = false;
  try {
    const result = runBoundOperation(parent, {
      operation: "directory",
      childId,
      controlPath,
      lifecycleCapability,
      name,
      publicPath: join5(parent.path, name),
      create: options.create ?? false,
      mode: options.mode ?? 448,
      optional: options.optional ?? false,
      optionalMissingDelayMs: options.optionalMissingDelayMs ?? 0
    });
    childStarted = !result.directoryMissing;
    if (result.directoryMissing) {
      rmSync3(controlPath, { force: true, recursive: true });
      return null;
    }
    worker = bindWorker(controlPath, void 0, parent, childId, lifecycleCapability);
    options.afterChildBind?.();
    if (!result.directoryIdentity) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory traversal returned invalid output");
    }
    const directory = {
      children: /* @__PURE__ */ new Set(),
      identity: {
        dev: BigInt(result.directoryIdentity.dev),
        ino: BigInt(result.directoryIdentity.ino)
      },
      name,
      parent,
      path: join5(parent.path, name),
      pendingCleanups: /* @__PURE__ */ new Map(),
      realPath: result.directoryIdentity.realPath,
      worker,
      closed: false
    };
    recoverDiscoveredTransactions(directory, options.discoveryQuarantineDelayMs);
    runBoundOperation(parent, { operation: "child-identity", childId });
    parent.children.add(directory);
    return directory;
  } catch (error) {
    try {
      if (worker)
        stopWorker(worker, "SIGKILL");
      else if (childStarted || error instanceof Error && error.message === "SESSION_INTEGRATION_WORKER_TIMEOUT") {
        stopWorker({
          childId,
          controlPath,
          lifecycleCapability,
          owner: parent,
          pid: 0,
          sequence: 0
        }, "SIGKILL");
      } else {
        rmSync3(controlPath, { force: true, recursive: true });
      }
    } catch (cleanupError) {
      throw new AggregateError([
        error instanceof Error ? error : new Error(String(error)),
        cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
      ], "bound-directory child cleanup failed");
    }
    throw error;
  }
}
function openBoundSubdirectory(parent, name, options = {}) {
  return openBoundSubdirectoryInternal(parent, name, options);
}
function openOptionalBoundSubdirectory(parent, name, dependencies = {}) {
  return openBoundSubdirectoryInternal(parent, name, {
    optional: true,
    ...dependencies.optionalMissingDelayMs === void 0 ? {} : { optionalMissingDelayMs: dependencies.optionalMissingDelayMs }
  });
}
function readBoundDirectoryFiles(directory, names) {
  const result = runBoundOperation(directory, { operation: "read", names });
  if (!result.snapshots || result.snapshots.length !== names.length) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory read returned invalid output");
  }
  return result.snapshots.map((snapshot) => ({
    contents: snapshot.contents === null ? null : Buffer.from(snapshot.contents, "base64"),
    mode: snapshot.mode,
    name: snapshot.name
  }));
}
function casBoundDirectoryFiles(directory, writes, dependencies = {}) {
  for (const transactionId2 of directory.pendingCleanups.keys()) {
    retryBoundDirectoryCleanup(directory, { transactionId: transactionId2 });
  }
  const transactionId = randomUUID2();
  const journal = `.rn-bound-${transactionId}.journal`;
  const serializedWrites = writes.map((write2, index) => ({
    expected: write2.expected?.toString("base64") ?? null,
    expectedMode: write2.expectedMode,
    mode: write2.mode,
    name: write2.name,
    replacement: write2.replacement?.toString("base64") ?? null,
    temporary: `.rn-bound-${transactionId}-${index}.tmp`,
    captured: `.rn-bound-${transactionId}-${index}.captured`,
    afterCaptureDelayMs: dependencies.afterCaptureDelayMs ?? 0,
    afterReplacementDelayMs: dependencies.afterReplacementDelayMs ?? 0
  }));
  const result = runBoundOperation(directory, {
    operation: "cas",
    journal,
    writes: serializedWrites,
    afterLockReleaseDelayMs: dependencies.afterLockReleaseDelayMs ?? 0,
    failCleanupAfterCommit: dependencies.failCleanupAfterCommit ?? false
  }, dependencies);
  if (!result.committed) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory commit was not confirmed");
  }
  if (result.cleanupPending) {
    directory.pendingCleanups.set(transactionId, {
      journal,
      knownCommitted: true,
      writes: serializedWrites
    });
  } else {
    directory.pendingCleanups.delete(transactionId);
  }
  return {
    committed: true,
    cleanupPending: result.cleanupPending ?? false,
    ...result.cleanupPending ? { cleanupObligation: { transactionId } } : {},
    ...result.cleanupError ? { cleanupError: result.cleanupError } : {}
  };
}
function retryBoundDirectoryCleanup(directory, obligation, dependencies = {}) {
  const transaction = directory.pendingCleanups.get(obligation.transactionId);
  if (!transaction) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory cleanup obligation is unavailable");
  }
  const request = {
    operation: "recover",
    journal: transaction.journal,
    writes: transaction.writes
  };
  let result;
  try {
    result = runBoundOperation(directory, request, dependencies);
  } catch (error) {
    if (transaction.knownCommitted && error instanceof Error && error.message.includes("bound-directory transaction outcome is unknown")) {
      directory.pendingCleanups.delete(obligation.transactionId);
      return;
    }
    if (!(error instanceof Error) || error.message !== "SESSION_INTEGRATION_WORKER_TIMEOUT") {
      throw error;
    }
    restartWorker(directory);
    result = runBoundOperation(directory, request, {
      ...dependencies,
      cleanupRecoveryDelayMs: 0
    });
  }
  if (result.committed !== transaction.knownCommitted) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory recovery changed transaction outcome");
  }
  directory.pendingCleanups.delete(obligation.transactionId);
}

// packages/rn-dev-agent-core/dist/session/package-integration.js
var ADAPTER = ".rn-agent/integration/rn-session-adapter.cjs";
var METRO_RUNTIME_LOADS = ".rn-agent/integration/metro-runtime-loads.jsonl";
var METRO_START = "// rn-dev-agent session integration: begin";
var METRO_END = "// rn-dev-agent session integration: end";
var SENTINELS = {
  ios: `node ${ADAPTER} ios`,
  android: `node ${ADAPTER} android`
};
function restoreMetroIntegration(source) {
  const start = source.indexOf(METRO_START);
  const end = source.indexOf(METRO_END);
  if (start < 0 && end < 0)
    return source;
  if (start < 0 || end < start || source.indexOf(METRO_START, start + METRO_START.length) >= 0 || source.indexOf(METRO_END, end + METRO_END.length) >= 0) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: Metro integration sentinel is corrupt");
  }
  const blockEnd = end + METRO_END.length;
  const prefix = source.slice(0, start).trimEnd();
  const suffix = source.slice(blockEnd).replace(/^(?:\r?\n)+/, "");
  return suffix ? `${prefix}
${suffix}` : `${prefix}
`;
}
function restorePackageIntegration(packageJson, manifest) {
  const restoredScripts = {
    ios: manifest.originalScripts.ios.join(" "),
    android: manifest.originalScripts.android.join(" ")
  };
  if (packageJson.scripts?.ios === restoredScripts.ios && packageJson.scripts?.android === restoredScripts.android) {
    return packageJson;
  }
  if (packageJson.scripts?.ios !== SENTINELS.ios || packageJson.scripts?.android !== SENTINELS.android) {
    throw new Error("SESSION_INTEGRATION_CONFLICT: package scripts changed after integration was installed");
  }
  return {
    ...packageJson,
    scripts: {
      ...packageJson.scripts,
      ...restoredScripts
    }
  };
}
function snapshotBoundFiles(directory, directoryPath, names) {
  return readBoundDirectoryFiles(directory, names).map((snapshot) => ({
    ...snapshot,
    path: join6(directoryPath, snapshot.name)
  }));
}
function casReplaceBoundBatch(directory, writes, dependencies = {}) {
  return casBoundDirectoryFiles(directory, writes.map((write2) => ({
    expected: write2.expected,
    expectedMode: write2.expectedMode ?? write2.snapshot.mode,
    mode: write2.mode,
    name: write2.snapshot.name,
    replacement: write2.replacement
  })), dependencies);
}
function assertBoundCleanup(result) {
  if (result.cleanupPending) {
    const transaction = result.cleanupObligation?.transactionId ?? "unknown transaction";
    throw new Error(`SESSION_INTEGRATION_PATH_UNSAFE: committed cleanup remains pending: ${transaction}: ${result.cleanupError ?? "cleanup unavailable"}`);
  }
}
function readPackageIntegrationInputs(appRootInput, dependencies = {}) {
  const appRoot = resolve3(appRootInput);
  const app = openBoundDirectory(appRoot);
  let agent = null;
  let integration = null;
  let primaryError;
  try {
    const [packageSnapshot, metroJsSnapshot, metroCjsSnapshot] = readBoundDirectoryFiles(app, [
      "package.json",
      "metro.config.js",
      "metro.config.cjs"
    ]);
    if (!packageSnapshot?.contents) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: package.json is unavailable");
    }
    const metroSnapshot = metroJsSnapshot?.contents ? metroJsSnapshot : metroCjsSnapshot;
    if (!metroSnapshot?.contents) {
      throw new Error("BUNDLE_HANDSHAKE_UNAVAILABLE: metro.config.js or metro.config.cjs is required");
    }
    dependencies.afterAppRead?.();
    agent = openOptionalBoundSubdirectory(app, ".rn-agent");
    if (agent) {
      integration = openOptionalBoundSubdirectory(agent, "integration");
    }
    const manifest = integration ? readBoundDirectoryFiles(integration, ["rn-session-integration.json"])[0]?.contents : null;
    return {
      packageJson: packageSnapshot.contents.toString("utf8"),
      metroConfig: {
        contents: metroSnapshot.contents.toString("utf8"),
        path: join6(appRoot, metroSnapshot.name)
      },
      ...manifest ? { manifest: manifest.toString("utf8") } : {}
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    closeBoundDirectories([integration, agent, app], primaryError);
  }
}
var GENERATED_INTEGRATION_FILES = [
  "rn-session-integration.json",
  "rn-session-adapter.cjs",
  "rn-session-metro.cjs",
  "authority-marker.js",
  "boot-error-capture.js",
  "metro-runtime-policy.json",
  basename(METRO_RUNTIME_LOADS)
];
function openIntegrationDirectories(appRoot) {
  const app = openBoundDirectory(appRoot);
  try {
    const agent = openBoundSubdirectory(app, ".rn-agent", { create: true });
    try {
      const integration = openBoundSubdirectory(agent, "integration", { create: true });
      return { app, agent, integration };
    } catch (error) {
      closeBoundDirectories([agent], error);
      throw error;
    }
  } catch (error) {
    closeBoundDirectories([app], error);
    throw error;
  }
}
function rollbackWrites(writes, dependencies) {
  const errors = [];
  for (const write2 of [...writes].reverse()) {
    try {
      const result = casReplaceBoundBatch(write2.directory, [
        {
          snapshot: write2.snapshot,
          expected: write2.written,
          expectedMode: write2.writtenMode,
          replacement: write2.snapshot.contents,
          mode: write2.snapshot.mode
        }
      ], dependencies);
      assertBoundCleanup(result);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors;
}
function restorePackageIntegrationFiles(input, dependencies = {}) {
  const appRoot = resolve3(input.appRoot);
  const packagePath = join6(appRoot, "package.json");
  const directories = openIntegrationDirectories(appRoot);
  const generatedNames = [
    "rn-session-integration.json",
    "rn-session-adapter.cjs",
    "rn-session-metro.cjs",
    "authority-marker.js",
    "boot-error-capture.js",
    "metro-runtime-policy.json",
    basename(METRO_RUNTIME_LOADS)
  ];
  const applied = [];
  let primaryError;
  try {
    const generatedSnapshots = snapshotBoundFiles(directories.integration, directories.integration.path, generatedNames);
    const installedManifestSource = generatedSnapshots[0]?.contents?.toString("utf8");
    if (installedManifestSource && input.manifestSource && installedManifestSource !== input.manifestSource) {
      throw new Error("SESSION_INTEGRATION_CONFLICT: integration manifest changed before restore");
    }
    const manifestSource = installedManifestSource ?? input.manifestSource;
    if (!manifestSource) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: integration manifest is missing");
    }
    const manifest = JSON.parse(manifestSource);
    const metroConfig = manifest.metroConfig === void 0 ? "metro.config.js" : manifest.metroConfig;
    if (metroConfig !== "metro.config.js" && metroConfig !== "metro.config.cjs") {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: manifest Metro config is not an expected app-root config");
    }
    const metroConfigPath = join6(appRoot, metroConfig);
    const [packageSnapshot, metroSnapshot] = snapshotBoundFiles(directories.app, appRoot, [
      basename(packagePath),
      basename(metroConfigPath)
    ]);
    if (!packageSnapshot?.contents || !metroSnapshot?.contents) {
      throw new Error("SESSION_INTEGRATION_CONFLICT: integration input changed before commit");
    }
    const packageJson = JSON.parse(packageSnapshot.contents.toString("utf8"));
    const metroSource = metroSnapshot.contents.toString("utf8");
    dependencies.beforeCommit?.();
    const packageOutput = Buffer.from(`${JSON.stringify(restorePackageIntegration(packageJson, manifest), null, 2)}
`);
    const packageResult = casReplaceBoundBatch(directories.app, [
      {
        snapshot: packageSnapshot,
        expected: packageSnapshot.contents,
        replacement: packageOutput,
        mode: packageSnapshot.mode
      }
    ], dependencies.boundOperationDependencies);
    applied.push({
      snapshot: packageSnapshot,
      written: packageOutput,
      writtenMode: packageSnapshot.mode,
      directory: directories.app
    });
    dependencies.afterWrite?.(packagePath);
    assertBoundCleanup(packageResult);
    const metroOutput = Buffer.from(restoreMetroIntegration(metroSource));
    const metroResult = casReplaceBoundBatch(directories.app, [
      {
        snapshot: metroSnapshot,
        expected: metroSnapshot.contents,
        replacement: metroOutput,
        mode: metroSnapshot.mode
      }
    ], dependencies.boundOperationDependencies);
    applied.push({
      snapshot: metroSnapshot,
      written: metroOutput,
      writtenMode: metroSnapshot.mode,
      directory: directories.app
    });
    dependencies.afterWrite?.(metroConfigPath);
    assertBoundCleanup(metroResult);
    assertBoundDirectoryCurrent(directories.agent);
    assertBoundDirectoryCurrent(directories.integration);
    const generatedResult = casReplaceBoundBatch(directories.integration, generatedSnapshots.map((snapshot) => ({
      snapshot,
      expected: snapshot.contents,
      replacement: null,
      mode: snapshot.mode
    })), dependencies.boundOperationDependencies);
    for (const snapshot of generatedSnapshots) {
      applied.push({
        snapshot,
        written: null,
        directory: directories.integration
      });
    }
    assertBoundCleanup(generatedResult);
    assertBoundDirectoryCurrent(directories.agent);
    assertBoundDirectoryCurrent(directories.integration);
  } catch (error) {
    const rollbackErrors = rollbackWrites(applied, dependencies.boundOperationDependencies);
    primaryError = rollbackErrors.length > 0 ? new AggregateError([error, ...rollbackErrors]) : error;
    throw primaryError;
  } finally {
    closeBoundDirectories([directories.integration, directories.agent, directories.app], primaryError);
  }
}

// packages/rn-dev-agent-core/dist/session/process-cleanup.js
init_release_android_slot();
init_cleanup_identity();
import { execFile as execFileCb11, spawn as spawn5 } from "node:child_process";
import { promisify as promisify14 } from "node:util";
init_process_birth();
init_registry();
var execFile13 = promisify14(execFileCb11);
var RECORDER_POST_KILL_CONFIRM_MS = 2e3;
function executeRecorderScript(script, args, options) {
  return new Promise((resolve4, reject) => {
    const child = spawn5(script, args, {
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timer;
    let killTimer;
    let groupPollTimer;
    let groupExitDeadline;
    let terminationError;
    const finish = (error, result) => {
      if (settled)
        return;
      settled = true;
      if (timer)
        clearTimeout(timer);
      if (killTimer)
        clearTimeout(killTimer);
      if (groupPollTimer)
        clearTimeout(groupPollTimer);
      if (error)
        reject(error);
      else
        resolve4(result);
    };
    const signal = (value) => {
      if (child.pid === void 0)
        return;
      try {
        if (process.platform === "win32")
          child.kill(value);
        else
          process.kill(-child.pid, value);
      } catch {
      }
    };
    const processGroupExists = () => {
      if (child.pid === void 0 || process.platform === "win32")
        return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error.code !== "ESRCH";
      }
    };
    const waitForProcessGroupExit = () => {
      if (!terminationError || settled)
        return;
      if (!processGroupExists()) {
        finish(terminationError);
        return;
      }
      if (groupExitDeadline !== void 0 && Date.now() >= groupExitDeadline) {
        finish(new Error(`${terminationError.message}; recorder process-group termination is unconfirmed`, { cause: terminationError }));
        return;
      }
      groupPollTimer = setTimeout(waitForProcessGroupExit, 25);
    };
    const terminate = (error) => {
      if (terminationError)
        return;
      terminationError = error;
      signal("SIGTERM");
      if (process.platform === "win32")
        return;
      killTimer = setTimeout(() => {
        groupExitDeadline = Date.now() + RECORDER_POST_KILL_CONFIRM_MS;
        signal("SIGKILL");
        waitForProcessGroupExit();
      }, 250);
      waitForProcessGroupExit();
    };
    const collect = (target) => (chunk) => {
      if (terminationError)
        return;
      outputBytes += chunk.length;
      if (outputBytes > 8 * 1024 * 1024) {
        terminate(new Error("record_proof.sh output exceeded 8 MiB"));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("error", (error) => {
      if (child.pid === void 0)
        finish(error);
      else
        terminate(error);
    });
    child.on("close", (code, signal2) => {
      if (terminationError) {
        if (process.platform === "win32")
          finish(terminationError);
        else
          waitForProcessGroupExit();
        return;
      }
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code === 0) {
        finish(void 0, result);
        return;
      }
      finish(new Error(`record_proof.sh exited with ${code ?? signal2 ?? "unknown"}: ${result.stderr.trim()}`));
    });
    timer = setTimeout(() => {
      terminate(new Error(`record_proof.sh timed out after ${options.timeout}ms`));
    }, options.timeout);
  });
}
async function runRecordProofScript(script, args, timeout = 6e4, dependencies = {}) {
  const execute2 = dependencies.execute ?? executeRecorderScript;
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    return execute2(script, args, { timeout, env: { ...process.env } });
  }
  const withHelper = dependencies.withHelper ?? withVerifiedDarwinProcessBirthHelper;
  return withHelper((helper) => execute2(script, args, {
    timeout,
    env: {
      ...process.env,
      RN_DEV_AGENT_PROCESS_BIRTH_HELPER: helper.path,
      RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT: helper.requirement
    }
  }));
}
async function awaitExactStopped(probe, deadlineMs, code, message) {
  while (true) {
    const status = probe();
    if (status === "stopped")
      return true;
    if (status === "unknown") {
      throw new SessionAuthorityError(code, `${message}; shutdown identity is unknown`);
    }
    if (Date.now() >= deadlineMs)
      return false;
    await new Promise((resolve4) => setTimeout(resolve4, 25));
  }
}
async function waitForExactStopped(probe, deadlineMs, code, message) {
  if (!await awaitExactStopped(probe, deadlineMs, code, message)) {
    throw new SessionAuthorityError(code, message);
  }
}
async function stopBoundObserve(binding, listenerProbe = probeManagedMetroListener, processProbe = probeProcessBirth, timeoutMs = 2e3, request = fetch) {
  const deadlineMs = Date.now() + timeoutMs;
  const port = Number(binding.port);
  const pid = Number(binding.pid);
  const expectedBirth = String(binding.processBirth ?? "");
  const instanceId = String(binding.instanceId ?? "");
  const capability = String(binding.cleanupCapability ?? "");
  if (!Number.isSafeInteger(port) || !Number.isSafeInteger(pid) || !expectedBirth || !instanceId || !capability) {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe cleanup authority is incomplete");
  }
  const currentListener = listenerProbe(port);
  if (currentListener.status === "unknown") {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe listener lookup is inconclusive");
  }
  if (currentListener.status === "absent" || currentListener.pid !== pid)
    return;
  const currentBirth = processProbe(pid);
  if (currentBirth.status === "unknown") {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe process identity is unavailable");
  }
  if (currentBirth.status === "absent" && currentBirth.reason === "foreign")
    return;
  if (currentBirth.status === "present" && currentBirth.birth.token !== expectedBirth)
    return;
  if (currentBirth.status === "absent") {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe listener identity is internally inconsistent");
  }
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe cleanup timed out before the stop request");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  let response;
  try {
    response = await request(`http://127.0.0.1:${port}/api/stop`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "x-rn-observe-instance": instanceId
      },
      signal: controller.signal
    });
  } catch {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe cleanup request failed or timed out");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe server refused fenced cleanup");
  }
  await waitForExactStopped(() => {
    const observed = listenerProbe(port);
    if (observed.status === "unknown")
      return "unknown";
    return observed.status === "listening" && observed.pid === pid ? "running" : "stopped";
  }, deadlineMs, "OBSERVE_AUTHORITY_MISMATCH", "Observe listener did not stop before the cleanup deadline");
}
async function stopBoundRunner(binding, processProbe = probeProcessBirth, signalProcess = process.kill, timeoutMs = 2e3, runAdb = async (args) => execFile13("adb", args, { timeout: 5e3, encoding: "utf8" }), termGraceMs = 500) {
  const deadlineMs = Date.now() + timeoutMs;
  if (!hasCompleteRunnerCleanupIdentity(binding)) {
    throw new SessionAuthorityError("RUNNER_ADOPTION_REQUIRED", "runner cleanup identity is incomplete");
  }
  const pid = binding.pid;
  const expectedBirth = String(binding.processBirth ?? "");
  const platform = String(binding.platform ?? "");
  const deviceId = String(binding.deviceId ?? "");
  const port = binding.port;
  const current = processProbe(pid);
  if (current.status === "unknown") {
    throw new SessionAuthorityError("RUNNER_ADOPTION_REQUIRED", "runner process identity is unavailable");
  }
  if (current.status === "present" && current.birth.token === expectedBirth) {
    const observeStop = () => {
      const observed = processProbe(pid);
      if (observed.status === "unknown")
        return "unknown";
      return observed.status === "present" && observed.birth.token === expectedBirth ? "running" : "stopped";
    };
    const message = "runner process did not stop before the cleanup deadline";
    const signalTolerated = (value) => {
      try {
        signalProcess(pid, value);
      } catch {
      }
    };
    signalTolerated("SIGTERM");
    const graceDeadlineMs = Math.min(deadlineMs, Date.now() + termGraceMs);
    if (!await awaitExactStopped(observeStop, graceDeadlineMs, "RUNNER_ADOPTION_REQUIRED", message)) {
      const escalation = processProbe(pid);
      if (escalation.status === "unknown") {
        throw new SessionAuthorityError("RUNNER_ADOPTION_REQUIRED", `${message}; shutdown identity is unknown`);
      }
      if (escalation.status === "present" && escalation.birth.token === expectedBirth) {
        signalTolerated("SIGKILL");
      }
      await waitForExactStopped(observeStop, deadlineMs, "RUNNER_ADOPTION_REQUIRED", message);
    }
  }
  if (platform !== "android")
    return;
  if (!deviceId || !Number.isSafeInteger(port)) {
    throw new SessionAuthorityError("RUNNER_ADOPTION_REQUIRED", "Android runner cleanup identity is incomplete");
  }
  const serial = ["-s", deviceId];
  try {
    await runAdb([...serial, "forward", "--remove", `tcp:${port}`]);
    for (const pkg of OWNED_PACKAGES) {
      await runAdb([...serial, "shell", "am", "force-stop", pkg]);
      const process2 = await runAdb([...serial, "shell", "sh", "-c", `pidof ${pkg} || true`]);
      if (process2.stdout.trim()) {
        throw new Error(`${pkg} remains alive after force-stop`);
      }
    }
    const instrumentation = await runAdb([
      ...serial,
      "shell",
      "dumpsys",
      "activity",
      "instrumentation"
    ]);
    const output = `${instrumentation.stdout}
${instrumentation.stderr}`;
    if (OWNED_PACKAGES.some((pkg) => output.includes(pkg))) {
      throw new Error("owned instrumentation remains registered");
    }
  } catch (error) {
    throw new SessionAuthorityError("RUNNER_ADOPTION_REQUIRED", `Android device-side runner termination is unproven: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function stopBoundRecorder(binding, _processProbe = probeProcessBirth, runRecorder = async (script, args) => runRecordProofScript(script, args)) {
  const script = String(binding.script ?? "");
  const scope = String(binding.scope ?? "");
  if (!hasCompleteRecorderCleanupIdentity(binding)) {
    throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "recorder cleanup identity is incomplete");
  }
  if (binding.phase === "starting") {
    try {
      const initialStatus = await runRecorder(script, ["status", scope]);
      const active = initialStatus.stdout.match(/^(?:ios|android): pid=(\d+) birth=(\S+) status=\w+ output=.*$/m);
      if (active) {
        await runRecorder(script, ["abort", scope]);
      } else if (/^No active recordings/m.test(initialStatus.stdout)) {
        await runRecorder(script, ["abort", scope]);
      } else {
        throw new Error("provisional recorder status is not parseable");
      }
      const finalStatus = await runRecorder(script, ["status", scope]);
      if (!/^No active recordings/m.test(finalStatus.stdout)) {
        throw new Error("provisional recorder state remains active after cleanup");
      }
      return "";
    } catch (error) {
      throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", `provisional recorder termination is unproven: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const pid = binding.pid;
  const expectedBirth = String(binding.processBirth ?? "");
  try {
    const stopped = await runRecorder(script, ["stop", scope, String(pid), expectedBirth]);
    const status = await runRecorder(script, ["status", scope]);
    if (!/^No active recordings/m.test(status.stdout)) {
      throw new Error("recorder state remains active after cleanup");
    }
    return stopped.stdout;
  } catch (error) {
    throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", `recorder termination is unproven: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// packages/rn-dev-agent-core/dist/session/startup-cleanup.js
init_recovery_remedy();
init_registry();
var EXECUTION_ORDER = [
  "androidMetroReverse",
  "recorder",
  "runner",
  "observe",
  "metro"
];
async function runStartupOwnerCleanup(input, dependencies = {}) {
  const released = [];
  let discardedContenders = [];
  try {
    discardedContenders = input.registry.discardAbandonedBlockedContenders(input.worktreeKey);
  } catch {
  }
  for (let round = 0; round < 8; round += 1) {
    const candidate = input.registry.findStartupCleanupCandidate(input);
    if (!candidate)
      return { status: "clean", released, discardedContenders };
    try {
      const plan = input.registry.beginStartupOwnerCleanup(candidate);
      await completeObligations(input.registry, candidate, dependencies);
      restoreDeadOwnerIntegration(input, candidate, plan, dependencies);
      input.registry.finishStartupOwnerCleanup(candidate);
      released.push(candidate.sessionId);
    } catch (error) {
      const refusal = refusalOf(error);
      retainRefusal(input.registry, candidate, refusal);
      return { status: "refused", released, discardedContenders, refusal };
    }
  }
  return {
    status: "refused",
    released,
    discardedContenders,
    refusal: publicRefusal({
      code: "RESOURCE_CLAIM_CONFLICT",
      message: "startup cleanup did not converge for this worktree"
    })
  };
}
async function runStartupCleanupForSource(input) {
  const layout = resolveAuthorityStateLayout(input.stateDir);
  const registry = openSessionRegistry(layout.registry, {
    ownerStatus: input.ownerStatus,
    leaseMs: 3e4
  });
  try {
    return await runStartupOwnerCleanup({
      registry,
      sourceKey: input.source.sourceKey,
      worktreeKey: input.source.worktreeKey,
      appRootKey: input.source.appRootKey,
      appRoot: input.source.appRoot
    }, {
      readSessionSecret: (sessionId) => readJsonStateFile(join14(layout.sessions, sessionId, "secret.json"))
    });
  } finally {
    registry.close();
  }
}
async function completeObligations(registry, prior, dependencies) {
  for (const resource of EXECUTION_ORDER) {
    const entry = registry.verifyStartupOwnerObligation(prior, resource);
    if (!entry || typeof entry.completedAt === "number")
      continue;
    if (resource === "androidMetroReverse") {
      (dependencies.removeAndroidMetroReverse ?? removeAndroidMetroReverse)(entry);
    } else if (resource === "recorder") {
      await (dependencies.stopBoundRecorder ?? stopBoundRecorder)(entry);
    } else if (resource === "runner") {
      await (dependencies.stopBoundRunner ?? stopBoundRunner)(entry);
    } else if (resource === "observe") {
      await (dependencies.stopBoundObserve ?? stopBoundObserve)(entry);
    } else {
      const secret = dependencies.readSessionSecret?.(prior.sessionId) ?? null;
      const signerCapability = typeof secret?.signerCapability === "string" ? secret.signerCapability : "";
      const stop = dependencies.stopManagedMetro ?? ((binding, stopInput) => stopManagedMetro(binding, stopInput));
      const stopped = await stop(entry, { sessionId: prior.sessionId, signerCapability });
      if (!stopped) {
        throw new SessionAuthorityError("METRO_CLEANUP_PENDING", "managed Metro could not be stopped with exact process authority");
      }
    }
    registry.completeStartupOwnerObligation(prior, resource);
  }
}
function restoreDeadOwnerIntegration(input, prior, plan, dependencies) {
  if (!plan.integration || typeof plan.integration.completedAt === "number")
    return;
  const binding = input.registry.getSessionStatus(prior.sessionId)?.bindings.packageIntegration;
  if (!binding || typeof binding !== "object")
    return;
  const manifestSha256 = typeof binding.manifestSha256 === "string" ? binding.manifestSha256 : "";
  const manifestSource = verifiedDeadOwnerManifestSource(input.appRoot, binding, manifestSha256);
  if (!manifestSource) {
    throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "integration restoration requires a SHA-256-verified manifest and none is available; the dead owner binding is preserved", void 0, {
      nextAction: sessionRecoveryRemedy("Restore the exact integration manifest at .rn-agent/integration/rn-session-integration.json from your own version control history or backups so it matches the manifest SHA-256 recorded on the binding.")
    });
  }
  input.registry.verifyStartupOwnerIntegrationRestore(prior, {
    sourceKey: input.sourceKey,
    worktreeKey: input.worktreeKey,
    appRootKey: input.appRootKey,
    manifestSha256
  });
  (dependencies.restoreIntegrationFiles ?? restorePackageIntegrationFiles)({
    appRoot: input.appRoot,
    manifestSource
  });
  input.registry.completeStartupOwnerIntegrationRestore(prior, { manifestSha256 });
}
function verifiedDeadOwnerManifestSource(appRoot, binding, manifestSha256) {
  if (!/^[0-9a-f]{64}$/.test(manifestSha256))
    return void 0;
  const verified = (candidate) => typeof candidate === "string" && createHash6("sha256").update(candidate).digest("hex") === manifestSha256 ? candidate : void 0;
  let liveManifest;
  try {
    liveManifest = readPackageIntegrationInputs(appRoot).manifest ?? void 0;
  } catch {
    liveManifest = void 0;
  }
  const phase = (value) => value && typeof value === "object" ? value : null;
  const restoration = phase(binding.restoration);
  const installation = phase(binding.installation);
  return verified(liveManifest) ?? verified(restoration?.phase === "started" ? restoration.manifestSource : void 0) ?? verified(installation?.phase === "started" ? installation.manifestSource : void 0) ?? verified(binding.manifestSource);
}
function retainRefusal(registry, prior, refusal) {
  try {
    registry.recordStartupCleanupRefusal(prior, {
      code: refusal.code,
      reason: refusal.message,
      ...refusal.nextAction ? { nextAction: refusal.nextAction } : {}
    });
  } catch {
  }
}
var PUBLIC_REFUSAL_REASONS = /* @__PURE__ */ new Set([
  "integration restoration requires a SHA-256-verified manifest and none is available; the dead owner binding is preserved",
  "integration restoration requires the recorded manifest authority",
  "integration restoration requires the active startup journal and recorded manifest authority",
  "managed Metro could not be stopped with exact process authority",
  "managed Metro cleanup has not been durably completed",
  "startup cleanup did not converge for this worktree",
  "startup cleanup no longer matches the exact source and app root",
  "no startup cleanup is in progress",
  ...Object.values(OWNER_IDENTITY_REFUSAL_REASONS),
  "the startup cleanup owner no longer matches the proven claim epoch",
  ...["androidMetroReverse", "recorder", "runner", "observe", "metro"].flatMap((resource) => [
    `${resource} cleanup has not been durably completed`,
    `${resource} cleanup was not durably requested`
  ])
]);
var OWNER_IDENTITY_REFUSALS = new Set(Object.values(OWNER_IDENTITY_REFUSAL_REASONS));
var OWNER_IDENTITY_REFUSAL_REMEDY = sessionOwnerInspectionRemedy("Startup cleanup refused because the recorded owner is live or its identity could not be proven, and preserved its binding.");
function unmetObligationRemedy(code) {
  return sessionCleanupObligationRemedy(`Startup cleanup refused with ${code} and preserved the prior owner binding; another restart alone repeats the same refusal.`);
}
function publicRefusal(refusal) {
  const sentence = refusal.message.replace(/^[A-Z][A-Z0-9_]+: /, "");
  const authored = PUBLIC_REFUSAL_REASONS.has(sentence);
  const fallback = OWNER_IDENTITY_REFUSALS.has(sentence) ? OWNER_IDENTITY_REFUSAL_REMEDY : unmetObligationRemedy(refusal.code);
  return {
    code: refusal.code,
    message: authored ? sentence : `startup cleanup refused with ${refusal.code} and preserved the prior owner binding`,
    nextAction: authored ? refusal.nextAction ?? fallback : fallback
  };
}
function refusalOf(error) {
  if (error instanceof SessionAuthorityError) {
    return publicRefusal({
      code: error.code,
      message: error.message,
      ...error.details?.nextAction ? { nextAction: error.details.nextAction } : {}
    });
  }
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "STARTUP_CLEANUP_FAILED";
  return publicRefusal({
    code,
    message: error instanceof Error ? error.message : String(error)
  });
}

// packages/rn-dev-agent-core/dist/session-doctor.js
var USAGE = "usage: session-doctor [report|repair] [--json]\n  report  releases nothing: is this source root wedged, and by what\n  repair  release a proven-dead same-root owner and reap abandoned contenders\n";
function resolveSource() {
  return resolveSourceIdentity(process.cwd(), {
    declaredRoot: process.env.RN_DEV_AGENT_DECLARED_ROOT,
    declaredManifests: parseDeclaredManifests(process.env.RN_DEV_AGENT_DECLARED_MANIFESTS)
  });
}
function stateDir() {
  return process.env.RN_DEV_AGENT_STATE_DIR || void 0;
}
function remedyFor(ownership) {
  if (ownership.owner === "absent") {
    return "No same-root owner holds this worktree; nothing to recover.";
  }
  if (!ownership.sameRoot) {
    if (ownership.owner === "live") {
      return sessionOwnerInspectionRemedy("A live owner of a different app root or declared source in this worktree holds it.");
    }
    if (ownership.owner === "unprovable") {
      return sessionOwnerInspectionRemedy("The identity of the owner holding this worktree could not be proven, so it is treated as live; it belongs to a different app root or declared source.");
    }
    if (ownership.mismatch === "source-identity") {
      return sessionDeclaredSourceRemedy("The proven-dead owner has a different source identity for this same app root, so startup cleanup cannot release it under the current declared manifests.");
    }
    return sessionOtherRootRecoveryRemedy("The proven-dead owner belongs to a different app root or declared source in this worktree, so this root cannot release it.");
  }
  if (ownership.owner === "live") {
    return sessionOwnerInspectionRemedy("A live same-root owner holds this worktree.");
  }
  if (ownership.owner === "unprovable") {
    return sessionOwnerInspectionRemedy("The same-root owner identity could not be proven, so it is treated as live.");
  }
  if (ownership.startupCleanupBlocked) {
    const blocked = ownership.startupCleanupBlocked;
    return sessionCleanupObligationRemedy(`The prior owner is proven dead, but startup cleanup refused with ${blocked.code} and will refuse again until that is resolved: ${blocked.reason}.`);
  }
  return sessionRecoveryRemedy("The prior owner is proven dead and can be released now.");
}
function isWedged(ownership) {
  if (ownership.owner === "unprovable")
    return true;
  if (ownership.owner !== "stale")
    return false;
  return !ownership.sameRoot || ownership.startupCleanupBlocked !== void 0;
}
function isRepairable(ownership) {
  return ownership.owner === "stale" && ownership.sameRoot && !isWedged(ownership);
}
function holderOf(ownership) {
  if (!ownership.holder)
    return {};
  return {
    ownerSession: ownership.holder.session,
    ...ownership.holder.appRoot === void 0 ? {} : { ownerAppRoot: ownership.holder.appRoot },
    ...ownership.mismatch === void 0 ? {} : { ownerMismatch: ownership.mismatch }
  };
}
function inspect() {
  const layout = resolveAuthorityStateLayout(stateDir());
  const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
  try {
    return { ownership: registry.inspectSourceOwnership(resolveSource()), layout };
  } finally {
    registry.close();
  }
}
function report() {
  const source = resolveSource();
  const { ownership, layout } = inspect();
  return {
    ok: !isWedged(ownership),
    payload: {
      authorityStore: layout.registry,
      appRoot: source.appRoot,
      worktree: source.worktreeKey.slice(0, 12),
      sameRootOwner: ownership.owner,
      ownerIsThisRoot: ownership.sameRoot,
      ...holderOf(ownership),
      abandonedContenders: ownership.abandonedContenders,
      wedged: isWedged(ownership),
      repairable: isRepairable(ownership),
      ...ownership.startupCleanupBlocked ? { startupCleanupBlocked: ownership.startupCleanupBlocked } : {},
      remedy: remedyFor(ownership)
    }
  };
}
async function repair() {
  const source = resolveSource();
  const layout = resolveAuthorityStateLayout(stateDir());
  const outcome = await runStartupCleanupForSource({
    source,
    stateDir: stateDir(),
    ownerStatus: inspectSessionOwner
  });
  const ownership = inspect().ownership;
  const wedged = isWedged(ownership);
  return {
    ok: outcome.status === "clean" && !wedged,
    payload: {
      authorityStore: layout.registry,
      appRoot: source.appRoot,
      status: outcome.status,
      released: outcome.released,
      discardedContenders: outcome.discardedContenders,
      ...holderOf(ownership),
      wedged,
      ...outcome.refusal ? { refusal: outcome.refusal } : {},
      remedy: wedged || ownership.owner === "live" ? remedyFor(ownership) : outcome.status === "clean" ? "This source root is recoverable now; start rn-dev-agent here again." : outcome.refusal?.nextAction ?? sessionRecoveryRemedy("Startup cleanup preserved the prior owner.")
    }
  };
}
function write(payload, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}
`);
    return;
  }
  for (const [key, value] of Object.entries(payload)) {
    process.stdout.write(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}
`);
  }
}
async function main() {
  const positional = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const json = process.argv.includes("--json");
  const command = positional[0] ?? "report";
  if (command !== "report" && command !== "repair") {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const result = command === "report" ? report() : await repair();
  write(result.payload, json);
  process.exitCode = result.ok ? 0 : 1;
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const typed = /^([A-Z][A-Z0-9_]+): ([\s\S]*)$/.exec(message);
  const code = error instanceof SessionAuthorityError ? error.code : typed?.[1] ?? "SESSION_DOCTOR_FAILED";
  const detail = typed !== null && typed[1] === code ? typed[2] ?? message : message;
  const remedy = code.startsWith("AUTHORITY_STATE_") ? "Point RN_DEV_AGENT_STATE_DIR at the authority state home that holds this session, or unset it to use the default." : `Run ${HEADLESS_SESSION_RECOVERY_COMMAND} from the app root that owns this session.`;
  process.stderr.write(`${code}: ${detail}
${remedy}
`);
  process.exitCode = 1;
});
