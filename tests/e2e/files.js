// The game works opened straight from disk, both www/index.html and the
// single-file build.
const { execFileSync } = require('child_process');
const path = require('path');
const { run, check, watch, screenOf, mouseDrag, ROOT } = require('./lib');

run(async ({ browser }) => {
  const single = path.join(ROOT, 'out', 'soboscuba-single.html');
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-single.js'), single]);
  for (const f of [path.join(ROOT, 'www', 'index.html'), single]) {
    const name = path.basename(f);
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = watch(p);
    await p.goto('file://' + f);
    await p.click('#btn-play'); await p.waitForTimeout(2500);
    const s = await p.evaluate(() => { const s = SB.game.mode.selectable[0]; return { x: s.cx, y: s.cy }; });
    const a = await screenOf(p, s.x, s.y);
    await mouseDrag(p, a, { x: a.x, y: a.y + 100 });
    await p.waitForTimeout(400);
    const r = await p.evaluate(async () => {
      await document.fonts.ready;
      return { stack: SB.game.mode.stack.length, font: document.fonts.check('15px "Souba Score"') };
    });
    check(`${name}: plays from disk`, r.stack === 1);
    check(`${name}: score font loads`, r.font);
    check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
    await p.close();
  }
});
