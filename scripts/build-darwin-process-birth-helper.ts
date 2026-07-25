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

const compiler = '/usr/bin/clang';
const compilerArguments = [
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
    compilerArguments,
    uuidScheme: 'sha256-recipe-cputype-v1',
    signer,
    signerArguments,
  }),
);

function hasValidCodeSignature(path) {
  const result = spawnSync(signer, ['--verify', '--strict', path], {
    stdio: 'ignore',
  });
  return !result.error && result.status === 0;
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
  if (process.platform === 'darwin' && !hasValidCodeSignature(output)) {
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

mkdirSync(dirname(output), { recursive: true });
writeFileSync(temporarySource, source, { encoding: 'utf8', mode: 0o600 });
const result = spawnSync(
  compiler,
  compilerArguments.map((argument) => {
    if (argument === '<source>') return temporarySource;
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
let retainPackagedBinary = false;
if (existsSync(output)) {
  try {
    retainPackagedBinary =
      hasValidCodeSignature(output) &&
      stableMachOSha256(output) === stableMachOSha256(temporaryOutput);
  } catch {
    retainPackagedBinary = false;
  }
}
if (retainPackagedBinary) {
  rmSync(temporaryOutput);
} else {
  renameSync(temporaryOutput, output);
}
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
