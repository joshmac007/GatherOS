// Capture a webpage as a screenshot for URL-kind saves. Spawns a
// hidden BrowserWindow at a fixed viewport, navigates to the URL,
// waits for did-finish-load + a settle delay so dynamic content has
// a chance to render, calls capturePage() to get the bitmap, then
// runs it through the same saveImageFromBuffer pipeline that real
// image saves use — same dedupe (content hash), palette, and
// thumb-path handling, just sourced from a screenshot instead of
// a remote URL or dropped file.
//
// Returns the same shape saveImageFromBuffer returns:
//   { filePath, thumbPath, width, height, fileSize, palette,
//     contentHash, duplicateOf?, existing? }
// plus a `title` field pulled out of the rendered DOM.

const { BrowserWindow } = require('electron');
const { saveImageFromBuffer } = require('./storage');
const { throwIfCancelled } = require('./save-cancellation');

// Viewport size for the capture. 16:9-ish at a desktop-typical
// breakpoint — wide enough that most responsive layouts pick the
// desktop variant, not so wide that nothing fits in the screenshot.
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 800;
// How long to wait after did-finish-load before snapping. Page
// frameworks (React, Vue, etc.) typically settle within a second of
// the load event, so 1500ms is comfortable without being slow.
const SETTLE_MS = 1500;
// Hard ceiling so a never-loading page doesn't strand the capture
// indefinitely.
const LOAD_TIMEOUT_MS = 20000;

async function captureUrl(url, { signal, onCreated } = {}) {
  throwIfCancelled(signal);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Only http(s) URLs are supported');
  }
  const win = new BrowserWindow({
    show: false,
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    webPreferences: {
      // Don't pull in this app's preload bridge in the captured
      // page — there's nothing for the host page to do with our
      // IPCs, and the bridge would leak `moodmark` into every
      // captured site's window.
      preload: undefined,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // No persistent session — every capture starts fresh, no
      // cookies bleeding across saves.
      partition: 'persist:url-capture',
    },
  });

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const onLoad = () => {
        if (settled) return;
        settled = true;
        // Give the page a moment to finish JS-driven layout / image
        // decoding before snapping.
        setTimeout(resolve, SETTLE_MS);
      };
      const onFail = (_e, code, desc) => {
        if (settled) return;
        settled = true;
        reject(new Error(`load failed: ${desc} (${code})`));
      };
      win.webContents.once('did-finish-load', onLoad);
      win.webContents.once('did-fail-load', onFail);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('load timed out'));
      }, LOAD_TIMEOUT_MS);
      win.loadURL(url).catch(reject);
    });
    throwIfCancelled(signal);

    // Pull the page title before capturing — saves the user from
    // editing it manually for the common case.
    let title = '';
    try {
      title = await win.webContents.executeJavaScript(
        'document.title || ""',
        true,
      );
    } catch { /* non-fatal — leave title empty */ }

    const image = await win.webContents.capturePage();
    throwIfCancelled(signal);
    const buffer = image.toJPEG(85);
    const imgData = await saveImageFromBuffer(buffer, 'jpg', { signal, onCreated });

    return { ...imgData, title: typeof title === 'string' ? title.trim() : '' };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { captureUrl };
