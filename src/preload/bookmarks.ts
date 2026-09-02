import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('youthBookmarks', {
  snapshot: () => ipcRenderer.invoke('bookmarks:snapshot'),
  children: (folderId: string) =>
    ipcRenderer.invoke('bookmarks:children', folderId),
  createFolder: (input: { title: string; parentId?: string }) =>
    ipcRenderer.invoke('bookmarks:createFolder', input),
  add: (input: { title: string; url: string; parentId?: string }) =>
    ipcRenderer.invoke('bookmarks:add', input),
  rename: (id: string, title: string) =>
    ipcRenderer.invoke('bookmarks:rename', id, title),
  move: (id: string, parentId: string) =>
    ipcRenderer.invoke('bookmarks:move', id, parentId),
  remove: (id: string) => ipcRenderer.invoke('bookmarks:remove', id),
  open: (id: string) => ipcRenderer.invoke('bookmarks:open', id),
  account: () => ipcRenderer.invoke('bookmarks:account'),
  syncStatus: () => ipcRenderer.invoke('bookmarks:syncStatus'),
  pushSync: () => ipcRenderer.invoke('bookmarks:pushSync'),
  pullSync: () => ipcRenderer.invoke('bookmarks:pullSync'),
  onChanged: (cb: (snapshot: unknown) => void) => {
    const listener = (_: unknown, snapshot: unknown) => cb(snapshot);
    ipcRenderer.on('bookmarks:changed', listener);
    return () => ipcRenderer.removeListener('bookmarks:changed', listener);
  },
});
