// Only the app's own pages (the address and offline screens) get these: never the website.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('almanacDesktop', {
    connect: (address) => ipcRenderer.invoke('almanac:connect', address),
    retry: () => ipcRenderer.invoke('almanac:retry'),
    change: () => ipcRenderer.invoke('almanac:change'),
  });
}
