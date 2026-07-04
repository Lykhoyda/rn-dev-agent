// scripts/cdp-bridge/test/unit/mirror-jpeg-stream.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JpegFrameExtractor,
  MAX_FRAME_BYTES,
} from '../../dist/observability/mirror/jpeg-stream.js';

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const jpeg = (fill, size = 16) => Buffer.concat([SOI, Buffer.alloc(size, fill), EOI]);

test('extracts a single complete frame from one chunk', () => {
  const x = new JpegFrameExtractor();
  const f = jpeg(1);
  const frames = x.push(f);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], f);
});

test('extracts back-to-back frames from one chunk', () => {
  const x = new JpegFrameExtractor();
  const a = jpeg(1);
  const b = jpeg(2);
  const frames = x.push(Buffer.concat([a, b]));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], a);
  assert.deepEqual(frames[1], b);
});

test('reassembles a frame split across chunks, including EOI split at the boundary', () => {
  const x = new JpegFrameExtractor();
  const f = jpeg(3, 64);
  // Split so the FF of the EOI ends chunk 1 and D9 starts chunk 2.
  const cut = f.length - 1;
  assert.deepEqual(x.push(f.subarray(0, cut)), []);
  const frames = x.push(f.subarray(cut));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], f);
});

test('reassembles a frame whose SOI is split across chunks', () => {
  const x = new JpegFrameExtractor();
  const f = jpeg(6, 32);
  // Chunk 1 ends with the SOI's 0xFF; chunk 2 starts with its 0xD8.
  assert.deepEqual(x.push(Buffer.concat([Buffer.from('noise'), f.subarray(0, 1)])), []);
  const frames = x.push(f.subarray(1));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], f);
});

test('discards garbage before SOI (multipart headers, ffmpeg noise)', () => {
  const x = new JpegFrameExtractor();
  const f = jpeg(4);
  const frames = x.push(
    Buffer.concat([Buffer.from('--boundary\r\nContent-Type: image/jpeg\r\n\r\n'), f]),
  );
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], f);
});

test('resets accumulator when a frame exceeds MAX_FRAME_BYTES without EOI', () => {
  const x = new JpegFrameExtractor();
  const oversized = Buffer.concat([SOI, Buffer.alloc(MAX_FRAME_BYTES, 0)]);
  assert.deepEqual(x.push(oversized), []);
  // After the reset a fresh well-formed frame must still come through.
  const f = jpeg(5);
  const frames = x.push(f);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], f);
});
