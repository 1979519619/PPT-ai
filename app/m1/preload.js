const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('m1', {
  asr: (wavB64) => ipcRenderer.invoke('m1:asr', wavB64),
  ask: (text) => ipcRenderer.invoke('m1:ask', text),
  abort: () => ipcRenderer.invoke('m1:abort'),
  focusShow: () => ipcRenderer.invoke('m1:focusShow'),
  focusPanel: () => ipcRenderer.invoke('m1:focusPanel'),
  hidePanel: () => ipcRenderer.invoke('m1:hidePanel'),
  quit: () => ipcRenderer.invoke('m1:quit'),
  onRec: (cb) => ipcRenderer.on('m1:rec', (_e, v) => cb(v)),
  onDelta: (cb) => ipcRenderer.on('m1:delta', (_e, v) => cb(v)),
  onDone: (cb) => ipcRenderer.on('m1:done', (_e, v) => cb(v)),
  onError: (cb) => ipcRenderer.on('m1:error', (_e, v) => cb(v)),
  onState: (cb) => ipcRenderer.on('m1:state', (_e, v) => cb(v)),
  startLasso: () => ipcRenderer.invoke('m1:startLasso'),
  onLassoInit: (cb) => ipcRenderer.on('m1:lassoInit', (_e, v) => cb(v)),
  lassoDone: (v) => ipcRenderer.invoke('m1:lassoDone', v),
  lassoCancel: () => ipcRenderer.invoke('m1:lassoCancel'),
  onLasso: (cb) => ipcRenderer.on('m1:lasso', (_e, v) => cb(v)),
  openSettings: () => ipcRenderer.invoke('m1:openSettings'),
  settingsInfo: () => ipcRenderer.invoke('m1:settingsInfo'),
  saveKey: (k) => ipcRenderer.invoke('m1:saveKey', k),
  testKey: (k) => ipcRenderer.invoke('m1:testKey', k),
  openLogs: () => ipcRenderer.invoke('m1:openLogs')
});
