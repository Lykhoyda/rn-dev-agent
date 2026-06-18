// test/unit/gh-206-recorder-pushlive.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../dist/observability/recorder.js';

test('pushLive stores latest frame + route and emits a {type:live} event, not a timeline event', () => {
  const rec = new Recorder();
  const got = [];
  rec.attach((ev) => got.push(ev));
  const buf = Buffer.from([0xff, 0xd8, 0xff]);

  rec.pushLive({ shot: { buf, contentType: 'image/jpeg' }, route: 'Home' });

  assert.equal(got.length, 1, 'one subscriber event');
  assert.equal(got[0].type, 'live');
  assert.equal(got[0].route, 'Home');
  assert.equal(typeof got[0].shotSeq, 'number');
  assert.equal(rec.snapshot().length, 0, 'live frames must NOT enter the timeline ring buffer');
  const live = rec.getLiveScreenshot();
  assert.deepEqual(live.buf, buf);
  assert.equal(live.contentType, 'image/jpeg');
});

test('pushLive increments shotSeq only when a shot is included; route-only push omits shotSeq', () => {
  const rec = new Recorder();
  const got = [];
  rec.attach((ev) => got.push(ev));
  rec.pushLive({ shot: { buf: Buffer.from([1]), contentType: 'image/jpeg' } });
  rec.pushLive({ route: 'Settings' });
  assert.equal(got[0].shotSeq, 1);
  assert.equal(got[1].shotSeq, undefined, 'route-only push has no new shot');
  assert.equal(got[1].route, 'Settings');
});

test('pushLive with neither shot nor route is a no-op (no event)', () => {
  const rec = new Recorder();
  const got = [];
  rec.attach((ev) => got.push(ev));
  rec.pushLive({});
  assert.equal(got.length, 0);
});

test('hasSubscribers reflects attach/detach', () => {
  const rec = new Recorder();
  assert.equal(rec.hasSubscribers(), false);
  const { detach } = rec.attach(() => {});
  assert.equal(rec.hasSubscribers(), true);
  detach();
  assert.equal(rec.hasSubscribers(), false);
});

test('clear() resets the live slot', () => {
  const rec = new Recorder();
  rec.attach(() => {});
  rec.pushLive({ shot: { buf: Buffer.from([1]), contentType: 'image/jpeg' } });
  rec.clear();
  assert.equal(rec.getLiveScreenshot(), undefined);
});

test('pushLive drops an oversized shot but still pushes the route', () => {
  const rec = new Recorder();
  const got = [];
  rec.attach((ev) => got.push(ev));
  const huge = Buffer.alloc(4_000_001); // > MAX_SHOT_BYTES
  rec.pushLive({ shot: { buf: huge, contentType: 'image/jpeg' }, route: 'Big' });
  assert.equal(rec.getLiveScreenshot(), undefined, 'oversized shot not stored');
  assert.equal(got.length, 1);
  assert.equal(got[0].shotSeq, undefined, 'no shotSeq when shot dropped');
  assert.equal(got[0].route, 'Big', 'route still delivered');
});
