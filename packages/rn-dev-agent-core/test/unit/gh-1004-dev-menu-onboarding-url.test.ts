import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withDevMenuOnboardingDisabled } from '../../dist/session/dev-client-onboarding.js';

test('plain Metro URL gets disableOnboarding=1', () => {
  assert.equal(
    withDevMenuOnboardingDisabled('http://127.0.0.1:8341'),
    'http://127.0.0.1:8341/?disableOnboarding=1',
  );
});

test('dev-client deep link flags the inner url parameter', () => {
  const flagged = withDevMenuOnboardingDisabled(
    'example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8341',
  );
  const inner = new URL(flagged).searchParams.get('url');
  assert.equal(new URL(flagged).host, 'expo-development-client');
  assert.equal(inner, 'http://localhost:8341/?disableOnboarding=1');
  assert.equal(new URL(flagged).searchParams.has('disableOnboarding'), false);
});

test('already-flagged input is unchanged', () => {
  const once = withDevMenuOnboardingDisabled('http://10.0.2.2:8081/?a=b');
  assert.equal(withDevMenuOnboardingDisabled(once), once);
  const deepOnce = withDevMenuOnboardingDisabled(
    'exp+app://expo-development-client/?url=http%3A%2F%2F192.168.1.2%3A8081',
  );
  assert.equal(withDevMenuOnboardingDisabled(deepOnce), deepOnce);
});

test('existing query items are preserved', () => {
  const flagged = withDevMenuOnboardingDisabled('http://127.0.0.1:8341/?platform=ios&dev=true');
  const params = new URL(flagged).searchParams;
  assert.equal(params.get('platform'), 'ios');
  assert.equal(params.get('dev'), 'true');
  assert.equal(params.get('disableOnboarding'), '1');
});

test('unparsable input is returned untouched', () => {
  assert.equal(withDevMenuOnboardingDisabled('not a url'), 'not a url');
  assert.equal(withDevMenuOnboardingDisabled(''), '');
});
