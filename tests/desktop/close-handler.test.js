// 关窗保存握手状态机：成功刷盘关闭、未加载直接关、失败重试/直接退出/取消、
// 超时、渲染进程无响应/崩溃、重复关闭、只接受当前窗口响应、坏结果。
// 纯 Node：通过 Module._load 注入一个最小 electron 桩，不启动真实 Electron。
const Module = require('module');

// ---- 最小 electron 桩 ----
const ipcHandlers = {};
const ipcMain = {
  on(ch, fn) { (ipcHandlers[ch] = ipcHandlers[ch] || []).push(fn); },
  removeListener(ch, fn) {
    if (ipcHandlers[ch]) ipcHandlers[ch] = ipcHandlers[ch].filter((f) => f !== fn);
  },
};
function emitIpc(ch, event, payload) {
  for (const fn of [...(ipcHandlers[ch] || [])]) fn(event, payload);
}
const electronStub = {
  ipcMain,
  dialog: { async showMessageBox() { return { response: 0 }; } },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

const ch = require('../../desktop/close-handler.cjs');

let fails = 0;
function check(name, ok, info) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : ''));
  if (!ok) fails++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 构造一个假 BrowserWindow / webContents，记录 flush 与 close 行为。
function makeWin(opts = {}) {
  const wcListeners = {};
  const flushed = { n: 0 };
  const wc = {
    loading: !!opts.loading,
    url: opts.url === undefined ? 'ninghe://app/index.html' : opts.url,
    isLoading() { return this.loading; },
    getURL() { return this.url; },
    isDestroyed() { return false; },
    on(e, fn) { (wcListeners[e] = wcListeners[e] || []).push(fn); },
    once(e, fn) { (wcListeners[e] = wcListeners[e] || []).push(fn); },
    removeListener(e, fn) {
      if (wcListeners[e]) wcListeners[e] = wcListeners[e].filter((f) => f !== fn);
    },
    queue: [],
    send(channel) {
      if (channel === 'ninghe:request-save' && this.queue.length) {
        const payload = this.queue.shift();
        setImmediate(() => emitIpc('ninghe:save-result', { sender: wc }, payload));
      }
    },
    session: { async flushStorageData() { flushed.n++; } },
    _emit(e) { for (const fn of [...(wcListeners[e] || [])]) fn(); },
  };
  const win = {
    webContents: wc,
    closed: false,
    _closeListeners: [],
    isDestroyed() { return false; },
    on(e, fn) { if (e === 'close') this._closeListeners.push(fn); },
    close() { return this.triggerClose(); },
    triggerClose() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const fn of [...this._closeListeners]) fn(event);
      this.closed = !event.defaultPrevented;
      return event.defaultPrevented; // true=被拦截（仍开着）
    },
  };
  return { win, wc, flushed };
}

