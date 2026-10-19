// 第二轮回归：入场球角色（emerging 禁合、进场后恢复可合并，不永久卡死）、
// 暂停模态（Esc 暂停 / 继续）、手机横竖屏切换后局面保留与续玩。
const { run, check, watch, mouseDrag, touchDrag, OUT } = require('./lib');

// 取一个可发射球与发射落点（向场地中部发射）。
async function aimPlan(p) {
  return p.evaluate(() => {
    const g = SB.game, m = g.mode, R = g.renderer;
    if (m.state !== 'playing' || g.app.screen !== 'play' || !m.selectable.length) return null;
    const s = m.selectable[0];
    return { a: R.toScreen(s.cx, s.cy), b: R.toScreen(s.cx + (s.cx > 0 ? -60 : 60), s.cy + 150) };
  });
}

// 角色不变量：入场球禁合、待发/已落地球可合，不存在永久卡在 emerging 的球。
async function roleInvariant(p) {
  return p.evaluate(() => {
    const m = SB.game.mode;
    const badBar = m.selectable.concat(m.stack).filter(s => !s.allowMerges).length;
    const emerging = m.emerging.map(s => !!s.allowMerges); // true 表示本应禁合却可合（异常）
    const emergingBad = emerging.filter(Boolean).length;
    return {
      selectable: m.selectable.length, stack: m.stack.length, emerging: m.emerging.length,
      badBar, emergingBad,
      total: m.world.sobos.length
    };
  });
}

run(async ({ browser, url, devices }) => {
  // ---------- 场景 A：桌面，入场角色 + 暂停模态 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    const errors = watch(p);
    await p.goto(url); await p.waitForTimeout(400);
    await p.click('#btn-play');
    // 等待首个球进场成为待发球。
    await p.waitForFunction(() => SB.game.mode.selectable.length > 0, null, { timeout: 15000 });

    // 进场后的待发球必须可合并（R2-1：不能永久禁合）。
    const first = await p.evaluate(() => SB.game.mode.selectable[0].allowMerges);
    check('进场后待发球允许合并', first === true, `allowMerges=${first}`);

    // 连续发射若干球，采样角色不变量：待发/落地的球都可合，入场球都禁合。
    let maxBad = 0, maxEmergingBad = 0;
    for (let i = 0; i < 6; i++) {
      const plan = await aimPlan(p);
      if (plan) { await mouseDrag(p, plan.a, plan.b); await p.waitForTimeout(700); }
      else await p.waitForTimeout(400);
      const st = await roleInvariant(p);
      maxBad = Math.max(maxBad, st.badBar);
      maxEmergingBad = Math.max(maxEmergingBad, st.emergingBad);
    }
    await p.waitForTimeout(1500);
    const settled = await roleInvariant(p);
    check('待发/落地球无一被永久禁合', maxBad === 0, `maxBad=${maxBad}`);
    check('入场阶段球一律禁合', maxEmergingBad === 0, `maxEmergingBad=${maxEmergingBad}`);
    // 进场流程通畅：出现过落地/待发球，且没有无限堆积的 emerging。
    check('入场流程正常流转（emerging 不堆积）', settled.emerging <= 2 && settled.total > 0,
      JSON.stringify(settled));

    // 暂停模态：Esc 暂停，继续按钮恢复。
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const paused = await p.evaluate(() => SB.game.app.screen);
    check('Esc 打开暂停模态', paused === 'paused' && await p.isVisible('#pause'), paused);
    await p.click('#btn-resume'); await p.waitForTimeout(300);
    const resumed = await p.evaluate(() => SB.game.app.screen);
    check('点继续回到游戏', resumed === 'play' && !(await p.isVisible('#pause')), resumed);
    await p.screenshot({ path: OUT + '/regression-desktop.png' });
    check('桌面场景无页面错误', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------- 场景 B：手机，横竖屏切换后局面保留与续玩 ----------
  {
    const ctx = await browser.newContext(devices['iPhone 13']);
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    const errors = watch(p);
    await p.goto(url); await p.waitForTimeout(500);
    await p.tap('#btn-play'); await p.waitForTimeout(2500);
    // 发射两球，等落地。
    for (let i = 0; i < 2; i++) {
      const plan = await aimPlan(p);
      if (plan) { await touchDrag(p, cdp, plan.a, plan.b); await p.waitForTimeout(1000); }
    }
    await p.waitForTimeout(1200);
    const N = await p.evaluate(() => SB.game.mode.world.sobos.length);
    check('手机已形成局面', N >= 1, `N=${N}`);

    // 横屏：暂停并提示旋转。
    await p.setViewportSize({ width: 750, height: 342 });
    await p.waitForTimeout(500);
    const side = await p.evaluate(() => [SB.game.app.screen, getComputedStyle(document.getElementById('rotate')).display]);
    check('横屏暂停并显示旋转提示', side[0] === 'paused' && side[1] !== 'none', side.join());
    // 暂停期间局面冻结。
    const frozenN = await p.evaluate(() => SB.game.mode.world.sobos.length);
    check('横屏暂停期间球数不变', frozenN === N, `${frozenN} vs ${N}`);

    // 回竖屏：提示隐藏，但仍处暂停（需主动继续）。
    await p.setViewportSize({ width: 390, height: 664 });
    await p.waitForTimeout(500);
    const up = await p.evaluate(() => [SB.game.app.screen, getComputedStyle(document.getElementById('rotate')).display]);
    check('回竖屏隐藏旋转提示', up[1] === 'none', up.join());
    await p.click('#btn-resume');
    // 继续后游戏恢复，可能立刻正常生成新球；核心是旋转/暂停不丢球，故只要求原球都在（≥N）。
    const backN = await p.evaluate(() => SB.game.mode.world.sobos.length);
    check('回竖屏继续后局面不丢球', backN >= N, `${backN} vs ${N}`);

    // 旋转后刷新仍可续玩，局面不丢。
    await p.evaluate(() => SB.game.pause());
    await p.reload(); await p.waitForTimeout(600);
    check('旋转后刷新提供继续游戏', await p.isVisible('#btn-continue'));
    await p.click('#btn-continue'); await p.waitForTimeout(300);
    const resumeN = await p.evaluate(() => SB.game.mode.world.sobos.length);
    check('刷新续玩保留局面', resumeN >= N, `${resumeN} vs ${N}`);
    await p.screenshot({ path: OUT + '/regression-phone-resume.png' });
    check('手机场景无页面错误', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
});
