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
  getBookmarkChildren: (folderId: string) =>
    ipcRenderer.invoke('bookmarks:children', folderId),
  openBookmarksManager: () => ipcRenderer.invoke('bookmarks:openManager'),
  popupBookmarkFolder: (folderId: string, x: number, y: number) =>
    ipcRenderer.invoke('bookmarks:popupFolder', folderId, x, y),
  addBookmark: (input: { title: string; url: string; parentId?: string }) =>
    ipcRenderer.invoke('bookmarks:add', input),
  moveBookmark: (id: string, parentId: string) =>
    ipcRenderer.invoke('bookmarks:move', id, parentId),
  onState: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on('shell:state', listener);
    return () => ipcRenderer.removeListener('shell:state', listener);
  },
});
