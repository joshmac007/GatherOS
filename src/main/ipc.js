const { ipcMain, shell } = require('electron');
const { getAllSaves, deleteSave, updateSave } = require('./db');
const { deleteImageFiles, saveImageFromFile } = require('./storage');
const { insertSave } = require('./db');
const { handleOverlayComplete, handleOverlayCancel, startScreenshotCapture } = require('./capture');

function registerIpcHandlers() {
  ipcMain.handle('saves:get-all', (_e, opts) => getAllSaves(opts));

  ipcMain.handle('saves:delete', (_e, id) => {
    const result = deleteSave(id);
    if (result.ok) deleteImageFiles(result.filePath, result.thumbPath);
    return result;
  });

  ipcMain.handle('saves:update', (_e, payload) => updateSave(payload));

  ipcMain.handle('saves:drop-file', async (_e, filePath) => {
    const imgData = await saveImageFromFile(filePath);
    return insertSave(imgData);
  });

  ipcMain.handle('collections:get-all', () => []);
  ipcMain.handle('collections:create', () => ({ ok: true }));
  ipcMain.handle('collections:add-save', () => ({ ok: true }));

  ipcMain.handle('capture:screenshot', () => {
    startScreenshotCapture();
    return { ok: true };
  });

  ipcMain.handle('overlay:complete', (_e, dataUrl) => {
    handleOverlayComplete(dataUrl);
    return { ok: true };
  });

  ipcMain.handle('overlay:cancel', () => {
    handleOverlayCancel();
    return { ok: true };
  });

  ipcMain.handle('image:open-in-preview', (_e, filePath) => {
    shell.openPath(filePath);
    return { ok: true };
  });
}

module.exports = { registerIpcHandlers };
