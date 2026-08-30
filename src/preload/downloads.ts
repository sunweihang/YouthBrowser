import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('youthDownloads', {
  list: (query?: string) => ipcRenderer.invoke('downloads:list', query),
  open: (id: string) => ipcRenderer.invoke('downloads:open', id),
  show: (id: string) => ipcRenderer.invoke('downloads:show', id),
  cancel: (id: string) => ipcRenderer.invoke('downloads:cancel', id),
  pause: (id: string) => ipcRenderer.invoke('downloads:pause', id),
  resume: (id: string) => ipcRenderer.invoke('downloads:resume', id),
  remove: (id: string) => ipcRenderer.invoke('downloads:remove', id),
  clear: () => ipcRenderer.invoke('downloads:clear'),
  openFolder: () => ipcRenderer.invoke('downloads:openFolder'),
  appVersion: () => ipcRenderer.invoke('bookmarks:appVersion'),
  onChanged: (cb: (payload: unknown) => void) => {
    const listener = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('downloads:changed', listener);
    return () => ipcRenderer.removeListener('downloads:changed', listener);
  },
});
