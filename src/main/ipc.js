const { ipcMain } = require('electron');

function registerIpcHandlers() {
  ipcMain.handle('saves:get-all', () => []);
  ipcMain.handle('saves:update', () => ({ ok: true }));
  ipcMain.handle('saves:delete', () => ({ ok: true }));

  ipcMain.handle('collections:get-all', () => []);
  ipcMain.handle('collections:create', () => ({ ok: true }));
  ipcMain.handle('collections:add-save', () => ({ ok: true }));

  ipcMain.handle('capture:screenshot', () => ({ ok: false, reason: 'not-implemented' }));
  ipcMain.handle('image:open-in-preview', () => ({ ok: false, reason: 'not-implemented' }));
}

module.exports = { registerIpcHandlers };
