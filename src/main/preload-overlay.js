const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureOverlay', {
  complete: (dataUrl) => ipcRenderer.invoke('overlay:complete', dataUrl),
  cancel: () => ipcRenderer.invoke('overlay:cancel'),
});
