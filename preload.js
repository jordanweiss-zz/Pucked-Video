const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openVideo: () => ipcRenderer.invoke('video:open'),
  listSports: () => ipcRenderer.invoke('sports:list'),
  loadTags: (key) => ipcRenderer.invoke('tags:load', key),
  saveTags: (key, data) => ipcRenderer.invoke('tags:save', key, data),
  loadXbotgoMarks: (videoPath) => ipcRenderer.invoke('xbotgo:marks', videoPath),
  loadTeams: () => ipcRenderer.invoke('teams:load'),
  saveTeams: (data) => ipcRenderer.invoke('teams:save', data),
  checkFfmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
});
