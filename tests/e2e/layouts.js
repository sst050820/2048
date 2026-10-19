// Every screen shape shows the whole field with the HUD clear of it.
const { run, check, watch, OUT } = require('./lib');

run(async ({ browser, url, devices }) => {
  const cfgs = [['iphone-se', devices['iPhone SE']], ['iphone-15-pro-max', devices['iPhone 15 Pro Max']], ['ipad', devices['iPad Pro 11']],
    ['ipad-landscape', devices['iPad Pro 11 landscape']], ['laptop', { viewport: { width: 1366, height: 768 } }], ['desktop-4k', { viewport: { width: 1920, height: 1080 } }],
    ['narrow-window', { viewport: { width: 700, height: 900 } }]];
  for (const [name, dev] of cfgs) {
    const ctx = await browser.newContext(dev);
    const p = await ctx.newPage();
    const errors = watch(p);
    await p.goto(url); await p.waitForTimeout(500);
    await p.screenshot({ path: `${OUT}/layout-${name}-title.png` });
    await p.click('#btn-play'); await p.waitForTimeout(2500);
    const r = await p.evaluate(() => {
      const g = SB.game, R = g.renderer, m = g.mode, P = m.layout.play, v = R.view;
      const pts = [[P.x0, P.y0], [P.x1, P.y0], [P.x0, P.y1], [P.x1, P.y1]].map(q => R.toScreen(q[0], q[1]));
      const inside = pts.every(q => q.x >= -1 && q.y >= -1 && q.x <= v.w + 1 && q.y <= v.h + 1);
      const fieldTop = Math.min(...pts.map(q => q.y));
      const hudClear = v.desktop ? v.side >= 0 : v.topPanel.y + v.topPanel.h <= fieldTop + 1;
      return { inside, hudClear, layout: m.layoutName, zoom: R.scale().toFixed(2) };
    });
    await p.screenshot({ path: `${OUT}/layout-${name}-game.png` });
    check(`${name}: whole play area on screen`, r.inside, JSON.stringify(r));
    check(`${name}: HUD clear of the field`, r.hudClear);
    check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
});
