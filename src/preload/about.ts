import { contextBridge, ipcRenderer } from 'electron';
import { installRendererCrashHooks } from './crash-hook';

installRendererCrashHooks('about');

contextBridge.exposeInMainWorld('youthAbout', {
  getInfo: () => ipcRenderer.invoke('about:getInfo'),
  openWebsite: () => ipcRenderer.invoke('about:openWebsite'),
  close: () => ipcRenderer.invoke('about:close'),
});
