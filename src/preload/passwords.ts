import { contextBridge, ipcRenderer } from 'electron';
import { installRendererCrashHooks } from './crash-hook';

installRendererCrashHooks('passwords');

contextBridge.exposeInMainWorld('youthPasswords', {
  list: () => ipcRenderer.invoke('sitePassword:list'),
  remove: (id: string) => ipcRenderer.invoke('sitePassword:remove', id),
  onChanged: (cb: (payload: unknown) => void) => {
    const listener = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('sitePassword:changed', listener);
    return () => ipcRenderer.removeListener('sitePassword:changed', listener);
  },
});
