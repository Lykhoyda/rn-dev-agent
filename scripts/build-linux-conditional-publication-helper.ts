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
const outputDirectory = join(repoRoot, 'packages', 'rn-dev-agent-core', 'native');
const source = `typedef unsigned long u64;
typedef long i64;
typedef unsigned int u32;
typedef unsigned short u16;
typedef unsigned char u8;

struct statx_timestamp { i64 sec; u32 nsec; int reserved; };
struct statx {
  u32 mask; u32 block_size; u64 attributes; u32 links; u32 uid; u32 gid;
  u16 mode; u16 spare0; u64 ino; u64 size; u64 blocks; u64 attributes_mask;
  struct statx_timestamp atime; struct statx_timestamp btime;
  struct statx_timestamp ctime; struct statx_timestamp mtime;
  u32 rdev_major; u32 rdev_minor; u32 dev_major; u32 dev_minor;
  u64 mount_id; u32 dio_mem_align; u32 dio_offset_align; u64 spare3[12];
};

#define AT_FDCWD -100
#define AT_EMPTY_PATH 0x1000
#define AT_SYMLINK_NOFOLLOW 0x100
#define O_RDONLY 0
#define O_NOFOLLOW 0x20000
#define O_CLOEXEC 0x80000
#define RENAME_EXCHANGE 2
#define STATX_BASIC_STATS 0x7ff
#define S_IFMT 0170000
#define S_IFREG 0100000

#if defined(__x86_64__)
#define SYS_CLOSE 3
#define SYS_PREAD64 17
#define SYS_OPENAT 257
#define SYS_UNLINKAT 263
#define SYS_RENAMEAT2 316
#define SYS_STATX 332
static long syscall6(long number, long a1, long a2, long a3, long a4, long a5, long a6) {
  register long r10 __asm__("r10") = a4;
  register long r8 __asm__("r8") = a5;
  register long r9 __asm__("r9") = a6;
  long result;
  __asm__ volatile("syscall" : "=a"(result) : "a"(number), "D"(a1), "S"(a2),
                   "d"(a3), "r"(r10), "r"(r8), "r"(r9) : "rcx", "r11", "memory");
  return result;
}
__asm__(".global _start\\n_start:\\nmov (%rsp), %rdi\\nlea 8(%rsp), %rsi\\n"
        "call helper_main\\nmov %eax, %edi\\nmov $60, %eax\\nsyscall\\n");
#elif defined(__aarch64__)
#define SYS_CLOSE 57
#define SYS_PREAD64 67
#define SYS_OPENAT 56
#define SYS_UNLINKAT 35
#define SYS_RENAMEAT2 276
#define SYS_STATX 291
static long syscall6(long number, long a1, long a2, long a3, long a4, long a5, long a6) {
  register long x0 __asm__("x0") = a1;
  register long x1 __asm__("x1") = a2;
  register long x2 __asm__("x2") = a3;
  register long x3 __asm__("x3") = a4;
  register long x4 __asm__("x4") = a5;
  register long x5 __asm__("x5") = a6;
  register long x8 __asm__("x8") = number;
  __asm__ volatile("svc 0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x3), "r"(x4),
                   "r"(x5), "r"(x8) : "memory");
  return x0;
}
__asm__(".global _start\\n_start:\\nldr x0, [sp]\\nadd x1, sp, #8\\n"
        "bl helper_main\\nmov x8, #93\\nsvc #0\\n");
#else
#error unsupported architecture
#endif

static long call4(long number, long a1, long a2, long a3, long a4) {
  return syscall6(number, a1, a2, a3, a4, 0, 0);
}
static long call5(long number, long a1, long a2, long a3, long a4, long a5) {
  return syscall6(number, a1, a2, a3, a4, a5, 0);
}
static int regular(const struct statx *value) { return (value->mode & S_IFMT) == S_IFREG; }
static int same_file(const struct statx *left, const struct statx *right) {
  return left->ino == right->ino && left->dev_major == right->dev_major &&
      left->dev_minor == right->dev_minor;
}
static long open_read(const char *path) {
  return call4(SYS_OPENAT, AT_FDCWD, (long)path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC, 0);
}
static int descriptor_stat(long fd, struct statx *value) {
  char empty = 0;
  return call5(SYS_STATX, fd, (long)&empty, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
               STATX_BASIC_STATS, (long)value) == 0;
}
static int path_stat(const char *path, struct statx *value) {
  long fd = open_read(path);
  if (fd < 0) return 0;
  int ok = descriptor_stat(fd, value);
  syscall6(SYS_CLOSE, fd, 0, 0, 0, 0, 0);
  return ok;
}
static int equal_bytes(const u8 *left, const u8 *right, u64 size) {
  for (u64 index = 0; index < size; index++) if (left[index] != right[index]) return 0;
  return 1;
}
static int same_content(long left, long right) {
  struct statx left_stat;
  struct statx right_stat;
  if (!descriptor_stat(left, &left_stat) || !descriptor_stat(right, &right_stat) ||
      !regular(&left_stat) || !regular(&right_stat) || left_stat.size != right_stat.size) return 0;
  u8 left_buffer[4096];
  u8 right_buffer[4096];
  u64 offset = 0;
  while (offset < left_stat.size) {
    u64 wanted = left_stat.size - offset;
    if (wanted > sizeof(left_buffer)) wanted = sizeof(left_buffer);
    long left_read = call4(SYS_PREAD64, left, (long)left_buffer, wanted, offset);
    long right_read = call4(SYS_PREAD64, right, (long)right_buffer, wanted, offset);
    if (left_read <= 0 || right_read != left_read ||
        !equal_bytes(left_buffer, right_buffer, (u64)left_read)) return 0;
    offset += (u64)left_read;
  }
  return 1;
}

__attribute__((visibility("hidden"))) int helper_main(long argc, char **argv) {
  if (argc != 7) return 2;
  const char *target_path = argv[2];
  const char *candidate_path = argv[3];
  const char *expected_path = argv[4];
  long target = open_read(target_path);
  long candidate = open_read(candidate_path);
  long expected = open_read(expected_path);
  if (target < 0 || candidate < 0 || expected < 0) return 11;
  struct statx target_stat;
  struct statx candidate_stat;
  if (!descriptor_stat(target, &target_stat) || !descriptor_stat(candidate, &candidate_stat) ||
      !regular(&target_stat) || !regular(&candidate_stat) ||
      target_stat.dev_major != candidate_stat.dev_major ||
      target_stat.dev_minor != candidate_stat.dev_minor || !same_content(target, expected)) return 10;
  if (syscall6(SYS_RENAMEAT2, AT_FDCWD, (long)target_path, AT_FDCWD,
               (long)candidate_path, RENAME_EXCHANGE, 0) != 0) return 11;
  struct statx published_stat;
  struct statx displaced_stat;
  int target_is_candidate = path_stat(target_path, &published_stat) &&
      same_file(&published_stat, &candidate_stat);
  int candidate_has_expected = path_stat(candidate_path, &displaced_stat) &&
      same_file(&displaced_stat, &target_stat) && same_content(target, expected);
  if (!target_is_candidate) return 10;
  if (!candidate_has_expected) {
    if (syscall6(SYS_RENAMEAT2, AT_FDCWD, (long)target_path, AT_FDCWD,
                 (long)candidate_path, RENAME_EXCHANGE, 0) != 0) return 12;
    return 10;
  }
  if (call4(SYS_UNLINKAT, AT_FDCWD, (long)candidate_path, 0, 0) != 0) return 11;
  return 0;
}
`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const compiler = '/usr/bin/clang';
const compilerVersion = 'Apple clang version 21.0.0 (clang-2100.0.123.102)';
const compilerArguments = [
  '-target',
  '<target>',
  '-x',
  'c',
  '<source>',
  '-c',
  '-Os',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-ffreestanding',
  '-fno-builtin',
  '-fno-stack-protector',
  '-fno-asynchronous-unwind-tables',
  '-fno-unwind-tables',
  '-fno-exceptions',
  '-o',
  '<output>',
];
const architectures = {
  x64: { target: 'x86_64-linux-gnu', elfMachine: 62 },
  arm64: { target: 'aarch64-linux-gnu', elfMachine: 183 },
};

