import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('youthPasswords', {
  list: () => ipcRenderer.invoke('sitePassword:list'),
  remove: (id: string) => ipcRenderer.invoke('sitePassword:remove', id),
  appVersion: () => ipcRenderer.invoke('bookmarks:appVersion'),
  onChanged: (cb: (payload: unknown) => void) => {
    const listener = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('sitePassword:changed', listener);
    return () => ipcRenderer.removeListener('sitePassword:changed', listener);
  },
});
