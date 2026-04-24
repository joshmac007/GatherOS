const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moodmark', {
  saves: {
    getAll: (opts) => ipcRenderer.invoke('saves:get-all', opts ?? {}),
    update: (payload) => ipcRenderer.invoke('saves:update', payload),
    delete: (id) => ipcRenderer.invoke('saves:delete', id),
    dropFile: (filePath) => ipcRenderer.invoke('saves:drop-file', filePath),
  },
  collections: {
    getAll: () => ipcRenderer.invoke('collections:get-all'),
    create: (payload) => ipcRenderer.invoke('collections:create', payload),
    addSave: (payload) => ipcRenderer.invoke('collections:add-save', payload),
  },
  capture: {
    screenshot: () => ipcRenderer.invoke('capture:screenshot'),
  },
  image: {
    openInPreview: (filePath) => ipcRenderer.invoke('image:open-in-preview', filePath),
  },
  on: (channel, listener) => {
    const allowed = new Set(['save:created', 'update-ready']);
    if (!allowed.has(channel)) return () => {};
    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
