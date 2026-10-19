'use strict';
/*
 * 阶段6 打包成品验收（Windows）。
 *
 * 两种模式，跑同一套场景与探针，输出可对比的 JSON：
 *   打包版：electron 运行（真实 asar / fuses 产物）
 *     node tests/desktop/acceptance.cjs --exe "E:\Codex\2048\out\凝合-win32-x64\凝合.exe" --port 9230 --label packaged
 *   网页基线（同机 Playwright Chromium 打开本地 server）：
 *     node tests/desktop/acceptance.cjs --web http://localhost:8123/ --label web
 *
 * 测量：固定种子 PRNG 保证待发序列一致；rAF 帧间隔、物理 step 耗时、
 * 掉帧、恢复（保护）触发次数；普通与密集两个场景。
 *
 * 注意：窗口必须在前台采样，否则系统后台节流会污染 rAF 数据（打包版会自动前置）。
 */
const { spawn, execFileSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const EXE = arg('exe');
const PORT = Number(arg('port') || 9230);
const WEB = arg('web');
const LABEL = arg('label') || (EXE ? 'packaged' : 'web');
const DENSE_SHOTS = Number(arg('dense') || 36);
const OUT_JSON = arg('out') || path.join(ROOT, 'out', 'acceptance', `${LABEL}.json`);
const WIN = { w: 1100, h: 800 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 在页面任何脚本之前执行：固定种子 + rAF 帧间隔探针。
function initScript() {
  return () => {
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    window.__SEED = 20261019;
    Math.random = mulberry32(window.__SEED);

    window.__probe = {
      raf: [], stepMs: [],
      droppedFrames: 0, longFrames: 0,
      recoveriesStarted: 0, recoveriesPeak: 0,
      t0: 0,
      reset() {
        this.raf = []; this.stepMs = [];
        this.droppedFrames = 0; this.longFrames = 0;
        this.recoveriesStarted = 0; this.recoveriesPeak = 0;
        this.t0 = performance.now();
      },
    };
    const origRAF = window.requestAnimationFrame.bind(window);
    let lastTs = 0;
    window.requestAnimationFrame = function (cb) {
      return origRAF(function (ts) {
        if (lastTs) {
          const d = ts - lastTs;
          window.__probe.raf.push(d);
          if (d > 25) window.__probe.droppedFrames++; // 低于约 40fps
          if (d > 50) window.__probe.longFrames++;    // 明显卡顿
        }
        lastTs = ts;
        cb(ts);
      });
    };
  };
}

// SB 就绪后安装物理层探针（step 耗时、恢复触发）。
async function installWorldProbe(page) {
  await page.waitForFunction(() => !!(window.SB && SB.World && SB.game && SB.game.mode), null, { timeout: 15000 });
  await page.evaluate(() => {
    const P = SB.World.prototype;
    if (P.__probeWrapped) return;
    const origStep = P.step;
    P.step = function () {
      const t0 = performance.now();
      const r = origStep.apply(this, arguments);
      if (window.__probe && this.recoveries) {
        window.__probe.stepMs.push(performance.now() - t0);
        if (this.recoveries.length > window.__probe.recoveriesPeak) {
          window.__probe.recoveriesPeak = this.recoveries.length;
        }
      }
      return r;
    };
    const origStart = P._startRecovery;
    P._startRecovery = function () {
      if (window.__probe) window.__probe.recoveriesStarted++;
      return origStart.apply(this, arguments);
    };
    P.__probeWrapped = true;
    // 合并计数
    const g = SB.game;
    g.__mergeCount = 0;
    const m0 = g.mode;
    const wrap = (mode) => {
      if (!mode || mode.__mergeWrapped) return;
      const f = mode.hooks.merge;
      mode.hooks.merge = function () { g.__mergeCount++; return f.apply(this, arguments); };
      mode.__mergeWrapped = true;
    };
    wrap(m0);
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(g) || {}, 'mode');
    // mode 是 SB.game 自身 getter，每次 newGame 替换；轮询包新对象。
    setInterval(() => wrap(SB.game.mode), 200);
  });
}

async function collect2(page, name, ms) {
  await page.evaluate(() => window.__probe.reset());
  await sleep(ms);
  return await page.evaluate((name) => {
    const q = (arr, qq) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * qq))];
    };
    const summarize = arr => {
      if (!arr.length) return { n: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
      const sum = arr.reduce((a, b) => a + b, 0);
      return { n: arr.length, avg: +(sum / arr.length).toFixed(3), p50: +q(arr, 0.5).toFixed(3), p95: +q(arr, 0.95).toFixed(3), p99: +q(arr, 0.99).toFixed(3), max: +Math.max(...arr).toFixed(3) };
    };
    const p = window.__probe;
    const g = SB.game;
    const m = g.mode;
    const field = m.layout.field;
    const xs = field.map(z => z[0]), ys = field.map(z => z[1]);
    const out = m.stack.filter(s => s.cx < Math.min(...xs) || s.cx > Math.max(...xs) || s.cy > Math.max(...ys) || !isFinite(s.cx)).length;
    const raf = summarize(p.raf);
    return {
      scene: name,
      sampleMs: +(performance.now() - p.t0).toFixed(0),
      rafMs: raf,
      rafFps: raf.avg ? +(1000 / raf.avg).toFixed(1) : 0,
      stepMs: summarize(p.stepMs),
      droppedFrames: p.droppedFrames,
      longFrames: p.longFrames,
      recoveriesStarted: p.recoveriesStarted,
      recoveriesPeak: p.recoveriesPeak,
      sobos: m.world.sobos.length,
      stack: m.stack.length,
      score: m.score,
      merges: g.__mergeCount || 0,
      outOfField: out,
    };
  }, name);
}

