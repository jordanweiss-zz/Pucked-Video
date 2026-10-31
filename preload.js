// The computer's own file dialogs, for the screens. Everything else goes to the server (renderer/api.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  pickFile: (opts) => ipcRenderer.invoke('native:pick-file', opts),
  pickFolder: (title) => ipcRenderer.invoke('native:pick-folder', title),
  saveFile: (opts) => ipcRenderer.invoke('native:save-file', opts),
  openPath: (file) => ipcRenderer.invoke('native:open-path', file),
  showItem: (file) => ipcRenderer.invoke('native:show-item', file),
  openExternal: (url) => ipcRenderer.invoke('native:open-external', url),
  // Clicking a desktop notice brings the window to the front.
  focusWindow: () => ipcRenderer.invoke('native:focus'),
});
