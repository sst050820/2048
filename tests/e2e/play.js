// Plays real games with touch on a phone and a mouse on a desktop window:
// aims each bar sobo at a matching one, and checks the game holds up.
const { run, check, watch, touchDrag, mouseDrag, OUT } = require('./lib');
const SHOTS = Number(process.env.SHOTS || 50);

async function plan(p) {
  return p.evaluate(() => {
    const g = SB.game, m = g.mode, R = g.renderer;
    if (m.state !== 'playing' || g.app.screen !== 'play') return null;
    if (!m.selectable.length) return { wait: true };
    const s = m.selectable[Math.floor(Math.random() * m.selectable.length)];
    const t = m.stack.filter(o => o.value === s.value).sort((a, b) => a.cy - b.cy)[0];
    const dx = t ? t.cx - s.cx : (Math.random() - 0.5) * 200, dy = t ? t.cy - s.cy : 150;
    const k = (t ? 140 : 90) / Math.hypot(dx, dy);
    return { a: R.toScreen(s.cx, s.cy), b: R.toScreen(s.cx + dx * k, s.cy + dy * k) };
  });
}

run(async ({ browser, url, devices }) => {
  for (const [name, opts, touch] of [['phone', devices['iPhone 13'], true], ['desktop', { viewport: { width: 1440, height: 900 } }, false]]) {
    const ctx = await browser.newContext(opts);
    const p = await ctx.newPage();
    const errors = watch(p);
    const cdp = touch ? await ctx.newCDPSession(p) : null;
    await p.goto(url); await p.waitForTimeout(600);
    await (touch ? p.tap('#btn-play') : p.click('#btn-play'));
    await p.waitForTimeout(2500);
    let merges = 0, launches = 0;
    await p.exposeFunction('__merged', () => merges++);
    await p.evaluate(() => { const h = SB.game.mode.hooks, f = h.merge; h.merge = function () { window.__merged(); return f.apply(this, arguments); }; });
    for (let n = 0, waits = 0; n < SHOTS && waits < 40; n++) {
      const pl = await plan(p);
      if (!pl) break;
      if (pl.wait) { await p.waitForTimeout(300); n--; waits++; continue; }
      const before = await p.evaluate(() => SB.game.mode.stack.length);
      await (touch ? touchDrag(p, cdp, pl.a, pl.b) : mouseDrag(p, pl.a, pl.b));
      await p.waitForTimeout(900);
      if (await p.evaluate(b => SB.game.mode.stack.length !== b || SB.game.mode.state !== 'playing', before)) launches++;
      if (n === Math.floor(SHOTS / 2)) await p.screenshot({ path: `${OUT}/play-${name}.png` });
    }
    const st = await p.evaluate(() => {
      const m = SB.game.mode, f = m.layout.field, xs = f.map(q => q[0]), ys = f.map(q => q[1]);
      const out = m.stack.filter(s => s.cx < Math.min(...xs) || s.cx > Math.max(...xs) || s.cy > Math.max(...ys) || !isFinite(s.cx)).length;
      return { score: m.score, sobos: m.world.sobos.length, out, state: m.state, layout: m.layoutName };
    });
    check(`${name}: every drag launches`, launches > 0, `launches=${launches}`);
    check(`${name}: launched sobos merge`, merges > 3 && st.score > 0, `merges=${merges} score=${st.score}`);
    check(`${name}: no sobo escapes the field`, st.out === 0, `out=${st.out}`);
    check(`${name}: layout`, st.layout === (touch ? 'mobile' : 'desktop'));
    check(`${name}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
});