// 直接以脚本方式发射（确定性，向下，左右散开），用于快速制造球堆。
// spread 控制水平分量大小，散得越开球越容易铺在底部、减少立即合并。
async function fireDense(page, shots, spread = 0.18, phase = 0) {
  let i = 0, waited = 0;
  while (i < shots && waited < 120) {
    const r = await page.evaluate(({ i, spread, phase }) => {
      const m = SB.game.mode;
      if (m.state !== 'playing') return { state: m.state };
      if (!m.selectable.length) return { wait: true };
      const s = m.selectable[0];
      const vx = Math.sin((i + phase) * 0.7) * spread;
      const vy = Math.sqrt(Math.max(0.001, 1 - vx * vx));
      m.launch(s, vx, vy);
      return { fired: true };
    }, { i, spread, phase });
    if (r.state) break;
    if (r.wait) { await sleep(220); waited++; continue; }
    i++;
    await sleep(180);
  }
  return i;
}

async function foregroundWindow(titleMatch) {
  if (process.platform !== 'win32') return;
  try {
    const ps = `Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public class AF{ [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);}
"@
$p=Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*凝合*' } | Select-Object -First 1
if($p){ [AF]::ShowWindow($p.MainWindowHandle,9) | Out-Null; [AF]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }`;
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', ps], { stdio: 'ignore' });
  } catch (_) {}
}

async function waitCDP(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await new Promise(res => {
      http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, r => { r.resume(); res(r.statusCode === 200); })
        .on('error', () => res(false));
    });
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  const errors = [];
  let proc = null, browser = null, page, ctx;
  const result = { label: LABEL, mode: EXE ? 'packaged' : 'web', ts: new Date().toISOString(), check: {}, perf: {} };

  if (EXE) {
    const exe = path.resolve(EXE);
    if (!fs.existsSync(exe)) throw new Error('exe 不存在：' + exe);
    proc = spawn(exe, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore' });
    proc.on('exit', code => { result.exeExitCode = code; });
    if (!(await waitCDP(PORT, 30000))) throw new Error('打包 EXE 调试端口未就绪');
    const pw = require(path.join(ROOT, 'tests', 'e2e', 'pw.js'));
    browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    ctx = browser.contexts()[0];
    await ctx.addInitScript(initScript());
    page = ctx.pages().find(p => p.url().includes('index.html')) || ctx.pages()[0];
  } else {
    const pw = require(path.join(ROOT, 'tests', 'e2e', 'pw.js'));
    browser = await pw.chromium.launch({ headless: false });
    ctx = await browser.newContext({ viewport: { width: WIN.w, height: WIN.h } });
    await ctx.addInitScript(initScript());
    page = await ctx.newPage();
    await page.goto(WEB);
  }

  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // 离线验证（打包版：模拟断网后 reload，本地协议资源必须仍可用）。
  if (EXE) {
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await sleep(1200);
    result.check.offlineReload = true;
  }

  await foregroundWindow();
  await installWorldProbe(page);

  // 标题页渲染（logo 是 canvas 绘制、不在 DOM 文本里；以标题屏状态 + 开始按钮 + 画布就绪判断）
  await page.waitForSelector('#btn-play', { timeout: 10000 });
  result.check.titleRendered = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return SB.game.app.screen === 'title' && !!document.querySelector('#btn-play') && !!c && c.width > 0;
  });

  // 开始新游戏
  await page.click('#btn-play');
  await page.waitForFunction(() => SB.game && SB.game.mode && SB.game.mode.state === 'playing', null, { timeout: 10000 });
  await sleep(2000); // 等入场球落位
  result.check.startedGame = true;

  // 普通场景：先发射几发，形成普通对局后采样
  const f1 = await fireDense(page, 6, 0.15, 0);
  result.check.normalShotsFired = f1;
  await sleep(2000);
  await foregroundWindow();
  result.perf.normal = await collect2(page, 'normal', 4000);

  // 密集场景：大散开连续发射，让球在底部铺成密集球堆后采样
  const f2 = await fireDense(page, DENSE_SHOTS, 0.42, f1);
  result.check.denseShotsFired = f1 + f2;
  await sleep(3500); // 让球堆稳定
  await foregroundWindow();
  result.perf.dense = await collect2(page, 'dense', 4000);

  // 行为断言
  result.check.mergesHappened = result.perf.dense.merges > 0;
  result.check.noOutOfField = result.perf.normal.outOfField === 0 && result.perf.dense.outOfField === 0;
  result.check.denseBallCount = result.perf.dense.sobos;
  result.check.noPageErrors = errors.length === 0;
  result.pageErrors = errors;
  // 密集场景待发队列仍在（上射合并留队：始终有可发射的球，或游戏仍在进行）
  result.check.queueAlive = await page.evaluate(() => {
    const m = SB.game.mode;
    return m.state === 'playing' && (m.selectable.length > 0 || m.emerging.length > 0 || m.stack.length > 0);
  });

  result.finalScore = await page.evaluate(() => SB.game.mode.score);
  result.userAgent = await page.evaluate(() => navigator.userAgent);
  result.viewport = page.viewportSize();
  result.url = page.url();

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));

  if (EXE) {
    // 打包版：让 Electron 自行退出（关闭 CDP 后），强杀兜底。
    try { await browser.close(); } catch (_) {}
    await sleep(500);
    try { process.kill(proc.pid); } catch (_) {}
    taskkillTree(proc.pid);
  } else {
    await browser.close();
  }
  process.exit(0);
}

function taskkillTree(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
}

main().catch(e => {
  console.error('验收失败：', e);
  process.exit(1);
});
