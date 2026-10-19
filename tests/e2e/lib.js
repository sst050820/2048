// Shared helpers for the browser tests: a local server, Chromium, checks,
// and real mouse and touch drags.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const pw = require('./pw');

const ROOT = path.join(__dirname, '..', '..');
const OUT = process.env.OUT || path.join(ROOT, 'out', 'e2e');
fs.mkdirSync(OUT, { recursive: true });

let fails = 0;
function check(name, ok, info) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : ''));
  if (!ok) fails++;
}

// Serves www/ on a random local port for the life of the test.
async function serve() {
  const port = 8100 + Math.floor(Math.random() * 800);
  const proc = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(res => proc.stdout.once('data', res));
  return { url: `http://localhost:${port}/`, stop: () => proc.kill() };
}

// Runs a test body with a browser and a server, then exits with the result.
async function run(body) {
  const server = await serve();
  const browser = await pw.chromium.launch();
  try { await body({ browser, url: server.url, devices: pw.devices }); }
  catch (e) { check('test ran to the end', false, e.stack); }
  finally { await browser.close(); server.stop(); }
  process.exit(fails ? 1 : 0);
}

// Collects page errors so each test can assert there were none.
function watch(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

// Screen position of a world point.
function screenOf(page, x, y) { return page.evaluate(([x, y]) => SB.game.renderer.toScreen(x, y), [x, y]); }

// A real touch drag through the DevTools protocol (pointerType 'touch').
async function touchDrag(page, cdp, a, b, steps = 6) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function mouseDrag(page, a, b, steps = 6) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

module.exports = { ROOT, OUT, check, run, watch, screenOf, touchDrag, mouseDrag };
