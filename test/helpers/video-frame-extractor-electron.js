const crypto = require('node:crypto');
const { app, BrowserWindow } = require('electron');
const sharp = require('sharp');

const {
  createElectronBrowserWindowAdapter,
  createVideoFrameExtractor,
} = require('../../src/main/video-frame-extractor');

async function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) throw new Error('MP4 fixture path is required');
  await app.whenReady();
  app.dock?.hide();
  const extractor = createVideoFrameExtractor({
    adapter: createElectronBrowserWindowAdapter({ BrowserWindow }),
  });
  const result = await extractor.extract(fixturePath);
  const metadata = await Promise.all(result.frames.map((frame) => sharp(frame).metadata()));
  const hashes = result.frames.map((frame) => crypto.createHash('sha256').update(frame).digest('hex'));
  process.stdout.write(`VIDEO_RESULT=${JSON.stringify({
    duration: result.duration,
    frameCount: result.frames.length,
    uniqueFrames: new Set(hashes).size,
    maxWidth: Math.max(...metadata.map((item) => item.width || 0)),
    maxHeight: Math.max(...metadata.map((item) => item.height || 0)),
  })}\n`);
}

main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    app.exit(1);
  });
