import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('youthBrowser', {
  getState: () => ipcRenderer.invoke('shell:getState'),
  navigate: (url: string) => ipcRenderer.invoke('shell:navigate', url),
  goBack: () => ipcRenderer.invoke('shell:goBack'),
  goForward: () => ipcRenderer.invoke('shell:goForward'),
  reload: () => ipcRenderer.invoke('shell:reload'),
  newTab: (url?: string) => ipcRenderer.invoke('shell:newTab', url),
  closeTab: (id: string) => ipcRenderer.invoke('shell:closeTab', id),
  activateTab: (id: string) => ipcRenderer.invoke('shell:activateTab', id),
  openParent: () => ipcRenderer.invoke('shell:openParent'),
  toggleBookmark: () => ipcRenderer.invoke('bookmarks:toggleCurrent'),
  removeBookmark: (id: string) => ipcRenderer.invoke('bookmarks:remove', id),
  openBookmark: (id: string) => ipcRenderer.invoke('bookmarks:open', id),
  onState: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on('shell:state', listener);
    return () => ipcRenderer.removeListener('shell:state', listener);
  },
});
