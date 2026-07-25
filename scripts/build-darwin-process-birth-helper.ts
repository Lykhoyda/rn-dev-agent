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
const output = join(
  repoRoot,
  'packages',
  'rn-dev-agent-core',
  'native',
  'darwin-process-birth',
);
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

function normalizeMachOUuids(path) {
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
          .update(source)
          .update(String(cpuType))
          .digest()
          .subarray(0, 16);
        uuid.copy(binary, commandOffset + 8);
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
  writeFileSync(path, binary);
}

if (process.platform !== 'darwin') {
  if (!existsSync(output)) {
    console.error(`build-darwin-process-birth-helper: missing packaged helper at ${output}`);
    process.exit(1);
  }
  process.exit(0);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(temporarySource, source, { encoding: 'utf8', mode: 0o600 });
const result = spawnSync(
  '/usr/bin/clang',
  [
    '-x',
    'c',
    temporarySource,
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
    temporaryOutput,
  ],
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

normalizeMachOUuids(temporaryOutput);
const signResult = spawnSync(
  '/usr/bin/codesign',
  [
    '--force',
    '--sign',
    '-',
    '--identifier',
    'dev.rn-dev-agent.process-birth',
    temporaryOutput,
  ],
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
renameSync(temporaryOutput, output);
