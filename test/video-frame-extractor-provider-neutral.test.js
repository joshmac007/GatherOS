const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  buildFrameTimestamps,
  createVideoFrameExtractor,
  frameCountForDuration,
  jpegDataUrlToBuffer,
} = require('../src/main/video-frame-extractor');

test('frame sampling is bounded and evenly spaced', () => {
  assert.equal(frameCountForDuration(3), 6);
  assert.equal(frameCountForDuration(60), 9);
  assert.equal(frameCountForDuration(900), 12);
  const timestamps = buildFrameTimestamps(21);
  assert.equal(timestamps.length, 7);
  assert.equal(timestamps.every((value) => value > 0 && value < 21), true);
  assert.equal(new Set(timestamps).size, timestamps.length);
});

test('extractor captures every timestamp and closes session after failure', async () => {
  let closed = 0;
  let captures = 0;
  const extractor = createVideoFrameExtractor({
    adapter: {
      async open() {
        return {
          duration: 10,
          async captureFrame() {
            captures += 1;
            if (captures === 3) throw new Error('decode failed');
            return `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`;
          },
          async close() { closed += 1; },
        };
      },
    },
  });
  await assert.rejects(extractor.extract('/tmp/video.mp4'), /decode failed/);
  assert.equal(captures, 3);
  assert.equal(closed, 1);
});

test('JPEG parser rejects malformed or empty frame output', () => {
  assert.deepEqual(
    jpegDataUrlToBuffer(`data:image/jpeg;base64,${Buffer.from('frame').toString('base64')}`),
    Buffer.from('frame'),
  );
  assert.throws(() => jpegDataUrlToBuffer('data:image/png;base64,AA=='), /JPEG data URL/);
  assert.throws(() => jpegDataUrlToBuffer('data:image/jpeg;base64,'), /JPEG data URL/);
});

test('frame extractor has no external encoder or child-process dependency', () => {
  const source = fs.readFileSync(require.resolve('../src/main/video-frame-extractor'), 'utf8');
  assert.doesNotMatch(source, /ffmpeg|child_process|child-process/i);
});