async function run() {
  // 1. 保存成功 → 刷盘 → 放行关闭。
  {
    const { win, wc, flushed } = makeWin();
    ch.attachCloseHandler(win, { timeout: 80 });
    wc.queue.push({ ok: true });
    const blocked = win.triggerClose();
    check('成功路径首次关闭被拦截', blocked === true);
    await sleep(40);
    check('成功后窗口关闭', win.closed === true);
    check('成功后 flushStorageData 一次', flushed.n === 1, 'n=' + flushed.n);
  }

  // 2. 页面尚未加载（无对局）→ 不等待，直接关闭。
  {
    const { win, flushed } = makeWin({ loading: true });
    ch.attachCloseHandler(win, { timeout: 80 });
    const blocked = win.triggerClose();
    check('未加载首次关闭被拦截', blocked === true);
    await sleep(20);
    check('未加载直接关闭成功', win.closed === true);
    check('未加载仍 flush 一次', flushed.n === 1);
  }

  // 3. 保存失败 → 取消：窗口保留、关闭标志复位（可再次关闭）。
  {
    let detail = null;
    const { win, wc } = makeWin();
    ch.attachCloseHandler(win, { timeout: 80, prompt: async (w, d) => { detail = d; return 2; } });
    wc.queue.push({ ok: false, reason: 'exception', error: 'boom' });
    win.triggerClose();
    await sleep(40);
    check('取消后窗口保留', win.closed === false);
    check('取消后 closing 复位', win._ningheClosing === false);
    check('提示包含错误说明', !!detail && detail.indexOf('保存过程中发生错误') !== -1, detail);
  }

  // 4. 保存失败 → 直接退出：强制关闭且不 flush。
  {
    const { win, wc, flushed } = makeWin();
    ch.attachCloseHandler(win, { timeout: 80, prompt: async () => 1 });
    wc.queue.push({ ok: false });
    win.triggerClose();
    await sleep(40);
    check('直接退出窗口关闭', win.closed === true);
    check('直接退出未 flush', flushed.n === 0, 'n=' + flushed.n);
  }

  // 5. 保存失败 → 重试：第二次保存成功后关闭。
  {
    let prompts = 0;
    const { win, wc, flushed } = makeWin();
    ch.attachCloseHandler(win, {
      timeout: 80,
      prompt: async () => { prompts++; return 0; },
    });
    wc.queue.push({ ok: false }); // 第一次失败
    wc.queue.push({ ok: true });  // 重试成功
    win.triggerClose();
    await sleep(50);
    check('重试后窗口关闭', win.closed === true);
    check('恰好弹一次提示', prompts === 1, 'prompts=' + prompts);
    check('重试成功后 flush', flushed.n === 1);
  }

  // 6. 超时（页面不回）→ 提示超时，取消后保留。
  {
    let detail = null;
    const { win } = makeWin();
    ch.attachCloseHandler(win, { timeout: 60, prompt: async (w, d) => { detail = d; return 2; } });
    win.triggerClose(); // 不排队任何响应
    await sleep(90);
    check('超时后窗口保留', win.closed === false);
    check('超时提示文案', detail && detail.indexOf('等待游戏保存超时') !== -1, detail);
  }

  // 7. 重复触发关闭：流程进行中第二次 close 被拦截。
  {
    const { win } = makeWin();
    ch.attachCloseHandler(win, { timeout: 200, prompt: async () => 2 });
    const b1 = win.triggerClose();
    const b2 = win.triggerClose();
    check('首次关闭被拦截', b1 === true);
    check('流程中重复关闭被拦截', b2 === true);
    check('流程中窗口仍开着', win.closed === false);
    await sleep(230); // 等超时+取消，避免泄漏到后续用例
  }

  // 8. 只接受当前窗口响应：别的 webContents 回 ok 不应完成保存。
  {
    const A = makeWin();
    const B = makeWin();
    ch.attachCloseHandler(A.win, { timeout: 60, prompt: async () => 2 });
    A.win.triggerClose();
    setImmediate(() => emitIpc('ninghe:save-result', { sender: B.wc }, { ok: true }));
    await sleep(20);
    check('未被其他窗口的响应关闭', A.win.closed === false);
    await sleep(80); // 自身超时→取消
    check('最终自身超时仍保留', A.win.closed === false);
  }

  // 9. 坏结果（非对象/无 ok）→ 判失败。
  {
    let detail = null;
    const { win, wc } = makeWin();
    ch.attachCloseHandler(win, { timeout: 60, prompt: async (w, d) => { detail = d; return 2; } });
    wc.queue.push(null);
    win.triggerClose();
    await sleep(40);
    check('坏结果窗口保留', win.closed === false);
    check('坏结果提示文案', detail && detail.indexOf('没有返回有效的保存结果') !== -1, detail);
  }

  // 10. 渲染进程无响应（unresponsive）→ 失败提示。
  {
    let detail = null;
    const { win, wc } = makeWin();
    ch.attachCloseHandler(win, { timeout: 400, prompt: async (w, d) => { detail = d; return 2; } });
    win.triggerClose();
    wc._emit('unresponsive');
    await sleep(30);
    check('无响应提示文案', detail && detail.indexOf('没有响应') !== -1, detail);
    check('无响应后窗口保留', win.closed === false);
  }

  // 11. 渲染进程崩溃（render-process-gone）→ 失败提示。
  {
    let detail = null;
    const { win, wc } = makeWin();
    ch.attachCloseHandler(win, { timeout: 400, prompt: async (w, d) => { detail = d; return 2; } });
    win.triggerClose();
    wc._emit('render-process-gone');
    await sleep(30);
    check('崩溃提示文案', detail && detail.indexOf('崩溃') !== -1, detail);
    check('崩溃后窗口保留', win.closed === false);
  }

  // 12. requestCloseSave 直接调用的快速分支。
  {
    const loading = makeWin({ loading: true });
    const r1 = await ch.requestCloseSave(loading.win, { timeout: 30 });
    check('requestCloseSave 未加载返回 ok', r1.ok === true && r1.reason === 'not-loaded');
    const { win } = makeWin();
    const r2 = await ch.requestCloseSave(win, { timeout: 30 }); // 不响应
    check('requestCloseSave 超时返回 timeout', r2.ok === false && r2.reason === 'timeout');
  }
}

run().then(() => {
  if (fails) { console.error('\nFAILED ' + fails); process.exit(1); }
  console.log('\nAll close-handler checks passed.');
  process.exit(0);
}).catch((e) => {
  console.error('TEST_CRASH', e);
  process.exit(1);
});
