'use strict';
/*
 * 凝合 · Windows 桌面外壳（Electron 主进程）。
 *
 * 职责边界（见 docs/Windows-EXE制作方案与执行计划.md）：
 *   - 只负责窗口、文件路径、应用生命周期、自定义协议与退出流程；
 *   - 游戏的物理、渲染、规则、存档全部在 www/ 页面里，主进程不介入；
 *   - 渲染进程开启 contextIsolation + sandbox，关闭 nodeIntegration，
 *     页面拿不到 Node/Electron 通用能力；只允许 ninghe://app 本地资源。
 *
 * 数据目录隔离：
 *   正式打包版 → %APPDATA%\Ninghe（固定，发版后不随版本号改变）；
 *   开发版      → %APPDATA%\Ninghe-dev，绝不污染正式玩家存档；
 *   自动化测试  → 由环境变量 NINGHE_USERDATA 指定独立临时目录。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, shell, protocol, ipcMain } = require('electron');
const proto = require('./protocol.cjs');
const winState = require('./window-state.cjs');

const ROOT = path.resolve(__dirname, '..');
const WWW_ROOT = path.join(ROOT, 'www');
const PRODUCT_USER_DIR = 'Ninghe';
const APP_ID = 'com.ninghe.app';

// 协议特权必须在 app.ready 之前注册（secure/standard 同源，显式关闭 Service Worker）。
protocol.registerSchemesAsPrivileged(proto.privileges());

// ---- 用户数据目录（存档位置）三态隔离 ----
if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), PRODUCT_USER_DIR));
} else if (process.env.NINGHE_USERDATA) {
  app.setPath('userData', path.resolve(process.env.NINGHE_USERDATA));
} else {
  app.setPath('userData', path.join(app.getPath('appData'), PRODUCT_USER_DIR + '-dev'));
}

app.setAppUserModelId(APP_ID);

/** @type {BrowserWindow | null} */
let mainWindow = null;

// ---- 单实例：再次启动只激活已有窗口，避免两个进程同时写同一份存档 ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = mainWindow || BrowserWindow.getAllWindows()[0];
    if (!w) return;
    if (w.isMinimized()) w.restore();
    if (w.isFullScreen()) w.setFullScreen(false);
    w.show();
    w.focus();
  });
}

function iconPath() {
  // 开发期优先用 PNG；打包/阶段 3 生成 ico 后改用 desktop/assets/icon.ico。
  const ico = path.join(ROOT, 'desktop', 'assets', 'icon.ico');
  if (fs.existsSync(ico)) return ico;
  const png = path.join(WWW_ROOT, 'icons', 'icon-512.png');
  return fs.existsSync(png) ? png : undefined;
}

function loadFailHtml() {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>凝合</title><style>body{margin:0;height:100vh;display:flex;align-items:center;' +
    'justify-content:center;background:#0b0e11;color:#e8f0f2;font-family:"Microsoft YaHei",sans-serif;text-align:center}' +
    'div{max-width:520px;padding:24px;line-height:1.7}h1{font-size:20px}p{color:#9fb3b8;font-size:14px}</style></head>' +
    '<body><div><h1>游戏资源加载失败</h1><p>请确认凝合程序文件完整、没有被单独移动出解压目录，然后重新启动。<br>' +
    '若问题仍存在，请重新解压完整安装包。</p></div></body></html>';
}

function createWindow(initial) {
  const win = new BrowserWindow({
    width: Math.max(initial.width, 480),
    height: Math.max(initial.height, 640),
    x: initial.x,
    y: initial.y,
    backgroundColor: '#0b0e11',
    show: false,
    title: '凝合',
    icon: iconPath(),
    autoHideMenuBar: true,
    minWidth: 420,
    minHeight: 560,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // 不允许页面弹出任何新窗口；若意外出现 http(s) 外链，交给系统浏览器并拒绝弹窗。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // 禁止任何离开本地协议的导航（防御远程/文件跳转）。
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(proto.SCHEME + '://' + proto.HOST + '/')) event.preventDefault();
  });

  // F11 在主进程切换全屏，不进入页面；Esc/P/M/K/L 一律留给游戏，不抢占。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });

  // 桌面平台没有震动马达：在 DOM 就绪后（早于任何用户操作）把无硬件的
  // navigator.vibrate 替换为 no-op，避免无意义调用与控制台噪音。不改动游戏源码。
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript("try{navigator.vibrate=function(){return false;};}catch(e){}", true).catch(() => {});
  });

  // 资源加载失败时给出可理解的中文错误页，而不是白屏。
  win.webContents.on('did-fail-load', (event, errorCode, errorDesc, validatedUrl) => {
    if (validatedUrl && validatedUrl.startsWith(proto.SCHEME + '://')) {
      win.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(loadFailHtml())).catch(() => {});
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(proto.APP_URL).catch(() => {});

  mainWindow = win;
  return win;
}

app.whenReady().then(() => {
  // 注册本地资源协议，只返回随包的 www。
  proto.register({ protocol, root: WWW_ROOT });

  // 初始窗口（含持久化尺寸/位置与拔显示器归位）。
  const initial = winState.initialBounds();
  const win = createWindow(initial);
  winState.track(win, initial.stateFile);
  if (initial.isMaximized) win.maximize();

  // 移除默认应用菜单（游戏无需菜单栏；F11 全屏在阶段 3 由 before-input-event 处理）。
  Menu.setApplicationMenu(null);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const fresh = winState.initialBounds();
      const w = createWindow(fresh);
      winState.track(w, fresh.stateFile);
    }
  });
});

// 退出流程：阶段 4 在此接入“暂停并保存 → 确认 → 刷盘 → 关闭”的握手。
app.on('window-all-closed', () => {
  app.quit();
});

module.exports = { WWW_ROOT, createWindow };
