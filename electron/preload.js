const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onRecordingState: (callback) => ipcRenderer.on("recording-state", callback),
});
