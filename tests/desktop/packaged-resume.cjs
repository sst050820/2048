'use strict';
/*
 * 阶段6 打包成品“关闭续玩”验收（真实 %APPDATA%\\Ninghe）。
 *
 * 启动打包 EXE（CDP）→ 新游戏并发射几球形成分数 → 发 WM_CLOSE（等同点 X，
 * 走关窗保存握手）→ 重新启动 → 点“继续游戏”→ 比对分数与球数。
 *
 * 用法：node tests/desktop/packaged-resume.cjs --exe "<解压目录>\凝合.exe"
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
const EXE = path.resolve(arg('exe'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pw = require(path.join(ROOT, 'tests', 'e2e', 'pw.js'));

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
    Math.random = mulberry32(20261019);
  };
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

function killTree(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
}

function sendClose() {
  const ps = `Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public class CL{ [DllImport("user32.dll")] public static extern int PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}
"@
$p=Get-Process -Name '凝合' | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if($p){ [CL]::PostMessage($p.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null; 'posted' } else { 'no-window' }`;
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
}

let proc = null;
async function launch(port, { offline } = {}) {
  const p = spawn(EXE, [`--remote-debugging-port=${port}`], { stdio: 'ignore' });
  proc = p;
  if (!(await waitCDP(port, 30000))) throw new Error('端口未就绪');
  const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  await ctx.addInitScript(initScript());
  const page = ctx.pages().find(x => x.url().includes('index.html')) || ctx.pages()[0];
  page.on('pageerror', e => console.error('pageerror:', e.message));
  if (offline) {
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await sleep(1000);
  }
  return { browser, ctx, page };
}

async function state(page) {
  return page.evaluate(() => {
    const m = SB.game.mode;
    return {
      score: m.score,
      sobos: m.world.sobos.length,
      stack: m.stack.length,
      selectable: m.selectable.length,
      emerging: m.emerging.length,
      layout: m.layoutName,
      state: m.state,
    };
  });
}

async function fire(page, n) {
  for (let i = 0; i < n; i++) {
    let waited = 0;
    while (waited < 60) {
      const r = await page.evaluate((i) => {
        const m = SB.game.mode;
        if (m.state !== 'playing') return { state: m.state };
        if (!m.selectable.length) return { wait: true };
        const s = m.selectable[0];
        const vx = Math.sin(i * 0.9) * 0.2;
        const vy = Math.sqrt(1 - vx * vx);
        m.launch(s, vx, vy);
        return { fired: true };
      }, i);
      if (r.state) return;
      if (r.wait) { await sleep(220); waited++; continue; }
      break;
    }
    await sleep(350);
  }
}

async function main() {
  const out = { exe: EXE, ts: new Date().toISOString() };

  // 第一次：断网启动、新游戏、发射形成分数
  const a = await launch(9240, { offline: true });
  await a.page.waitForSelector('#btn-play', { timeout: 10000 });
  await a.page.click('#btn-play');
  await a.page.waitForFunction(() => SB.game.mode && SB.game.mode.state === 'playing', null, { timeout: 10000 });
  await sleep(2000);
  await fire(a.page, 5);
  await sleep(3500); // 让球堆静止、合并完成
  await a.page.evaluate(() => SB.game.pause()); // 暂停冻结物理，保证快照与保存一致
  await sleep(600);
  out.before = await state(a.page);
  out.offlinePlay = true;
  try { await a.browser.close(); } catch (_) {}

  // 发 WM_CLOSE（等同点 X），等待正常关窗保存握手完成
  const t0 = Date.now();
  const posted = sendClose();
  await new Promise((res) => {
    const iv = setInterval(() => {
      try { execSync('tasklist /FI "IMAGENAME eq 凝合.exe" /NH', { encoding: 'utf8' }); } catch (_) {}
      let gone = false;
      try {
        const list = execSync('tasklist /FI "IMAGENAME eq 凝合.exe" /NH', { encoding: 'utf8' });
        gone = !list.includes('凝合.exe');
      } catch (_) { gone = true; }
      if (gone || Date.now() - t0 > 15000) { clearInterval(iv); res(); }
    }, 300);
  });
  out.closeMs = Date.now() - t0;
  out.closePosted = posted;
  try { process.kill(proc.pid); } catch (_) {}
  killTree(proc.pid);
  await sleep(1500);

  // 第二次：断网重开，点继续
  const b = await launch(9241, { offline: true });
  await b.page.waitForSelector('#btn-play', { timeout: 10000 });
  const hasContinue = await b.page.evaluate(() => !document.querySelector('#btn-continue').hidden);
  out.resumeButtonVisible = hasContinue;
  await b.page.click('#btn-continue');
  await b.page.waitForFunction(() => SB.game.mode && SB.game.mode.state === 'playing', null, { timeout: 10000 });
  await b.page.evaluate(() => SB.game.pause()); // 立即暂停冻结，避免恢复后物理推进再读数
  await sleep(300);
  out.after = await state(b.page);

  // 比对
  out.match = {
    score: out.before.score === out.after.score,
    sobos: out.before.sobos === out.after.sobos,
    stack: out.before.stack === out.after.stack,
    layout: out.before.layout === out.after.layout,
  };
  out.pass = out.resumeButtonVisible && out.match.score && out.match.sobos && out.match.layout;
  try { await b.browser.close(); } catch (_) {}
  try { process.kill(proc.pid); } catch (_) {}
  killTree(proc.pid);

  fs.mkdirSync(path.join(ROOT, 'out', 'acceptance'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'acceptance', 'resume.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

main().catch(e => { console.error('关闭续玩验收失败：', e); try { killTree(proc.pid); } catch (_) {} process.exit(1); });
