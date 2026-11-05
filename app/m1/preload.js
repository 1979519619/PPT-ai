const { contextBridge, ipcRenderer } = require('electron');
const invoke = channel => payload => ipcRenderer.invoke('m1:' + channel, payload);
const on = channel => callback => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on('m1:' + channel, listener);
  return () => ipcRenderer.removeListener('m1:' + channel, listener);
};
contextBridge.exposeInMainWorld('m1', {
  asr: invoke('asr'), ask: invoke('ask'), abort: invoke('abort'), clear: invoke('clear'),
  focusShow: invoke('focusShow'), focusPanel: invoke('focusPanel'), hidePanel: invoke('hidePanel'), quit: invoke('quit'),
  startLasso: invoke('startLasso'), lassoDone: invoke('lassoDone'), lassoCancel: invoke('lassoCancel'), lassoViewport: invoke('lassoViewport'),
  openSettings: invoke('openSettings'), settingsInfo: invoke('settingsInfo'), saveKey: invoke('saveKey'), testKey: invoke('testKey'), openLogs: invoke('openLogs'),
  copyText: invoke('copyText'), petMenu: invoke('petMenu'), petDrag: invoke('petDrag'),
  overlayAction: invoke('overlayAction'), overlayPointer: invoke('overlayPointer'),
  onRec: on('rec'), onDelta: on('delta'), onDone: on('done'), onError: on('error'), onState: on('state'),
  onLassoInit: on('lassoInit'), onLasso: on('lasso'), onSources: on('sources'), onOverlay: on('overlay'), onPetStatus: on('petStatus'),
  onClear: on('clear'), onVoice: on('voice'), onResult: on('result'), onNotice: on('notice'), onStopAudio: on('stopAudio')
});

