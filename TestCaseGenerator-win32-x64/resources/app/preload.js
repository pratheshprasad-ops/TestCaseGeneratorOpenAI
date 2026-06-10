const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    generateTestCases: (url) => ipcRenderer.invoke('generate-test-cases', url)
});
