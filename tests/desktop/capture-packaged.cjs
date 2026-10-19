'use strict';
// 打包版游戏内截图：启动 EXE(CDP) → 新游戏 → 发射若干球 → 截图。
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');
const exe = path.resolve(process.argv[process.argv.indexOf('--exe') + 1]);
const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9250);
const out = process.argv[process.argv.indexOf('--out') + 1];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pw = require(path.join(ROOT, 'tests', 'e2e', 'pw.js'));

function waitCDP() {
  return new Promise(res => {
    const t0 = Date.now();
    (function poll() {
      http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, r => {
        r.resume(); res();
      }).on('error', () => Date.now() - t0 > 30000 ? res(new Error('cdp timeout')) : setTimeout(poll, 400));
    })();
  });
}

(async () => {
  const proc = spawn(exe, [`--remote-debugging-port=${port}`], { stdio: 'ignore' });
  await waitCDP();
  const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(x => x.url().includes('index.html')) || ctx.pages()[0];
  await page.waitForSelector('#btn-play', { timeout: 10000 });
  await page.click('#btn-play');
  await page.waitForFunction(() => SB.game.mode && SB.game.mode.state === 'playing', null, { timeout: 10000 });
  await sleep(2000);
  for (let i = 0; i < 9; i++) {
    let waited = 0;
    while (waited < 60) {
      const r = await page.evaluate((i) => {
        const m = SB.game.mode;
        if (m.state !== 'playing') return { state: m.state };
        if (!m.selectable.length) return { wait: true };
        const s = m.selectable[0];
        const vx = Math.sin(i * 0.9) * 0.22;
        const vy = Math.sqrt(1 - vx * vx);
        m.launch(s, vx, vy);
        return { fired: true };
      }, i);
      if (r.state) break;
      if (r.wait) { await sleep(220); waited++; continue; }
      break;
    }
    await sleep(420);
  }
  await sleep(2500);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log('saved', out);
  await browser.close().catch(() => {});
  try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
