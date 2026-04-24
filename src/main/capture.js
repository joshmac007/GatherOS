const { globalShortcut, BrowserWindow, desktopCapturer, screen, app } = require('electron');
const path = require('node:path');

const isDev = !app.isPackaged;
const DEV_URL = 'http://localhost:5173';

let overlayWin = null;
let _mainWindow = null;

function setMainWindow(win) {
  _mainWindow = win;
}

function registerCaptureHotkey() {
  globalShortcut.register('CommandOrControl+Shift+S', startScreenshotCapture);
}

function unregisterCaptureHotkey() {
  globalShortcut.unregisterAll();
}

async function startScreenshotCapture() {
  if (overlayWin) return;

  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  overlayWin = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    fullscreen: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Let the overlay renderer call getDisplayMedia() without a permission prompt.
  overlayWin.webContents.session.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0] });
    });
  });

  overlayWin.on('closed', () => { overlayWin = null; });

  if (isDev) {
    overlayWin.loadURL(`${DEV_URL}/overlay.html`);
  } else {
    overlayWin.loadFile(
      path.join(__dirname, '..', '..', 'dist', 'renderer', 'overlay.html'),
    );
  }
}

async function handleOverlayComplete(dataUrl) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close();
  }

  const { saveImageFromBase64 } = require('./storage');
  const { insertSave } = require('./db');

  try {
    const imgData = await saveImageFromBase64(dataUrl);
    const record = insertSave(imgData);
    if (_mainWindow && !_mainWindow.isDestroyed()) {
      _mainWindow.webContents.send('save:created', record);
    }
  } catch (err) {
    console.error('Failed to save screenshot:', err);
  }
}

function handleOverlayCancel() {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close();
  }
}

module.exports = {
  setMainWindow,
  registerCaptureHotkey,
  unregisterCaptureHotkey,
  startScreenshotCapture,
  handleOverlayComplete,
  handleOverlayCancel,
};
