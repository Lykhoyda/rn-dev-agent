#!/usr/bin/env node
const {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { dirname, join } = require('node:path');

const repoRoot = dirname(__dirname);
const output = join(repoRoot, 'packages', 'rn-dev-agent-core', 'native', 'darwin-process-birth');
const manifestOutput = `${output}.json`;
const temporaryOutput = `${output}.tmp-${process.pid}`;
const temporarySource = `${output}.c.tmp-${process.pid}`;
const source = `#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;

  errno = 0;
  char *end = NULL;
  long raw_pid = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\\0' || raw_pid <= 0 || raw_pid > INT32_MAX) {
    return 2;
  }

  struct proc_bsdinfo info = {0};
  int observed_size =
      proc_pidinfo((int)raw_pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (observed_size != (int)sizeof(info) || info.pbi_pid != (uint32_t)raw_pid) {
    return 3;
  }

  printf("%u:%" PRIu64 ":%" PRIu64 "\\n",
         info.pbi_pid,
         info.pbi_start_tvsec,
         info.pbi_start_tvusec);
  return 0;
}
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const compiler = '/usr/bin/xcrun';
const compilerVersion = 'Apple clang version 21.0.0 (clang-2100.0.123.102)';
const sdkVersion = '26.4';
const compilerArguments = [
  '--sdk',
  'macosx',
  'clang',
  '-x',
  'c',
  '<source>',
  '-Os',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-arch',
  'arm64',
  '-arch',
  'x86_64',
  '-mmacosx-version-min=11.0',
  '-isysroot',
  '<sdk>',
  '-o',
  '<output>',
];
const signer = '/usr/bin/codesign';
const signerArguments = [
  '--force',
  '--sign',
  '-',
  '--identifier',
  'dev.rn-dev-agent.process-birth',
  '<output>',
];
const recipeSha256 = sha256(
  JSON.stringify({
    sourceSha256: sha256(source),
    compiler,
    compilerVersion,
    compilerArguments,
    sdkVersion,
    uuidScheme: 'sha256-recipe-cputype-v1',
    signer,
    signerArguments,
  }),
);

function runCodesign(arguments_) {
  return spawnSync(signer, arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasExpectedCodeSignature(path) {
  const verification = runCodesign(['--verify', '--strict', path]);
  if (verification.error || verification.status !== 0) return false;

  const details = runCodesign(['--display', '--verbose=4', path]);
  if (details.error || details.status !== 0) return false;
  const detailLines = new Set(details.stderr.trim().split('\n'));
  const codeDirectory = [...detailLines].find((line) => line.startsWith('CodeDirectory '));
  if (
    !detailLines.has('Identifier=dev.rn-dev-agent.process-birth') ||
    !detailLines.has('Format=Mach-O universal (x86_64 arm64)') ||
    !/^CodeDirectory v=20400 size=\d+ flags=0x2\(adhoc\) hashes=\d+\+\d+ location=embedded$/.test(
      codeDirectory ?? '',
    ) ||
    !detailLines.has('Hash type=sha256 size=32') ||
    !detailLines.has('Hash choices=sha256') ||
    !detailLines.has('CMSDigestType=2') ||
    !detailLines.has('Executable Segment flags=0x1') ||
    !detailLines.has('Signature=adhoc') ||
    !detailLines.has('Info.plist=not bound') ||
    !detailLines.has('TeamIdentifier=not set') ||
    !detailLines.has('Sealed Resources=none') ||
    !detailLines.has('Internal requirements count=0 size=12')
  ) {
    return false;
  }

  const requirements = runCodesign(['--display', '--requirements', '-', path]);
  if (
    requirements.error ||
    requirements.status !== 0 ||
    !/^# designated => cdhash H"[0-9a-f]{40}" or cdhash H"[0-9a-f]{40}"\n$/i.test(
      requirements.stdout,
    )
  ) {
    return false;
  }

  const entitlements = runCodesign(['--display', '--entitlements', '-', path]);
  return (
    !entitlements.error &&
    entitlements.status === 0 &&
    entitlements.stdout.length === 0
  );
}

function commandOutput(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message || result.stderr.trim() || `${command} exited with ${result.status}`,
    );
  }
  return result.stdout.trim();
}

function resolveSdkPath() {
  const activeCompilerVersion = commandOutput(compiler, [
    '--sdk',
    'macosx',
    'clang',
    '--version',
  ]).split('\n')[0];
  if (activeCompilerVersion !== compilerVersion) {
    throw new Error(
      `build-darwin-process-birth-helper: expected ${compilerVersion}, received ${activeCompilerVersion}`,
    );
  }
  const activeSdkVersion = commandOutput(compiler, ['--sdk', 'macosx', '--show-sdk-version']);
  if (activeSdkVersion !== sdkVersion) {
    throw new Error(
      `build-darwin-process-birth-helper: expected macOS SDK ${sdkVersion}, received ${activeSdkVersion}`,
    );
  }
  return commandOutput(compiler, ['--sdk', 'macosx', '--show-sdk-path']);
}

function verifyPackagedHelper() {
  if (!existsSync(output) || !existsSync(manifestOutput)) {
    throw new Error('build-darwin-process-birth-helper: packaged helper provenance is missing');
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestOutput, 'utf8'));
  } catch {
    throw new Error('build-darwin-process-birth-helper: helper provenance is invalid');
  }
  if (manifest.sourceSha256 !== sha256(source)) {
    throw new Error('build-darwin-process-birth-helper: packaged helper source is stale');
  }
  if (manifest.recipeSha256 !== recipeSha256) {
    throw new Error('build-darwin-process-birth-helper: packaged helper recipe is stale');
  }
  if (manifest.binarySha256 !== sha256(readFileSync(output))) {
    throw new Error('build-darwin-process-birth-helper: packaged helper binary is stale');
  }
  if (manifest.stableBinarySha256 !== stableMachOSha256(output)) {
    throw new Error('build-darwin-process-birth-helper: packaged helper content is stale');
  }
  processMachOUuids(output, false);
  if (process.platform === 'darwin' && !hasExpectedCodeSignature(output)) {
    throw new Error('build-darwin-process-birth-helper: packaged helper signature is invalid');
  }
}

function stableMachOSha256(path) {
  const binary = Buffer.from(readFileSync(path));
  if (binary.readUInt32BE(0) !== 0xcafebabe) {
    throw new Error('build-darwin-process-birth-helper: expected a universal Mach-O helper');
  }
  const architectureCount = binary.readUInt32BE(4);
  for (let index = 0; index < architectureCount; index += 1) {
    const architectureOffset = 8 + index * 20;
    const sliceOffset = binary.readUInt32BE(architectureOffset + 8);
    const sliceSize = binary.readUInt32BE(architectureOffset + 12);
    if (binary.readUInt32LE(sliceOffset) !== 0xfeedfacf) {
      throw new Error('build-darwin-process-birth-helper: expected a 64-bit Mach-O slice');
    }
    const commandCount = binary.readUInt32LE(sliceOffset + 16);
    let commandOffset = sliceOffset + 32;
    let foundSignature = false;
    for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
      const command = binary.readUInt32LE(commandOffset);
      const commandSize = binary.readUInt32LE(commandOffset + 4);
      if (command === 0x1d && commandSize >= 16) {
        const signatureOffset = sliceOffset + binary.readUInt32LE(commandOffset + 8);
        const signatureSize = binary.readUInt32LE(commandOffset + 12);
        const signatureEnd = signatureOffset + signatureSize;
        if (
          signatureSize === 0 ||
          signatureOffset < sliceOffset ||
          signatureEnd > sliceOffset + sliceSize
        ) {
          throw new Error('build-darwin-process-birth-helper: invalid Mach-O signature');
        }
        binary.fill(0, signatureOffset, signatureEnd);
        foundSignature = true;
      }
      if (command === 0x32 && commandSize >= 24) {
        binary.writeUInt32LE(0, commandOffset + 16);
        const toolCount = binary.readUInt32LE(commandOffset + 20);
        if (commandSize < 24 + toolCount * 8) {
          throw new Error('build-darwin-process-birth-helper: invalid build-version command');
        }
        for (let toolIndex = 0; toolIndex < toolCount; toolIndex += 1) {
          binary.writeUInt32LE(0, commandOffset + 28 + toolIndex * 8);
        }
      }
      commandOffset += commandSize;
      if (commandOffset > sliceOffset + sliceSize) {
        throw new Error('build-darwin-process-birth-helper: invalid Mach-O load commands');
      }
    }
    if (!foundSignature) {
      throw new Error('build-darwin-process-birth-helper: missing Mach-O signature');
    }
  }
  return sha256(binary);
}

function processMachOUuids(path, shouldNormalize) {
  const binary = readFileSync(path);
  if (binary.readUInt32BE(0) !== 0xcafebabe) {
    throw new Error('build-darwin-process-birth-helper: expected a universal Mach-O helper');
  }
  const architectureCount = binary.readUInt32BE(4);
  for (let index = 0; index < architectureCount; index += 1) {
    const architectureOffset = 8 + index * 20;
    const cpuType = binary.readUInt32BE(architectureOffset);
    const sliceOffset = binary.readUInt32BE(architectureOffset + 8);
    const sliceSize = binary.readUInt32BE(architectureOffset + 12);
    if (binary.readUInt32LE(sliceOffset) !== 0xfeedfacf) {
      throw new Error('build-darwin-process-birth-helper: expected a 64-bit Mach-O slice');
    }
    const commandCount = binary.readUInt32LE(sliceOffset + 16);
    let commandOffset = sliceOffset + 32;
    let foundUuid = false;
    for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
      const command = binary.readUInt32LE(commandOffset);
      const commandSize = binary.readUInt32LE(commandOffset + 4);
      if (command === 0x1b && commandSize === 24) {
        const uuid = createHash('sha256')
          .update(recipeSha256)
          .update(String(cpuType))
          .digest()
          .subarray(0, 16);
        if (shouldNormalize) {
          uuid.copy(binary, commandOffset + 8);
        } else if (!binary.subarray(commandOffset + 8, commandOffset + 24).equals(uuid)) {
          throw new Error('build-darwin-process-birth-helper: packaged helper source is stale');
        }
        foundUuid = true;
      }
      commandOffset += commandSize;
      if (commandOffset > sliceOffset + sliceSize) {
        throw new Error('build-darwin-process-birth-helper: invalid Mach-O load commands');
      }
    }
    if (!foundUuid) {
      throw new Error('build-darwin-process-birth-helper: missing Mach-O UUID command');
    }
  }
  if (shouldNormalize) writeFileSync(path, binary);
}

if (process.platform !== 'darwin' || process.argv.includes('--verify-only')) {
  try {
    verifyPackagedHelper();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

const forceRebuild = process.argv.includes('--force-rebuild');
let packagedHelperCurrent = true;
try {
  verifyPackagedHelper();
} catch {
  packagedHelperCurrent = false;
}
if (packagedHelperCurrent && !forceRebuild) process.exit(0);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(temporarySource, source, { encoding: 'utf8', mode: 0o600 });
let sdkPath;
try {
  sdkPath = resolveSdkPath();
} catch (error) {
  rmSync(temporarySource, { force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const result = spawnSync(
  compiler,
  compilerArguments.map((argument) => {
    if (argument === '<source>') return temporarySource;
    if (argument === '<sdk>') return sdkPath;
    if (argument === '<output>') return temporaryOutput;
    return argument;
  }),
  {
    stdio: 'inherit',
  },
);
rmSync(temporarySource, { force: true });

if (result.error || result.status !== 0) {
  rmSync(temporaryOutput, { force: true });
  if (result.error) {
    console.error(`build-darwin-process-birth-helper: ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}

