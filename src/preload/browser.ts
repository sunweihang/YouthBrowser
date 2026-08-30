import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('youthBrowser', {
  getState: () => ipcRenderer.invoke('shell:getState'),
  navigate: (url: string) => ipcRenderer.invoke('shell:navigate', url),
  goBack: () => ipcRenderer.invoke('shell:goBack'),
  goForward: () => ipcRenderer.invoke('shell:goForward'),
  reload: (ignoreCache?: boolean) => ipcRenderer.invoke('shell:reload', ignoreCache),
  clearCache: () => ipcRenderer.invoke('shell:clearCache'),
  newTab: (url?: string) => ipcRenderer.invoke('shell:newTab', url),
  closeTab: (id: string) => ipcRenderer.invoke('shell:closeTab', id),
  activateTab: (id: string) => ipcRenderer.invoke('shell:activateTab', id),
  openParent: () => ipcRenderer.invoke('shell:openParent'),
  openHistory: () => ipcRenderer.invoke('shell:openHistory'),
  openDownloads: () => ipcRenderer.invoke('shell:openDownloads'),
  savePage: () => ipcRenderer.invoke('shell:savePage'),
  downloadOpen: (id: string) => ipcRenderer.invoke('downloads:open', id),
  downloadShow: (id: string) => ipcRenderer.invoke('downloads:show', id),
  downloadCancel: (id: string) => ipcRenderer.invoke('downloads:cancel', id),
  popupAppMenu: (x: number, y: number) =>
    ipcRenderer.invoke('shell:popupAppMenu', x, y),
  popupMenu: (name: string, x: number, y: number) =>
    ipcRenderer.invoke('shell:popupMenu', name, x, y),
  setChromeExtra: (extra: number) =>
    ipcRenderer.invoke('shell:setChromeExtra', extra),
  toggleBookmarksBar: () => ipcRenderer.invoke('shell:toggleBookmarksBar'),
  toggleMenuBar: () => ipcRenderer.invoke('shell:toggleMenuBar'),
  zoomIn: () => ipcRenderer.invoke('shell:zoomIn'),
  zoomOut: () => ipcRenderer.invoke('shell:zoomOut'),
  zoomReset: () => ipcRenderer.invoke('shell:zoomReset'),
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean }) =>
    ipcRenderer.invoke('shell:findInPage', text, options),
  stopFindInPage: () => ipcRenderer.invoke('shell:stopFindInPage'),
  print: () => ipcRenderer.invoke('shell:print'),
  toggleFullscreen: () => ipcRenderer.invoke('shell:toggleFullscreen'),
  quit: () => ipcRenderer.invoke('shell:quit'),
  about: () => ipcRenderer.invoke('shell:about'),
  setAsDefaultBrowser: () => ipcRenderer.invoke('shell:setAsDefaultBrowser'),
  getHomepage: () => ipcRenderer.invoke('shell:getHomepage'),
  setHomepage: (url: string) => ipcRenderer.invoke('shell:setHomepage', url),
  setCurrentHomepage: () => ipcRenderer.invoke('shell:setCurrentHomepage'),
  saveSitePassword: (input: {
    origin: string;
    username: string;
    password: string;
  }) => ipcRenderer.invoke('sitePassword:saveOffer', input),
  appInfo: () => ipcRenderer.invoke('shell:appInfo'),
  getUpdateStatus: () => ipcRenderer.invoke('update:getStatus'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
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
  onCommand: (cb: (cmd: { action: string; payload?: unknown }) => void) => {
    const listener = (_: unknown, cmd: { action: string; payload?: unknown }) =>
      cb(cmd);
    ipcRenderer.on('shell:command', listener);
    return () => ipcRenderer.removeListener('shell:command', listener);
  },
  onFindResult: (cb: (result: unknown) => void) => {
    const listener = (_: unknown, result: unknown) => cb(result);
    ipcRenderer.on('shell:findResult', listener);
    return () => ipcRenderer.removeListener('shell:findResult', listener);
  },
});
