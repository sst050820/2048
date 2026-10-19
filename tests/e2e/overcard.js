// The game over numbers stay on one line, even six digits on the narrowest phone.
const { run, check, watch, OUT } = require('./lib');

run(async ({ browser, url, devices }) => {
  const ctx = await browser.newContext(devices['iPhone SE']);
  const p = await ctx.newPage();
  const errors = watch(p);
  await p.goto(url); await p.waitForTimeout(500);
  await p.tap('#btn-play'); await p.waitForTimeout(1500);
  await p.evaluate(() => { const m = SB.game.mode; m.score = 123456; m.biggest = 16384; m.sides.forEach(s => { s.bumper.x = s.bumper.restX + s.bumper.dir * 32; }); });
  await p.waitForFunction(() => document.getElementById('over-score').textContent === '123456', null, { timeout: 20000 });
  const cells = await p.evaluate(() => [...document.querySelectorAll('.stats dd')].map(d => {
    const cs = getComputedStyle(d), r = d.getBoundingClientRect(), box = d.parentElement.getBoundingClientRect();
    return { text: d.textContent, lines: Math.round(r.height / (parseFloat(cs.fontSize) * 1.2)), fits: d.scrollWidth <= box.width };
  }));
  await p.screenshot({ path: OUT + '/overcard-iphone-se.png' });
  for (const c of cells) check(`"${c.text}" sits on one line inside its box`, c.lines <= 1 && c.fits, JSON.stringify(c));
  check('scores have no thousands separator', cells[0].text === '123456');
  check('no page errors', errors.length === 0, errors.join(' | '));
});
