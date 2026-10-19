// After one online visit the service worker serves everything offline.
const { run, check, watch } = require('./lib');

run(async ({ browser, url, devices }) => {
  const ctx = await browser.newContext(devices['iPhone 13']);
  const p = await ctx.newPage();
  await p.goto(url);
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.waitForTimeout(800);
  await ctx.setOffline(true);
  const errors = watch(p);
  await p.reload(); await p.waitForTimeout(800);
  await p.tap('#btn-play'); await p.waitForTimeout(500);
  const r = await p.evaluate(async () => { await document.fonts.ready; return { screen: SB.game.app.screen, font: document.fonts.check('15px "Souba Score"') }; });
  check('plays offline', r.screen === 'play');
  check('fonts come from the offline cache', r.font);
  check('no page errors offline', errors.length === 0, errors.join(' | '));
});
