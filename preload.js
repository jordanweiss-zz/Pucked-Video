const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openVideo: () => ipcRenderer.invoke('video:open'),
  listSports: () => ipcRenderer.invoke('sports:list'),
  loadTags: (key) => ipcRenderer.invoke('tags:load', key),
  saveTags: (key, data) => ipcRenderer.invoke('tags:save', key, data),
  loadXbotgoMarks: (videoPath) => ipcRenderer.invoke('xbotgo:marks', videoPath),
  loadTeams: () => ipcRenderer.invoke('teams:load'),
  saveTeams: (data) => ipcRenderer.invoke('teams:save', data),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  pickFolder: (title) => ipcRenderer.invoke('folder:pick', title),
  loadAiEvents: (dir) => ipcRenderer.invoke('ai:events:load', dir),
  saveAiEvents: (dir, data) => ipcRenderer.invoke('ai:events:save', dir, data),
  pickAiResults: (defaultPath) => ipcRenderer.invoke('ai:import:pick', defaultPath),
  checkFfmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
});
