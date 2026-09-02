import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('youthAbout', {
  getInfo: () => ipcRenderer.invoke('about:getInfo'),
  openWebsite: () => ipcRenderer.invoke('about:openWebsite'),
  close: () => ipcRenderer.invoke('about:close'),
});
