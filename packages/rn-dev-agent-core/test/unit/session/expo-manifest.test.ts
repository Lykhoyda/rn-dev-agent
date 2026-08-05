import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseExpoManifestBody,
  verifyManagedManifestLaunchAsset,
} from '../../../dist/session/expo-manifest.js';

const endpoint = { host: '127.0.0.1', port: 8081 };

function manifest(url: string): string {
  return JSON.stringify({
    id: 'a4f0d2c6-0000-4000-8000-000000000000',
    runtimeVersion: '1.0.0',
    launchAsset: { key: 'bundle', contentType: 'application/javascript', url },
  });
}

function multipartManifest(url: string): string {
  const boundary = '------formdata-rn-dev-agent';
  return [
    boundary,
    'Content-Disposition: form-data; name="manifest"; filename="manifest"',
    'Content-Type: application/json',
    '',
    manifest(url),
    `${boundary}--`,
    '',
  ].join('\r\n');
}

test('exact managed launch assets are accepted from JSON and multipart manifests', () => {
  const url = 'http://127.0.0.1:8081/index.ts.bundle?platform=ios&dev=true';
  for (const body of [manifest(url), multipartManifest(url)]) {
    const verified = verifyManagedManifestLaunchAsset(body, endpoint);
    assert.equal(verified?.bundleUrl, url);
    assert.equal(verified?.runtimeVersion, '1.0.0');
  }
});

test('launch assets served from another endpoint are refused', () => {
  for (const url of [
    'http://127.0.0.1:8082/index.bundle',
    'http://192.168.1.20:8081/index.bundle',
    'http://127.0.0.1/index.bundle',
    'https://cdn.example.test:8081/index.bundle',
    'http://user:secret@127.0.0.1:8081/index.bundle',
    'file:///tmp/index.bundle',
    '/index.bundle',
  ]) {
    assert.throws(
      () => verifyManagedManifestLaunchAsset(manifest(url), endpoint),
      /METRO_MANIFEST_ENDPOINT_MISMATCH/,
      `expected ${url} to be refused`,
    );
  }
});

test('non-Expo responses are reported as absent rather than refused', () => {
  for (const body of [
    'packager-status:running',
    '<!DOCTYPE html><html></html>',
    JSON.stringify({ launchAsset: { key: 'bundle' } }),
    JSON.stringify([{ launchAsset: { url: 'http://127.0.0.1:8081/index.bundle' } }]),
    '',
  ]) {
    assert.equal(parseExpoManifestBody(body), null);
    assert.equal(verifyManagedManifestLaunchAsset(body, endpoint), null);
  }
});
