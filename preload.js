const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openVideo: () => ipcRenderer.invoke('video:open'),
  listSports: () => ipcRenderer.invoke('sports:list'),
  loadTags: (videoPath) => ipcRenderer.invoke('tags:load', videoPath),
  saveTags: (videoPath, data) => ipcRenderer.invoke('tags:save', videoPath, data),
  loadXbotgoMarks: (videoPath) => ipcRenderer.invoke('xbotgo:marks', videoPath),
  checkFfmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
});
