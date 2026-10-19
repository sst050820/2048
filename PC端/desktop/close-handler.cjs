'use strict';
/*
 * 关窗“暂停并保存 → 确认 → 刷盘 → 关闭”握手（主进程侧）。
 *
 * 流程：
 *   拦截窗口 close → 经 preload 白名单通道（ninghe:request-save / ninghe:save-result）
 *   请求页面暂停并保存 → 有界等待页面回传真实写入结果 → 成功则 flushStorageData
 *   刷盘后放行关闭；失败/超时弹出“重试 / 直接退出 / 取消”。
 *
 * 独立成模块，便于 main.cjs 与桌面端到端测试复用同一套真实逻辑。
 */

const { ipcMain, dialog } = require('electron');

// 等待页面“暂停并保存”的最长时间，超时则提示玩家，不无限等待。
const SAVE_TIMEOUT_MS = 3000;

// 关窗保存失败原因 → 中文说明。
const SAVE_REASON_TEXT = {
  timeout: '等待游戏保存超时。',
  unresponsive: '游戏界面没有响应。',
  crashed: '游戏界面已崩溃。',
  destroyed: '游戏窗口已关闭。',
  'bad-result': '游戏没有返回有效的保存结果。',
  exception: '保存过程中发生错误。',
};

// 向渲染进程请求“暂停并保存”，有界等待，只接受当前窗口的响应。
// opts.timeout 可注入用于测试；生产默认 SAVE_TIMEOUT_MS。
function requestCloseSave(win, opts = {}) {
  return new Promise((resolve) => {
    const wc = win.webContents;
    const timeout = opts.timeout || SAVE_TIMEOUT_MS;
    if (win.isDestroyed() || wc.isDestroyed()) return resolve({ ok: false, reason: 'destroyed' });
    // 页面尚未加载/正在加载（例如刚启动就关闭）：没有可保存的对局。
    if (wc.isLoading() || !wc.getURL()) return resolve({ ok: true, reason: 'not-loaded' });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener('ninghe:save-result', onResult);
      wc.removeListener('unresponsive', onUnresponsive);
      wc.removeListener('render-process-gone', onGone);
      resolve(result);
    };
    const onResult = (event, result) => {
      if (event.sender !== wc) return;
      finish(result && typeof result === 'object' ? result : { ok: false, reason: 'bad-result' });
    };
    const onUnresponsive = () => finish({ ok: false, reason: 'unresponsive' });
    const onGone = () => finish({ ok: false, reason: 'crashed' });
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeout);
    ipcMain.on('ninghe:save-result', onResult);
    wc.on('unresponsive', onUnresponsive);
    wc.once('render-process-gone', onGone);
    wc.send('ninghe:request-save');
  });
}

// 原生失败提示；默认返回按钮序号（0 重试 / 1 直接退出 / 2 取消）。
const defaultPrompt = async (win, detail) => {
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['重试', '直接退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: '凝合',
    message: '退出时进度未能保存',
    detail,
  });
  return choice.response;
};

// 绑定到窗口的 close 事件。
// opts.prompt 可注入用于测试：(win, detail) => 0|1|2；生产留空使用原生对话框。
function attachCloseHandler(win, opts = {}) {
  const prompt = typeof opts.prompt === 'function' ? opts.prompt : defaultPrompt;
  const reqOpts = opts.timeout ? { timeout: opts.timeout } : {};
  win.on('close', async (event) => {
    // 已决定放行（成功刷盘后或玩家选择直接退出），不再拦截。
    if (win._ningheForceClose) return;
    // 关闭流程进行中：阻止重复触发（连续点关闭/系统关机重复调用）。
    if (win._ningheClosing) { event.preventDefault(); return; }
    event.preventDefault();
    win._ningheClosing = true;

    let result = await requestCloseSave(win, reqOpts);
    while (!result.ok) {
      if (win.isDestroyed()) { win._ningheClosing = false; return; }
      const detail = (SAVE_REASON_TEXT[result.reason] || '无法确认进度是否已保存。') +
        '\n\n“重试”会再次尝试保存后退出；“直接退出”会放弃未保存的进度；“取消”返回游戏。';
      let response;
      try {
        response = await prompt(win, detail);
      } catch (e) {
        // 对话框都无法弹出（极端情况）：保守地取消，交回玩家处理。
        win._ningheClosing = false;
        return;
      }
      if (response === 0) {
        result = await requestCloseSave(win, reqOpts); // 重试
      } else if (response === 1) {
        win._ningheForceClose = true;                  // 直接退出
        win.close();
        return;
      } else {
        win._ningheClosing = false;                   // 取消
        return;
      }
    }
    // 保存成功：把 localStorage 显式刷到磁盘，再放行关闭。
    try { await win.webContents.session.flushStorageData(); } catch (e) {}
    if (win.isDestroyed()) return;
    win._ningheForceClose = true;
    win.close();
  });
}

module.exports = { attachCloseHandler, requestCloseSave, defaultPrompt, SAVE_TIMEOUT_MS, SAVE_REASON_TEXT };
