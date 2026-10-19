// Renders the same mid-game board in every colour theme for a visual check.
const { run, check, watch, OUT } = require('./lib');
const IDS = require('../node/harness').STYLES.map(s => s.id);

run(async ({ browser, url }) => {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = watch(p);
  await p.addInitScript(ids => {
    let s = 7; Math.random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    localStorage.setItem('soboscuba.styleUnlocks', JSON.stringify(ids));
  }, IDS);
  await p.goto(url); await p.waitForTimeout(500);
  await p.click('#btn-play'); await p.waitForTimeout(2000);
  await p.evaluate(() => {
    const m = SB.game.mode; m.hooks = {};
    for (let t = 0; t < 70 * 60; t++) {
      m.tick();
      if (t % 70 === 0 && m.selectable.length && m.state === 'playing') {
        const s = m.selectable[0], o = m.stack.find(q => q.value === s.value);
        const dx = o ? o.cx - s.cx : (Math.random() - 0.5) * 120, dy = o ? o.cy - s.cy : 200, d = Math.hypot(dx, dy);
        m.launch(s, dx / d * 0.55, dy / d * 0.55);
      }
    }
    m.tick = () => {};
    SB.game.renderer.snap();
  });
  for (const id of IDS) {
    const ok = await p.evaluate(id => SB.game.setStyle(id) && SB.game.style === id, id);
    await p.waitForTimeout(150);
    await p.screenshot({ path: `${OUT}/theme-${id}.png` });
    if (!ok) check(`theme ${id} applies`, false);
  }
  check('every theme renders', true, `${IDS.length} themes in ${OUT}`);
  check('no page errors', errors.length === 0, errors.join(' | '));
});
