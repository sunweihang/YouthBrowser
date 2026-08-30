import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('youthUpdate', {
  getStatus: () => ipcRenderer.invoke('update:getStatus'),
  check: () => ipcRenderer.invoke('update:check'),
  install: () => ipcRenderer.invoke('update:install'),
  onStatus: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
