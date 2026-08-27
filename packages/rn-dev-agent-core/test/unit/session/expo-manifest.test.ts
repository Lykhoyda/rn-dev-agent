import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExpoManifestBody } from '../../../dist/session/expo-manifest.js';

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

test('manifest parsing is diagnostic-only for loopback and physical LAN launch assets', () => {
  for (const url of [
    'http://127.0.0.1:8081/index.ts.bundle?platform=ios&dev=true',
    'http://192.168.1.20:8081/index.ts.bundle?platform=android&dev=true',
  ]) {
    for (const body of [manifest(url), multipartManifest(url)]) {
      const parsed = parseExpoManifestBody(body);
      assert.equal((parsed?.launchAsset as { url?: string })?.url, url);
      assert.equal(parsed?.runtimeVersion, '1.0.0');
    }
  }
});

test('malformed manifest bodies remain non-authoritative diagnostics', () => {
  for (const body of [
    'packager-status:running',
    '<!DOCTYPE html><html></html>',
    JSON.stringify({ launchAsset: { key: 'bundle' } }),
    JSON.stringify([{ launchAsset: { url: 'http://127.0.0.1:8081/index.bundle' } }]),
    '',
  ]) {
    assert.equal(parseExpoManifestBody(body), null);
  }
});
