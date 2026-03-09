const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("speakNote", {
  onCommand: (cb) => ipcRenderer.on("voice-command", (_e, cmd) => cb(cmd)),
  sendResult: (text) => ipcRenderer.send("voice-result", text),
  sendDebug: (msg) => ipcRenderer.send("voice-debug", msg),
});
