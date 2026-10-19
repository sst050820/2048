'use strict';
/*
 * 预加载脚本（运行在隔离世界中，受 sandbox 限制）。
 *
 * 安全红线：
 *   - 不向页面暴露 Node.js、fs、child_process、通用 IPC 或任何命令执行能力；
 *   - 只通过 contextBridge 暴露极少数、白名单化的“应用控制”接口。
 *
 * 关窗握手（通道名固定、双向白名单）：
 *   主进程在关闭前发送 ninghe:request-save → 本脚本调用页面注册的
 *   “暂停并保存”处理器 → 把 {ok} 结果用 ninghe:save-result 回传。
 *   页面拿不到 ipcRenderer，只能通过 setSaveHandler 注册这一个处理器。
 */

const { contextBridge, ipcRenderer } = require('electron');

// 页面在主世界注册的“关窗前暂停并保存”处理器，可同步返回或返回 Promise。
let saveHandler = null;

function reply(result) {
  const ok = result && typeof result === 'object' && 'ok' in result;
  ipcRenderer.send('ninghe:save-result', ok ? result : { ok: false, reason: 'bad-result' });
}

ipcRenderer.on('ninghe:request-save', () => {
  Promise.resolve()
    .then(() => (typeof saveHandler === 'function'
      ? saveHandler()
      : { ok: true, reason: 'no-handler' }))
    .then((result) => reply(result))
    .catch((err) => reply({ ok: false, reason: 'exception',
      error: String((err && err.message) || err) }));
});

contextBridge.exposeInMainWorld('ningheDesktop', {
  // 桌面端运行标识（页面可据此决定是否做与桌面相关的行为，例如不依赖 SW）。
  isDesktop: true,
  // 注册关窗前保存处理器；只接受函数，且全局唯一。
  setSaveHandler: (fn) => { if (typeof fn === 'function') saveHandler = fn; },
});
