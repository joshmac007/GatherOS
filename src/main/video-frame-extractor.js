const { pathToFileURL } = require('node:url');
const path = require('node:path');

function assertDuration(duration) {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Video duration must be a positive finite number');
  }
}

function frameCountForDuration(duration) {
  assertDuration(duration);
  if (duration < 15) return 6;
  if (duration < 30) return 7;
  if (duration < 60) return 8;
  if (duration < 120) return 9;
  if (duration < 300) return 10;
  if (duration < 600) return 11;
  return 12;
}

function buildFrameTimestamps(duration) {
  assertDuration(duration);
  const count = frameCountForDuration(duration);
  return Array.from({ length: count }, (_, index) => (
    Number((((index + 1) * duration) / (count + 1)).toFixed(6))
  ));
}

function boundedFrameDimensions(width, height, { maxWidth = 960, maxHeight = 540 } = {}) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('Video frame dimensions must be positive finite numbers');
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function jpegDataUrlToBuffer(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('Frame capture did not return a JPEG data URL');
  const match = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Frame capture did not return a JPEG data URL');
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length === 0) throw new Error('Frame capture returned an empty JPEG');
  return buffer;
}

function createVideoFrameExtractor({ adapter } = {}) {
  if (!adapter || typeof adapter.open !== 'function') {
    throw new TypeError('Video frame extractor requires an adapter');
  }

  return {
    async extract(videoPath) {
      const session = await adapter.open(videoPath);
      if (!session || typeof session.captureFrame !== 'function') {
        throw new Error('Video adapter did not return a capture session');
      }
      try {
        const duration = Number(session.duration);
        const timestamps = buildFrameTimestamps(duration);
        const frames = [];
        for (const timestamp of timestamps) {
          frames.push(jpegDataUrlToBuffer(await session.captureFrame(timestamp)));
        }
        return { duration, timestamps, frames };
      } finally {
        if (typeof session.close === 'function') await session.close();
      }
    },
  };
}

function metadataScript() {
  return `(() => new Promise((resolve, reject) => {
    const video = document.querySelector('video');
    if (!video) { reject(new Error('Video element unavailable')); return; }
    const finish = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) resolve(video.duration);
      else reject(new Error('Video duration unavailable'));
    };
    if (video.readyState >= 1) { finish(); return; }
    const timer = setTimeout(() => reject(new Error('Timed out loading video metadata')), 15000);
    video.addEventListener('loadedmetadata', () => { clearTimeout(timer); finish(); }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Video decode failed')); }, { once: true });
  }))()`;
}

function captureScript(timestamp, quality, maxWidth, maxHeight) {
  return `(() => new Promise((resolve, reject) => {
    const video = document.querySelector('video');
    if (!video) { reject(new Error('Video element unavailable')); return; }
    const requestedTime = ${JSON.stringify(timestamp)};
    const draw = () => {
      try {
        const maxWidth = ${JSON.stringify(maxWidth)};
        const maxHeight = ${JSON.stringify(maxHeight)};
        const scale = Math.min(1, maxWidth / video.videoWidth, maxHeight / video.videoHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        if (!canvas.width || !canvas.height) throw new Error('Video frame dimensions unavailable');
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', ${JSON.stringify(quality)}));
      } catch (error) { reject(error); }
    };
    if (Math.abs(video.currentTime - requestedTime) < 0.001 && video.readyState >= 2) {
      draw();
      return;
    }
    const timer = setTimeout(() => reject(new Error('Timed out seeking video frame')), 15000);
    video.addEventListener('seeked', () => { clearTimeout(timer); draw(); }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Video decode failed')); }, { once: true });
    video.currentTime = Math.min(requestedTime, Math.max(0, video.duration - 0.001));
  }))()`;
}

function createElectronBrowserWindowAdapter({
  BrowserWindow,
  jpegQuality = 0.82,
  maxWidth = 960,
  maxHeight = 540,
} = {}) {
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('Electron BrowserWindow constructor is required');
  }

  return {
    async open(videoPath) {
      const window = new BrowserWindow({
        show: false,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          offscreen: true,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      try {
        await window.loadURL(pathToFileURL(path.join(__dirname, 'video-frame-extractor.html')).href);
        const videoUrl = pathToFileURL(videoPath).href;
        await window.webContents.executeJavaScript(`(() => {
          const video = document.querySelector('video');
          if (!video) throw new Error('Video element unavailable');
          video.src = ${JSON.stringify(videoUrl)};
          video.load();
          return true;
        })()`, true);
        const duration = Number(await window.webContents.executeJavaScript(metadataScript(), true));
        assertDuration(duration);
        return {
          duration,
          captureFrame(timestamp) {
            return window.webContents.executeJavaScript(
              captureScript(timestamp, jpegQuality, maxWidth, maxHeight),
              true,
            );
          },
          async close() {
            if (!window.isDestroyed()) window.destroy();
          },
        };
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    },
  };
}

function createDefaultVideoFrameExtractor() {
  const { BrowserWindow } = require('electron');
  return createVideoFrameExtractor({
    adapter: createElectronBrowserWindowAdapter({ BrowserWindow }),
  });
}

module.exports = {
  boundedFrameDimensions,
  buildFrameTimestamps,
  createDefaultVideoFrameExtractor,
  createElectronBrowserWindowAdapter,
  createVideoFrameExtractor,
  frameCountForDuration,
  jpegDataUrlToBuffer,
};
