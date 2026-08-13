const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { startServer } = require('./disk-space-manager.js');

let service = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

async function createWindow() {
  if (!service) service = await startServer({ fallbackToRandom: true });
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: '磁盘空间管家',
    icon: path.join(__dirname, 'app-icon.ico'),
    backgroundColor: '#090512',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js'), devTools: !app.isPackaged }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== service.url && !targetUrl.startsWith(`${service.url}/`)) event.preventDefault();
  });
  window.loadURL(service.url);
}

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, path: null };
  return { canceled: false, path: result.filePaths[0] };
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.whenReady().then(createWindow).catch(error => {
    dialog.showErrorBox('磁盘空间管家启动失败', error.message);
    app.quit();
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => service?.server?.close());