processMachOUuids(temporaryOutput, true);
const signResult = spawnSync(
  signer,
  signerArguments.map((argument) => (argument === '<output>' ? temporaryOutput : argument)),
  { stdio: 'inherit' },
);
if (signResult.error || signResult.status !== 0) {
  rmSync(temporaryOutput, { force: true });
  if (signResult.error) {
    console.error(`build-darwin-process-birth-helper: ${signResult.error.message}`);
  }
  process.exit(signResult.status ?? 1);
}

chmodSync(temporaryOutput, 0o755);
if (packagedHelperCurrent) {
  const manifest = JSON.parse(readFileSync(manifestOutput, 'utf8'));
  if (stableMachOSha256(temporaryOutput) !== manifest.stableBinarySha256) {
    rmSync(temporaryOutput, { force: true });
    console.error(
      'build-darwin-process-birth-helper: source rebuild does not match packaged helper',
    );
    process.exit(1);
  }
  rmSync(temporaryOutput, { force: true });
  verifyPackagedHelper();
  process.exit(0);
}
renameSync(temporaryOutput, output);
writeFileSync(
  manifestOutput,
  `${JSON.stringify(
    {
      sourceSha256: sha256(source),
      recipeSha256,
      stableBinarySha256: stableMachOSha256(output),
      binarySha256: sha256(readFileSync(output)),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
verifyPackagedHelper();
