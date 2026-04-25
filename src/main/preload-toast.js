const { contextBridge, ipcRenderer } = require('electron');

let listener = null;
const buffer = [];

ipcRenderer.on('toast:show', (_e, record) => {
  if (listener) listener(record);
  else buffer.push(record);
});

contextBridge.exposeInMainWorld('toast', {
  onShow: (fn) => {
    listener = fn;
    while (buffer.length) fn(buffer.shift());
    return () => { listener = null; };
  },
  setInteractive: (interactive) => ipcRenderer.send('toast:set-interactive', !!interactive),
  empty: () => ipcRenderer.send('toast:empty'),
  openImage: (filePath) => ipcRenderer.invoke('image:open-in-preview', filePath),
});
