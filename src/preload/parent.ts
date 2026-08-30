import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('youthParent', {
  getMeta: () => ipcRenderer.invoke('parent:getMeta'),
  setupPassword: (password: string) =>
    ipcRenderer.invoke('parent:setupPassword', password),
  unlock: (password: string) => ipcRenderer.invoke('parent:unlock', password),
  changePassword: (current: string, next: string) =>
    ipcRenderer.invoke('parent:changePassword', current, next),
  setFilteringEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('parent:setFilteringEnabled', enabled),
  getRules: () => ipcRenderer.invoke('parent:getRules'),
  createGroup: (input) => ipcRenderer.invoke('parent:createGroup', input),
  updateGroup: (id, patch) =>
    ipcRenderer.invoke('parent:updateGroup', id, patch),
  deleteGroup: (id) => ipcRenderer.invoke('parent:deleteGroup', id),
  addHost: (groupId, host) =>
    ipcRenderer.invoke('parent:addHost', groupId, host),
  removeHost: (groupId, host) =>
    ipcRenderer.invoke('parent:removeHost', groupId, host),
  addBiliUp: (groupId, midOrUrl, note) =>
    ipcRenderer.invoke('parent:addBiliUp', groupId, midOrUrl, note),
  removeBiliUp: (groupId, mid) =>
    ipcRenderer.invoke('parent:removeBiliUp', groupId, mid),
  listWatchRequests: () => ipcRenderer.invoke('watchRequest:list'),
  pendingWatchCount: () => ipcRenderer.invoke('watchRequest:pendingCount'),
  approveWatchRequest: (id) => ipcRenderer.invoke('watchRequest:approve', id),
  rejectWatchRequest: (id) => ipcRenderer.invoke('watchRequest:reject', id),
  getAccount: () => ipcRenderer.invoke('account:get'),
  getSyncStatus: () => ipcRenderer.invoke('account:syncStatus'),
  registerAccount: (input) => ipcRenderer.invoke('account:register', input),
  loginAccount: (input) => ipcRenderer.invoke('account:login', input),
  logoutAccount: () => ipcRenderer.invoke('account:logout'),
  pushConfig: () => ipcRenderer.invoke('account:push'),
  pullConfig: () => ipcRenderer.invoke('account:pull'),
  listHistory: (query?: string) => ipcRenderer.invoke('history:list', query),
  removeHistory: (id: string) => ipcRenderer.invoke('history:remove', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  openHistoryEntry: (id: string) => ipcRenderer.invoke('history:open', id),
  onMeta: (cb) => {
    const listener = (_: unknown, meta: unknown) => cb(meta);
    ipcRenderer.on('parent:meta', listener);
    return () => ipcRenderer.removeListener('parent:meta', listener);
  },
});
