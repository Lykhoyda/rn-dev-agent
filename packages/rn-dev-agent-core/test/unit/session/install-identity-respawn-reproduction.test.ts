// QA F3 reproduction with owned disposable resources: a byte-identical
// reinstall of an iOS app container (fresh inodes/mtimes, identical bytes)
// keeps artifactDigest constant while installGeneration rotates — the exact
// drift observed live during PR #680 validation. The GH #705 digest proof
// re-stamps the receipt; one changed byte refuses.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  captureInstalledArtifact,
  captureInstallGeneration,
} from '../../../dist/session/install-authority.js';
import { inspectInstallIdentity } from '../../../dist/session/install-identity-inspection.js';
import { reissueInstallBinding } from '../../../dist/session/install-reissue.js';

const root = mkdtempSync(join(tmpdir(), 'rn-install-identity-'));
const container = join(root, 'TestApp.app');

after(() => rmSync(root, { recursive: true, force: true }));

const TARGET = { platform: 'ios' as const, deviceId: 'SIM-REPRO', appId: 'dev.example.repro' };

function installApp(files: Record<string, string>, epochSeconds: number): void {
  rmSync(container, { recursive: true, force: true });
  mkdirSync(container, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(container, name);
    writeFileSync(path, content);
    utimesSync(path, epochSeconds, epochSeconds);
  }
}

const APP_FILES = {
  'Info.plist': 'plist-bytes',
  TestApp: 'executable-bytes',
  'main.jsbundle': 'bundle-bytes',
};

// Injected stand-ins for `xcrun simctl get_app_container` and `plutil`; the
// directory walk, stat, and byte hashing below are the real implementations.
const runText = (command: string): string => {
  if (command === 'xcrun') return `${container}\n`;
  if (command === 'plutil') return 'TestApp\n';
  throw new Error(`unexpected command: ${command}`);
};
const dependencies = { runText };

test('a byte-identical reinstall rotates installGeneration but not artifactDigest', () => {
  installApp(APP_FILES, 1_700_000_000);
  const bound = captureInstalledArtifact(TARGET, dependencies);

  installApp(APP_FILES, 1_700_000_100);
  const reinstalled = captureInstalledArtifact(TARGET, dependencies);

  assert.equal(reinstalled.artifactDigest, bound.artifactDigest);
  assert.notEqual(reinstalled.installGeneration, bound.installGeneration);
  // The cheap axis-I check that hard-stopped the QA run:
  assert.notEqual(captureInstallGeneration(TARGET, dependencies), bound.installGeneration);
});

test('the digest proof re-stamps the receipt for the identical artifact', () => {
  installApp(APP_FILES, 1_700_000_000);
  const bound = captureInstalledArtifact(TARGET, dependencies);

  installApp(APP_FILES, 1_700_000_100);
  const reissued = reissueInstallBinding(
    { ...bound },
    { captureInstalled: (target) => captureInstalledArtifact(target, dependencies) },
  );

  assert.ok(reissued);
  assert.equal(reissued.artifactDigest, bound.artifactDigest);
  assert.equal(reissued.installGeneration, captureInstallGeneration(TARGET, dependencies));
});

test('one changed byte refuses the re-issue', () => {
  installApp(APP_FILES, 1_700_000_000);
  const bound = captureInstalledArtifact(TARGET, dependencies);

  installApp({ ...APP_FILES, 'main.jsbundle': 'bundle-bytes-changed' }, 1_700_000_100);

  assert.throws(
    () =>
      reissueInstallBinding(
        { ...bound },
        { captureInstalled: (target) => captureInstalledArtifact(target, dependencies) },
      ),
    /APP_INSTALL_IDENTITY_CHANGED/,
  );
});

test('inspectInstallIdentity reads verified, reissue-pending, and changed from disk truth', () => {
  installApp(APP_FILES, 1_700_000_000);
  const bound = captureInstalledArtifact(TARGET, dependencies);
  const inspectionDependencies = {
    captureGeneration: (target: typeof TARGET) => captureInstallGeneration(target, dependencies),
    captureInstalled: (target: typeof TARGET) => captureInstalledArtifact(target, dependencies),
  };

  assert.deepEqual(inspectInstallIdentity({ ...bound }, inspectionDependencies), {
    verdict: 'verified',
  });

  installApp(APP_FILES, 1_700_000_100);
  assert.deepEqual(inspectInstallIdentity({ ...bound }, inspectionDependencies), {
    verdict: 'reissue-pending',
  });

  installApp({ ...APP_FILES, TestApp: 'executable-bytes-v2' }, 1_700_000_200);
  assert.equal(inspectInstallIdentity({ ...bound }, inspectionDependencies)?.verdict, 'changed');

  rmSync(container, { recursive: true, force: true });
  assert.equal(inspectInstallIdentity({ ...bound }, inspectionDependencies)?.verdict, 'changed');
});
