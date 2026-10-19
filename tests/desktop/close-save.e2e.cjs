'use strict';
/*
 * 关窗保存 · 真实 Electron 端到端验收（用 electron 运行，不在 node 测试组内）。
 *   直接运行：electron tests/desktop/close-save.e2e.cjs
 *   或：     node tests/desktop/run-close-save.cjs
 *
 * 无 NINGHE_MODE 时为编排器，依次派生三个独立 electron 子进程（同一 userData），
 * 完整模拟“玩 → 关程序 → 重新打开恢复”，以及写入失败兜底：
 *   play   : 开局、发射若干球、切主题、静音，然后走真实关窗握手退出；
 *   verify : 新进程启动，从磁盘存档恢复并逐项比对；
 *   fail   : 让 localStorage.setItem 抛错，验证失败被检测、不假装成功、可取消。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const ROOT = process.env.NINGHE_ROOT || path.resolve(__dirname, '..', '..');
const MODE = process.env.NINGHE_MODE;

function orchestrate() {
  const { spawnSync } = require('child_process');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ninghe-cs-'));
  const udTitle = fs.mkdtempSync(path.join(os.tmpdir(), 'ninghe-cstitle-'));
  const udFail = fs.mkdtempSync(path.join(os.tmpdir(), 'ninghe-csfail-'));
  const run = (mode, userData) => {
    console.log('\n===== 子进程 ' + mode + ' (userData=' + userData + ') =====');
    const r = spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, {
        NINGHE_MODE: mode, NINGHE_ROOT: ROOT, NINGHE_USERDATA: userData,
      }),
      stdio: 'inherit',
    });
    return r.status;
  };
  const s1 = run('play', ud);
  const s2 = run('verify', ud);
  const s3 = run('title', udTitle);
  const s4 = run('fail', udFail);
  console.log('\nMODE_EXIT play=' + s1 + ' verify=' + s2 + ' title=' + s3 + ' fail=' + s4);
  process.exit(s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0 ? 0 : 1);
}
if (!MODE) {
  orchestrate();
  return;
}

// ---- 以下为真实 electron 窗口逻辑 ----
const { app, BrowserWindow, protocol } = require('electron');
const proto = require(path.join(ROOT, 'desktop', 'protocol.cjs'));
const closeHandler = require(path.join(ROOT, 'desktop', 'close-handler.cjs'));
const PRELOAD = path.join(ROOT, 'desktop', 'preload.cjs');
const USERDATA = process.env.NINGHE_USERDATA;

app.setPath('userData', USERDATA);
protocol.registerSchemesAsPrivileged(proto.privileges());
app.disableHardwareAcceleration();

let failures = 0;
function check(name, ok, info) {
  console.log((ok ? 'E2E ok   ' : 'E2E FAIL ') + name + (info ? '  ' + info : ''));
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWin(opts) {
  const win = new BrowserWindow({
    show: false, width: 540, height: 880,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, preload: PRELOAD,
    },
  });
  closeHandler.attachCloseHandler(win, opts || {});
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(
      "try{navigator.vibrate=function(){return false;};}catch(e){}", true).catch(() => {});
  });
  return win;
}

// 开局：发射 5 球、切一次主题、静音；返回局面快照与设置。
const PLAY_JS = `(async function () {
  const G = window.SB.game;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const snap = () => { const m = G.mode; return {
    screen: G.app.screen, state: m.state, score: m.score, biggest: m.biggest,
    sel: m.selectable.length, em: m.emerging.length, stack: m.stack.length,
    all: m.allSobos().length, layout: m.layoutName }; };
  const pe = (type, x, y) => { const c = document.getElementById('game');
    c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1,
      pointerType: 'mouse', clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 })); };
  const fire = () => { const m = G.mode; const s = m.selectable[0]; if (!s) return null;
    const p = G.renderer.toScreen(s.cx, s.cy);
    const tx = innerWidth / 2, ty = innerHeight * 0.52;
    let dx = tx - p.x, dy = ty - p.y; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const pull = 95;
    pe('pointerdown', p.x, p.y);
    for (let i = 1; i <= 6; i++) pe('pointermove', p.x + dx * pull * i / 6, p.y + dy * pull * i / 6);
    pe('pointerup', p.x + dx * pull, p.y + dy * pull);
    return { tier: s.tier }; };
  const waitSel = async (ms) => { const end = Date.now() + ms;
    while (Date.now() < end) { if (G.mode.selectable.length > 0) return true; await sleep(150); } return false; };

  document.getElementById('btn-play').click();
  await sleep(500);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
  await sleep(150);
  const style = G.style;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
  await sleep(150);
  const muted = window.SB.Audio.isMuted();
  for (let i = 0; i < 5; i++) { await waitSel(7000); fire(); await sleep(1200); }
  await sleep(2500);
  return JSON.stringify({ snap: snap(), style, muted });
})()`;

app.whenReady().then(async () => {
  try {
    proto.register({ protocol, root: path.join(ROOT, 'www') });
    const expectedFile = path.join(USERDATA, 'expected.json');

    if (MODE === 'play') {
      const win = makeWin();
      await win.loadURL(proto.APP_URL);
      await sleep(1200);
      const before = JSON.parse(await win.webContents.executeJavaScript(PLAY_JS));
      fs.writeFileSync(expectedFile, JSON.stringify(before));
      check('第一局产生球', before.snap.all > 0, 'all=' + before.snap.all);
      console.log('PLAY_SNAP ' + JSON.stringify(before));

      const closed = new Promise((res) => win.on('closed', res));
      win.close(); // 真实关窗握手：暂停并保存 → flush → 关闭
      const r = await Promise.race([closed, sleep(5000).then(() => 'TIMEOUT')]);
      check('第一局关窗握手完成', r !== 'TIMEOUT' && win.isDestroyed());
      await sleep(400);
      app.exit(failures ? 1 : 0);
    } else if (MODE === 'verify') {
      const win = makeWin();
      await win.loadURL(proto.APP_URL);
      await sleep(1200);
      const restored = JSON.parse(await win.webContents.executeJavaScript(`(async function () {
        const G = window.SB.game;
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const g = JSON.parse(localStorage.getItem('soboscuba.game') || 'null');
        const disk = g ? { v: g.v, layout: g.layout, score: g.score,
          stack: g.stack.length, sel: g.selectable.length, em: g.emerging.length } : null;
        const ok = G.resume();
        await sleep(400);
        const m = G.mode;
        const snap = { screen: G.app.screen, state: m.state, score: m.score,
          all: m.allSobos().length, stack: m.stack.length, sel: m.selectable.length, layout: m.layoutName };
        const keys = Object.keys(localStorage);
        return JSON.stringify({
          disk, resumeOk: ok, snap,
          style: G.style, muted: window.SB.Audio.isMuted(),
          mutedStored: localStorage.getItem('soboscuba.muted'),
          hasContinue: !document.getElementById('btn-continue').hidden,
          allKeys: keys,
        });
      })()`));
      const before = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
      console.log('VERIFY ' + JSON.stringify(restored));
      check('磁盘存档为 v3', restored.disk && restored.disk.v === 3, JSON.stringify(restored.disk));
      check('resume 返回成功', restored.resumeOk === true);
      check('标题页显示继续按钮', restored.hasContinue === true);
      check('恢复后进入对局', restored.snap.screen === 'play', restored.snap.screen);
      check('恢复球数一致', restored.snap.all === before.snap.all,
        restored.snap.all + ' vs ' + before.snap.all);
      check('恢复分数一致', restored.snap.score === before.snap.score,
        restored.snap.score + ' vs ' + before.snap.score);
      check('恢复布局一致', restored.snap.layout === before.snap.layout,
        restored.snap.layout + ' vs ' + before.snap.layout);
      check('主题设置持久化', restored.style === before.style, restored.style + ' vs ' + before.style);
      check('静音设置持久化', restored.muted === true && restored.mutedStored !== null,
        'muted=' + restored.muted);
      check('存档键仍为 soboscuba 前缀', restored.allKeys.every((k) => k.indexOf('soboscuba.') === 0),
        JSON.stringify(restored.allKeys));
      win._ningheForceClose = true; win.close();
      app.exit(failures ? 1 : 0);
    } else if (MODE === 'title') {
      // 标题页（无进行中的对局）直接关闭：应快速成功，不弹框、不超时。
      const win = makeWin();
      await win.loadURL(proto.APP_URL);
      await sleep(1200);
      const screen = await win.webContents.executeJavaScript('window.SB.game.app.screen');
      check('初始为标题页', screen === 'title', screen);
      const t0 = Date.now();
      const closed = new Promise((res) => win.on('closed', res));
      win.close();
      const r = await Promise.race([closed, sleep(3000).then(() => 'TIMEOUT')]);
      const dt = Date.now() - t0;
      check('标题页无对局快速关闭', r !== 'TIMEOUT' && win.isDestroyed() && dt < 1500, dt + 'ms');
      app.exit(failures ? 1 : 0);
    } else if (MODE === 'fail') {
      // 进入对局后让 localStorage.setItem 抛错；主进程应检测到失败、不假装成功。
      let promptCalls = 0;
      const win = makeWin({
        timeout: 800,
        prompt: async () => { promptCalls++; return 2; }, // 自动“取消”，窗口保留
      });
      await win.loadURL(proto.APP_URL);
      await sleep(1200);
      await win.webContents.executeJavaScript(`(async function () {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        document.getElementById('btn-play').click();
        await sleep(500);
        // 模拟磁盘满/被拒绝：写入一律抛错。
        localStorage.setItem = function () {
          const e = new Error('denied'); e.name = 'QuotaExceededError'; throw e;
        };
      })()`);
      win.close();
      await sleep(1500); // 等待 request-save → false → prompt
      check('写入失败被检测（弹了一次提示）', promptCalls === 1, 'calls=' + promptCalls);
      check('失败取消后窗口保留', win.isDestroyed() === false);
      win._ningheForceClose = true; win.close();
      await sleep(300);
      app.exit(failures ? 1 : 0);
    }
  } catch (e) {
    console.error('E2E CRASH ' + (e && e.stack || e));
    app.exit(1);
  }
});

setTimeout(() => { console.error('E2E TIMEOUT'); app.exit(2); }, 60000);
