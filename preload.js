const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diskManager', {
  selectFolder: () => ipcRenderer.invoke('select-folder')
});
