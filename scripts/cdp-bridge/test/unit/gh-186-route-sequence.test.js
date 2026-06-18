// GH #186 P1: structural route-drift detection. A saved action records its
// expected route sequence; if the live flow inserts a screen (the report saw a
// CouponCode screen appear between HomeAddress and PhoneNumber), a selector
// failure should be classified as ROUTE_DRIFT — NOT SELECTOR_NOT_FOUND — so
// auto-repair doesn't waste a fuzzy-match cycle on a structural change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRouteSequenceAgainstGraph,
  classifyRouteDriftAfterFailure,
} from '../../dist/nav-graph/route-sequence.js';

const graph = (screens) => ({ meta: {}, navigators: [], all_screens: screens });

// ── pre-flight: expected screen missing from the graph (definite mismatch) ──

test('validateRouteSequenceAgainstGraph passes when every expected screen exists', () => {
  const r = validateRouteSequenceAgainstGraph(graph(['Home', 'HomeAddress', 'PhoneNumber']), [
    'HomeAddress',
    'PhoneNumber',
  ]);
  assert.equal(r.ok, true);
});

test('validateRouteSequenceAgainstGraph fails when an expected screen is gone (renamed/removed)', () => {
  const r = validateRouteSequenceAgainstGraph(graph(['Home', 'PhoneNumber']), [
    'HomeAddress',
    'PhoneNumber',
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['HomeAddress']);
});

test('validateRouteSequenceAgainstGraph does NOT false-positive on an empty/unknown graph', () => {
  assert.equal(validateRouteSequenceAgainstGraph(graph([]), ['HomeAddress']).ok, true);
  assert.equal(validateRouteSequenceAgainstGraph(null, ['HomeAddress']).ok, true);
});

test('validateRouteSequenceAgainstGraph is a no-op with no expected sequence', () => {
  assert.equal(validateRouteSequenceAgainstGraph(graph(['Home']), []).ok, true);
  assert.equal(validateRouteSequenceAgainstGraph(graph(['Home']), undefined).ok, true);
});

// ── post-failure: live route off the expected sequence (inserted screen) ──

test('classifyRouteDriftAfterFailure flags an inserted screen as drift', () => {
  const v = classifyRouteDriftAfterFailure({
    expectedSequence: ['HomeAddress', 'PhoneNumber'],
    liveRoute: 'CouponCode',
  });
  assert.equal(v.isDrift, true);
  assert.equal(v.liveRoute, 'CouponCode');
  assert.match(v.reason, /CouponCode/);
});

test('classifyRouteDriftAfterFailure does NOT flag drift when the live route is expected', () => {
  const v = classifyRouteDriftAfterFailure({
    expectedSequence: ['HomeAddress', 'PhoneNumber'],
    liveRoute: 'PhoneNumber',
  });
  assert.equal(v.isDrift, false);
});

test('classifyRouteDriftAfterFailure is conservative with no sequence / no live route', () => {
  assert.equal(
    classifyRouteDriftAfterFailure({ expectedSequence: [], liveRoute: 'X' }).isDrift,
    false,
  );
  assert.equal(
    classifyRouteDriftAfterFailure({ expectedSequence: ['A'], liveRoute: null }).isDrift,
    false,
  );
});
