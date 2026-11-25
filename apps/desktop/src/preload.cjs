// Electron's sandboxed preload uses a restricted CommonJS loader.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const prefix = 'workbench:';
const invoke =
  (name) =>
  (...args) =>
    ipcRenderer.invoke(`${prefix}${name}`, ...args);

contextBridge.exposeInMainWorld('clipWorkbench', {
  project: invoke('project'),
  newProject: invoke('new'),
  openProject: invoke('open'),
  saveProject: invoke('save'),
  update: invoke('update'),
  importFiles: invoke('files'),
  importDirectory: invoke('scan'),
  importDrop: (files) =>
    invoke('drop')(
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    ),
  locate: invoke('locate'),
  outputDirectory: invoke('output'),
  startExport: invoke('export'),
  waitExport: invoke('wait'),
  cancelExport: invoke('cancel'),
  reveal: invoke('reveal'),
  recycle: invoke('cleanup'),
  onProgress(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(`${prefix}progress`, listener);
    return () => ipcRenderer.removeListener(`${prefix}progress`, listener);
  },
});
