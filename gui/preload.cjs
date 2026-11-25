const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ls', {
  getState: () => ipcRenderer.invoke('get-state'),
  send: (role, text) => ipcRenderer.invoke('send', role, text),
  command: (role, text) => ipcRenderer.invoke('command', role, text),
  abort: (role) => ipcRenderer.invoke('abort', role),
  approval: (id, allow, always) => ipcRenderer.invoke('approval-answer', id, allow, always),
  ask: (id, answer) => ipcRenderer.invoke('ask-answer', id, answer),
  wsSwitch: (id) => ipcRenderer.invoke('ws-switch', id),
  brains: () => ipcRenderer.invoke('brains'),
  onEvent: (cb) => ipcRenderer.on('event', (_e, ev) => cb(ev)),
});