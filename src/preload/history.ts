import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('youthHistory', {
  list: (query?: string) => ipcRenderer.invoke('history:list', query),
  open: (id: string) => ipcRenderer.invoke('history:open', id),
  remove: (id: string, password?: string) =>
    ipcRenderer.invoke('history:remove', id, password),
  clear: (password?: string) => ipcRenderer.invoke('history:clear', password),
  canDelete: () => ipcRenderer.invoke('history:canDelete'),
  appVersion: () => ipcRenderer.invoke('bookmarks:appVersion'),
  onChanged: (cb: (payload: unknown) => void) => {
    const listener = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('history:changed', listener);
    return () => ipcRenderer.removeListener('history:changed', listener);
  },
});
