import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function ensureAndroidEnv(): void {
  if (!process.env.ANDROID_HOME) {
    if (process.env.ANDROID_SDK_ROOT) {
      process.env.ANDROID_HOME = process.env.ANDROID_SDK_ROOT;
    } else {
      const home = process.env.HOME ?? '';
      const candidates = [
        join(home, 'Library/Android/sdk'),
        join(home, 'Android/Sdk'),
        '/opt/android-sdk',
      ];
      for (const c of candidates) {
        if (existsSync(c)) { process.env.ANDROID_HOME = c; break; }
      }
    }
  }

  if (process.env.ANDROID_HOME) {
    const pt = join(process.env.ANDROID_HOME, 'platform-tools');
    const emu = join(process.env.ANDROID_HOME, 'emulator');
    const path = process.env.PATH ?? '';
    if (!path.includes(pt)) process.env.PATH = `${pt}:${path}`;
    if (!process.env.PATH!.includes(emu)) process.env.PATH = `${emu}:${process.env.PATH}`;
  }

  if (!process.env.ANDROID_SERIAL) {
    const serialFile = join(process.env.TMPDIR ?? '/tmp', 'rn-dev-agent-android-serial');
    if (existsSync(serialFile)) {
      process.env.ANDROID_SERIAL = readFileSync(serialFile, 'utf8').trim();
    }
  }
}

function ensureJavaEnv(): void {
  const path = process.env.PATH ?? '';
  if (path.split(':').some(p => existsSync(join(p, 'java')))) return;

  const candidates = ['/opt/homebrew/opt/openjdk@17', '/opt/homebrew/opt/openjdk'];
  for (const jdk of candidates) {
    if (existsSync(join(jdk, 'bin/java'))) {
      process.env.JAVA_HOME = jdk;
      process.env.PATH = `${jdk}/bin:${process.env.PATH}`;
      break;
    }
  }
}

function ensureCwd(): void {
  if (!process.env.CLAUDE_USER_CWD && process.env.PWD) {
    process.env.CLAUDE_USER_CWD = process.env.PWD;
  }
}

ensureAndroidEnv();
ensureJavaEnv();
ensureCwd();