function recipeSha256(settings) {
  return sha256(
    JSON.stringify({
      sourceSha256: sha256(source),
      compiler,
      compilerVersion,
      compilerArguments,
      target: settings.target,
      elfFormat: 'single-rx-segment-v1',
    }),
  );
}
function outputFor(architecture) {
  return join(outputDirectory, `linux-conditional-publication-${architecture}`);
}
function manifestFor(architecture) {
  return `${outputFor(architecture)}.json`;
}

function section(binary, name) {
  const sectionOffset = Number(binary.readBigUInt64LE(40));
  const sectionSize = binary.readUInt16LE(58);
  const sectionCount = binary.readUInt16LE(60);
  const namesIndex = binary.readUInt16LE(62);
  const header = (index) => sectionOffset + index * sectionSize;
  const namesHeader = header(namesIndex);
  const namesOffset = Number(binary.readBigUInt64LE(namesHeader + 24));
  for (let index = 0; index < sectionCount; index++) {
    const offset = header(index);
    const nameOffset = namesOffset + binary.readUInt32LE(offset);
    let end = nameOffset;
    while (binary[end] !== 0) end++;
    if (binary.toString('utf8', nameOffset, end) !== name) continue;
    return {
      index,
      header: offset,
      offset: Number(binary.readBigUInt64LE(offset + 24)),
      size: Number(binary.readBigUInt64LE(offset + 32)),
      link: binary.readUInt32LE(offset + 40),
      entrySize: Number(binary.readBigUInt64LE(offset + 56)),
    };
  }
  throw new Error(`missing ${name} section`);
}

