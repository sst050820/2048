'use strict';
/*
 * 预加载脚本（运行在隔离世界中，受 sandbox 限制）。
 *
 * 安全红线：
 *   - 不向页面暴露 Node.js、fs、child_process、通用 IPC 或任何命令执行能力；
 *   - 只通过 contextBridge 暴露极少数、白名单化的“应用控制”接口。
 *
 * 阶段 2：仅提供一个只读的运行环境标识。
 * 阶段 4：在此加入“暂停并保存 → 主进程确认刷盘 → 才允许关闭”的有限握手，
 *         且只接受当前窗口的请求、拒绝任意通道名。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ningheDesktop', {
  // 桌面端运行标识（页面可据此决定是否做与桌面相关的行为，例如不依赖 SW）。
  isDesktop: true,
  // 阶段 4 将在此挂接 requestSafeClose / onBeforeClose 等握手接口。
});
