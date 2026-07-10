const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFrameTimestamps,
  createElectronBrowserWindowAdapter,
  createVideoFrameExtractor,
  frameCountForDuration,
} = require('../src/main/video-frame-extractor');

test('duration bands deterministically select 6 through 12 interior frames', () => {
  const bands = [
    [8, 6],
    [20, 7],
    [45, 8],
    [90, 9],
    [240, 10],
    [480, 11],
    [900, 12],
  ];

  for (const [duration, expectedCount] of bands) {
    assert.equal(frameCountForDuration(duration), expectedCount);
    const timestamps = buildFrameTimestamps(duration);
    assert.equal(timestamps.length, expectedCount);
    assert.equal(timestamps.every((timestamp) => timestamp > 0 && timestamp < duration), true);
    assert.deepEqual(timestamps, buildFrameTimestamps(duration));
    assert.equal(new Set(timestamps).size, timestamps.length);
  }
});

test('rejects missing and non-finite video durations', () => {
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => buildFrameTimestamps(duration), /duration/i);
  }
});

test('extractor uses injected adapter and converts JPEG data URLs to buffers', async () => {
  const calls = [];
  let closed = false;
  const adapter = {
    async open(videoPath) {
      calls.push(['open', videoPath]);
      return {
        duration: 45,
        async captureFrame(timestamp) {
          calls.push(['capture', timestamp]);
          return `data:image/jpeg;base64,${Buffer.from(`frame:${timestamp}`).toString('base64')}`;
        },
        async close() { closed = true; },
      };
    },
  };
  const extractor = createVideoFrameExtractor({ adapter });

  const result = await extractor.extract('/tmp/example.mp4');

  assert.equal(result.duration, 45);
  assert.deepEqual(result.timestamps, buildFrameTimestamps(45));
  assert.equal(result.frames.length, 8);
  assert.equal(result.frames.every(Buffer.isBuffer), true);
  assert.equal(result.frames[0].toString(), `frame:${result.timestamps[0]}`);
  assert.equal(calls.filter(([kind]) => kind === 'capture').length, 8);
  assert.equal(closed, true);
});

test('extractor closes adapter session after a capture failure', async () => {
  let closed = false;
  const extractor = createVideoFrameExtractor({
    adapter: {
      async open() {
        return {
          duration: 20,
          async captureFrame() { throw new Error('decode failed'); },
          async close() { closed = true; },
        };
      },
    },
  });

  await assert.rejects(extractor.extract('/tmp/broken.mp4'), /decode failed/);
  assert.equal(closed, true);
});

test('Electron adapter opens local MP4 offscreen and captures canvas JPEG data URLs', async () => {
  const windows = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.loaded = null;
      this.destroyed = false;
      this.executeCount = 0;
      this.webContents = {
        executeJavaScript: async () => {
          this.executeCount += 1;
          if (this.executeCount === 1) return 24;
          return `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`;
        },
      };
      windows.push(this);
    }

    async loadURL(url) { this.loaded = url; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const adapter = createElectronBrowserWindowAdapter({ BrowserWindow: FakeBrowserWindow });

  const session = await adapter.open('/tmp/My Video.mp4');
  const dataUrl = await session.captureFrame(3.5);
  await session.close();

  assert.equal(windows.length, 1);
  assert.equal(windows[0].options.show, false);
  assert.equal(windows[0].options.webPreferences.offscreen, true);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.match(windows[0].loaded, /^file:\/\/\/tmp\/My%20Video\.mp4$/);
  assert.equal(session.duration, 24);
  assert.match(dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(windows[0].destroyed, true);
});

test('frame extractor has no FFmpeg or child-process dependency', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/main/video-frame-extractor'), 'utf8');
  assert.doesNotMatch(source, /ffmpeg|child_process|child-process/i);
});