function executableFromObject(path, expectedMachine) {
  const object = readFileSync(path);
  if (object.readUInt16LE(18) !== expectedMachine)
    throw new Error('unexpected object architecture');
  const text = section(object, '.text');
  const code = Buffer.from(object.subarray(text.offset, text.offset + text.size));
  for (const name of ['.rela.text', '.rel.text']) {
    try {
      const relocations = section(object, name);
      if (name === '.rel.text' && relocations.size !== 0) throw new Error(`unsupported ${name}`);
      const sectionOffset = Number(object.readBigUInt64LE(40));
      const sectionSize = object.readUInt16LE(58);
      const symbolHeader = sectionOffset + relocations.link * sectionSize;
      const symbolOffset = Number(object.readBigUInt64LE(symbolHeader + 24));
      const symbolEntrySize = Number(object.readBigUInt64LE(symbolHeader + 56));
      for (let offset = 0; offset < relocations.size; offset += relocations.entrySize) {
        const relocation = relocations.offset + offset;
        const place = Number(object.readBigUInt64LE(relocation));
        const info = object.readBigUInt64LE(relocation + 8);
        const symbolIndex = Number(info >> 32n);
        const type = Number(info & 0xffffffffn);
        const addend = Number(object.readBigInt64LE(relocation + 16));
        const symbol = symbolOffset + symbolIndex * symbolEntrySize;
        const value = Number(object.readBigUInt64LE(symbol + 8));
        const displacement = value + addend - place;
        if (expectedMachine === 62 && type === 4) {
          code.writeInt32LE(displacement, place);
        } else if (expectedMachine === 183 && type === 283 && displacement % 4 === 0) {
          const instruction = code.readUInt32LE(place);
          code.writeUInt32LE(
            ((instruction & 0xfc000000) | ((displacement >> 2) & 0x03ffffff)) >>> 0,
            place,
          );
        } else {
          throw new Error(`unsupported ELF relocation ${type}`);
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('missing ')) throw error;
    }
  }
  const codeOffset = 0x1000;
  const base = 0x400000;
  const executable = Buffer.alloc(codeOffset + code.length);
  executable.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  executable.writeUInt16LE(2, 16);
  executable.writeUInt16LE(expectedMachine, 18);
  executable.writeUInt32LE(1, 20);
  executable.writeBigUInt64LE(BigInt(base + codeOffset), 24);
  executable.writeBigUInt64LE(64n, 32);
  executable.writeUInt16LE(64, 52);
  executable.writeUInt16LE(56, 54);
  executable.writeUInt16LE(1, 56);
  executable.writeUInt32LE(1, 64);
  executable.writeUInt32LE(5, 68);
  executable.writeBigUInt64LE(BigInt(base), 80);
  executable.writeBigUInt64LE(BigInt(base), 88);
  executable.writeBigUInt64LE(BigInt(executable.length), 96);
  executable.writeBigUInt64LE(BigInt(executable.length), 104);
  executable.writeBigUInt64LE(0x1000n, 112);
  code.copy(executable, codeOffset);
  return executable;
}

function verifyPackagedHelper(architecture, settings) {
  const output = outputFor(architecture);
  const manifestPath = manifestFor(architecture);
  if (!existsSync(output) || !existsSync(manifestPath))
    throw new Error(`missing ${architecture} helper`);
  const binary = readFileSync(output);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.sourceSha256 !== sha256(source) ||
    manifest.recipeSha256 !== recipeSha256(settings) ||
    manifest.binarySha256 !== sha256(binary) ||
    binary.readUInt32BE(0) !== 0x7f454c46 ||
    binary[4] !== 2 ||
    binary[5] !== 1 ||
    binary.readUInt16LE(18) !== settings.elfMachine
  ) {
    throw new Error(`stale ${architecture} helper`);
  }
}

const forceRebuild = process.argv.includes('--force-rebuild');
if (!forceRebuild) {
  try {
    for (const [architecture, settings] of Object.entries(architectures))
      verifyPackagedHelper(architecture, settings);
  } catch (error) {
    console.error(
      `build-linux-conditional-publication-helper: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

mkdirSync(outputDirectory, { recursive: true });
for (const [architecture, settings] of Object.entries(architectures)) {
  const output = outputFor(architecture);
  const sourcePath = `${output}.c.tmp-${process.pid}`;
  const objectPath = `${output}.o.tmp-${process.pid}`;
  const temporaryOutput = `${output}.tmp-${process.pid}`;
  writeFileSync(sourcePath, source, { encoding: 'utf8', mode: 0o600 });
  const result = spawnSync(
    compiler,
    compilerArguments.map((argument) => {
      if (argument === '<target>') return settings.target;
      if (argument === '<source>') return sourcePath;
      if (argument === '<output>') return objectPath;
      return argument;
    }),
    { stdio: 'inherit' },
  );
  rmSync(sourcePath, { force: true });
  if (result.error || result.status !== 0) {
    rmSync(objectPath, { force: true });
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
  writeFileSync(temporaryOutput, executableFromObject(objectPath, settings.elfMachine));
  rmSync(objectPath, { force: true });
  chmodSync(temporaryOutput, 0o755);
  renameSync(temporaryOutput, output);
  writeFileSync(
    manifestFor(architecture),
    `${JSON.stringify(
      {
        sourceSha256: sha256(source),
        recipeSha256: recipeSha256(settings),
        binarySha256: sha256(readFileSync(output)),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  verifyPackagedHelper(architecture, settings);
}
