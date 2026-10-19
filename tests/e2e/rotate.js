// Turning a phone sideways pauses the game and asks to rotate back.
const { run, check, watch, OUT } = require('./lib');

run(async ({ browser, url, devices }) => {
  const ctx = await browser.newContext(devices['iPhone 13']);
  const p = await ctx.newPage();
  const errors = watch(p);
  await p.goto(url);
  await p.tap('#btn-play'); await p.waitForTimeout(400);
  await p.setViewportSize({ width: 750, height: 342 });
  await p.waitForTimeout(500);
  const side = await p.evaluate(() => [SB.game.app.screen, getComputedStyle(document.getElementById('rotate')).display]);
  await p.screenshot({ path: OUT + '/rotate.png' });
  check('sideways phone pauses', side[0] === 'paused', side[0]);
  check('sideways phone shows the rotate prompt', side[1] !== 'none');
  await p.setViewportSize({ width: 390, height: 664 });
  await p.waitForTimeout(400);
  const up = await p.evaluate(() => [SB.game.mode.layoutName, getComputedStyle(document.getElementById('rotate')).display]);
  check('upright again hides the prompt and keeps the phone layout', up[0] === 'mobile' && up[1] === 'none', up.join());
  check('no page errors', errors.length === 0, errors.join(' | '));
});
