// Headless classic-mode rule checks against docs/original-spec.md.
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }
function seed(n) { let s = n; Math.random = () => (s = (s * 16807) % 2147483647) / 2147483647; }
function run(m, ticks) { for (let i = 0; i < ticks; i++) m.tick(); }

// 1. Spawning: the first sobo comes from the right, flies in through the wall
//    and becomes selectable; the pool starts as just the 1s.
{
  seed(1);
  const sides = [], m = new SB.Classic('mobile', { spawn: (s, side) => sides.push(side) });
  run(m, 1);
  check('first spawn is on the right', sides[0] === 1);
  check('spawned sobo cannot merge while emerging', m.emerging.length === 1 && !m.emerging[0].allowMerges);
  run(m, 60);
  check('it becomes selectable once inside', m.selectable.length === 1 && m.emerging.length === 0);
  run(m, 600);
  const s = m.selectable[0];
  check('it floats on the bar', Math.abs(s.cy - m.layout.barY) < 6, `cy=${s.cy.toFixed(1)}`);
  check('pool starts at tier 0 only', m.pool.join() === '0');
}

// 2. Launch, merge and score: two launched 1s merge into a 2 worth 2 points.
{
  seed(2);
  const gains = [], m = new SB.Classic('mobile', { gain: n => gains.push(n) });
  let guard = 0;
  while (m.score === 0 && guard++ < 60) {
    run(m, 30);
    if (m.selectable.length) m.launch(m.selectable[0], 0, 0.6);
    run(m, 90);
  }
  check('launched sobos merge and score', m.score >= 2 && gains[0] === 2, `score=${m.score} gains=${gains.slice(0, 3)}`);
  check('merged sobo is flagged', m.world.sobos.some(s => s.merged));
  check('merging into a 2 unlocks tier 1 spawns', m.pool.indexOf(1) >= 0, `pool=${m.pool}`);
}

// 3. One merge per tick, lowest contact first.
{
  const m = new SB.Classic('desktop', {}), w = m.world;
  const pairs = [[-150, 250], [150, 100]].map(([x, y]) => [new SB.Sobo(0, x - 25, y), new SB.Sobo(0, x + 25, y)]);
  pairs.flat().forEach(s => { w.add(s); m._stack(s); });
  let merges = [];
  m.hooks.merge = (A, B, N, x, y) => merges.push({ tick: m.ticks, y });
  run(m, 3);
  const firstTick = merges.filter(e => e.tick === merges[0].tick);
  check('only one merge per tick', merges.length >= 1 && firstTick.length === 1, `merges=${JSON.stringify(merges)}`);
  check('the lowest contact merges first', merges[0].y > 200);
}

// 4. Both bumpers fully out ends the game after the 3 s freeze.
{
  const ev = [], m = new SB.Classic('mobile', { preGameOver: () => ev.push('pre'), gameOver: () => ev.push('over') });
  run(m, 10);
  m.sides.forEach(s => { s.bumper.x = s.bumper.restX + s.bumper.dir * 32; s.bumper.vx = 0; });
  run(m, 2);
  check('both bumpers held starts pre-game-over', m.state === 'pregameover' && ev[0] === 'pre');
  const frozen = m.world.sobos.map(s => s.cx).join();
  run(m, 60);
  check('the board is frozen', m.world.sobos.map(s => s.cx).join() === frozen);
  for (let i = 0; i < 200; i++) m.frame(1 / 60);
  check('game over after 3 s', m.state === 'gameover' && ev[1] === 'over');
}

// 5. One bumper alone never ends the game, and holding lapses 0.5 s after release.
{
  const m = new SB.Classic('mobile', {});
  m.sides[0].bumper.x = m.sides[0].bumper.restX - 32;
  run(m, 2);
  check('one bumper held is only a warning', m.state === 'playing' && m.sides[0].holding);
  run(m, 60);
  check('holding lapses after release', !m.sides[0].holding);
}

// 6. Save and restore round trip.
{
  seed(3);
  const m = new SB.Classic('desktop', {});
  for (let k = 0; k < 12; k++) { run(m, 60); if (m.selectable.length) m.launch(m.selectable[0], (k % 3 - 1) * 0.3, 0.5); }
  run(m, 30);
  const data = JSON.parse(JSON.stringify(m.capture()));
  const n = new SB.Classic('desktop', {});
  check('restore accepts a v3 save', n.restore(data));
  check('restore keeps every sobo and role', n.world.sobos.length === m.world.sobos.length && n.stack.length === m.stack.length && n.selectable.length === m.selectable.length,
    `${n.world.sobos.length}/${m.world.sobos.length}`);
  check('restore keeps score and pool', n.score === m.score && n.pool.join() === m.pool.join());
  check('a save for the other layout is refused', !new SB.Classic('mobile', {}).restore(data));
  run(n, 120);
  check('restored game keeps running', n.world.sobos.every(s => isFinite(s.cx)));
}

// 7. Achievements: lineage chains, bar sizes, the exact-score set.
{
  const got = [], t = new SB.Achievements.Tracker(id => got.push(id));
  const mk = v => ({ value: v, dead: false });
  let head = mk(2); t.merge(mk(1), mk(1), head, false);
  for (let v = 4; v <= 16; v *= 2) { const n = mk(v); t.merge(head, mk(v / 2), n, false); head.dead = true; head = n; }
  check('a 1 to 16 lineage earns chain 1-16', got.indexOf('chain_1_16') >= 0, got.join());
  t.barJoin({ value: 64 });
  check('a 64 on the bar earns bar 64', got.indexOf('bar_64') >= 0);
  t.gameOver(0);
  check('a final score of 0 earns score 0', got.indexOf('score_0') >= 0);
  check('there are 30 achievements', SB.Achievements.DEFS.length === 30);
  check('28 themes, dark mode first', SB.STYLES.length === 28 && SB.STYLES[0].id === 'dark_mode');
}
// 8. 最高等级不被 mode 升级；同帧存在低级接触时，低级仍按原优先级合并。
{
  const MAX = SB.TIERS.length - 1;
  // 仅有最高等级接触：不合并、不抛错。
  const m = new SB.Classic('mobile', {});
  const a = new SB.Sobo(MAX, 0, 0), b = new SB.Sobo(MAX, 0, 0);
  a.allowMerges = b.allowMerges = true;
  m.world.add(a); m.world.add(b);
  m.world.pairs = [{ a, b, ia: 0, ib: 0, y: 0 }];
  let threw = false;
  try { m._merges(); } catch (e) { threw = true; }
  check('最高等级接触不被升级', !threw && m.world.sobos.length === 2 && m.world.sobos.every(s => s.tier === MAX), `threw=${threw} n=${m.world.sobos.length}`);

  // 同时存在最高等级（y=0）与低级（y=-10）接触：低级应合并，最高级保留。
  const m2 = new SB.Classic('mobile', {});
  const hi1 = new SB.Sobo(MAX, 0, 0), hi2 = new SB.Sobo(MAX, 0, 0);
  const lo1 = new SB.Sobo(0, 0, 0), lo2 = new SB.Sobo(0, 0, 0);
  [hi1, hi2, lo1, lo2].forEach(s => { s.allowMerges = true; m2.world.add(s); });
  m2.world.pairs = [
    { a: hi1, b: hi2, ia: 0, ib: 0, y: 0 },
    { a: lo1, b: lo2, ia: 0, ib: 0, y: -10 }
  ];
  m2._merges();
  const maxKept = m2.world.sobos.filter(s => s.tier === MAX).length;
  const lowMerged = m2.world.sobos.some(s => s.tier === 1);
  check('跳过最高级后同帧低级仍合并', maxKept === 2 && lowMerged, `maxKept=${maxKept} lowMerged=${lowMerged}`);
}

// 9. 损坏存档的原子性：失败不抛、不破坏当前局面、不静默丢球。
{
  seed(7);
  const src = new SB.Classic('mobile', {});
  run(src, 300);
  const good = JSON.parse(JSON.stringify(src.capture()));
  const listName = good.stack.length ? 'stack' : good.selectable.length ? 'selectable' : 'emerging';
  const base = new SB.Classic('mobile', {});
  check('合法存档基线 restore 通过', base.restore(JSON.parse(JSON.stringify(good))));

  function expectFail(name, mut) {
    const d = JSON.parse(JSON.stringify(good));
    mut(d);
    // 在一个已有球的局面上恢复，失败后该球必须仍在（验证不清空局面）。
    const t = new SB.Classic('mobile', {});
    const existing = new SB.Sobo(1, 0, 0);
    t.world.add(existing); t.stack.push(existing);
    let threw = false, r;
    try { r = t.restore(d); } catch (e) { threw = true; }
    check(name, r === false && !threw && t.world.sobos.length === 1 && t.stack[0] === existing,
      `r=${r} threw=${threw} sobos=${t.world.sobos.length}`);
  }
  expectFail('缺少 pool', d => { delete d.pool; });
  expectFail('空生成池 pool=[]', d => { d.pool = []; });
  expectFail('生成池不含基础球 tier0', d => { d.pool = [2, 3]; });
  expectFail('pool 非数组', d => { d.pool = {}; });
  expectFail('原型链布局名 __proto__', d => { d.layout = '__proto__'; });
  expectFail('原型链布局名 constructor', d => { d.layout = 'constructor'; });
  expectFail('tier=20（不存在等级）', d => { d[listName][0].t = 20; });
  expectFail('p 数组少一项', d => { d[listName][0].p.pop(); });
  expectFail('非有限坐标', d => { d[listName][0].p[0] = NaN; });
  expectFail('非有限速度', d => { d[listName][0].p[2] = Infinity; });
  expectFail('bumpers 缺失', d => { d.bumpers = []; });
  expectFail('错误布局', d => { d.layout = 'desktop'; });
}

// 9b. 构造函数对原型链/未知布局名安全回退到 mobile，且布局结构完整（不崩）。
{
  for (const name of ['__proto__', 'constructor', 'prototype', 'bogus', undefined, null, 123]) {
    const m = new SB.Classic(name, {});
    check(`布局名 ${String(name)} 安全回退 mobile`,
      m.layoutName === 'mobile' && Array.isArray(m.layout.field) && Array.isArray(m.layout.sides) && m.layout.sides.length === 2);
  }
  const ok = new SB.Classic('desktop', {});
  check('合法 desktop 布局保留', ok.layoutName === 'desktop' && ok.layout.sides.length === 2);
}

// 10. 续玩成就历史：capture/restore 后进度一致、球引用映射正确、悬空球过滤、旧存档保守。
{
  const tracker = new SB.Achievements.Tracker(() => {});
  // 1+1 → 2
  const a = new SB.Sobo(0, 0, 0), b = new SB.Sobo(0, 0, 0), n1 = new SB.Sobo(1, 0, 0);
  tracker.merge(a, b, n1, false);
  // 2+2 → 4（消费上一步结果 n1，形成 1→2→4 连续 lineage）
  const e = new SB.Sobo(1, 0, 0), n2 = new SB.Sobo(2, 0, 0);
  tracker.merge(n1, e, n2, false);

  // 场上只有最终球 n2；已被消费的祖先不在存档球列表中。
  const captured = tracker.capture([n2]);
  check('capture 记录 bigMerge', captured.bigMerge === true);
  const c1 = captured.chains.find(c => c.start === 1);
  check('capture chain 起点/序号/值', !!c1 && c1.head === 0 && c1.value === 4, JSON.stringify(captured.chains));
  check('capture air 只映射现存球（悬空祖先过滤）', captured.air.length === 1 && captured.air[0].i === 0, JSON.stringify(captured.air));

  // 恢复：用一个全新的 tier2 球代表恢复后的 n2。
  const n2r = new SB.Sobo(2, 0, 0);
  const t2 = new SB.Achievements.Tracker(() => {});
  t2.restore(captured, [n2r]);
  check('restore bigMerge', t2.bigMerge === true);
  const r1 = t2.chains.find(c => c.start === 1);
  check('restore chain head 映射到新球', !!r1 && r1.head === n2r && r1.value === 4);
  check('restore air 映射到新球', t2.air.length === 1 && t2.air[0].sobo === n2r);

  // 恢复后 lineage 可继续向 8 延伸。
  const f = new SB.Sobo(2, 0, 0), n3 = new SB.Sobo(3, 0, 0);
  t2.merge(n2r, f, n3, false);
  const e1 = t2.chains.find(c => c.start === 1);
  check('恢复后 lineage 继续延伸', !!e1 && e1.head === n3 && e1.value === 8);

  // 旧存档无 tracker：保守 bigMerge=true，其余为空，避免误解锁"不合成"。
  const t3 = new SB.Achievements.Tracker(() => {});
  t3.restore(undefined, []);
  check('旧存档保守 bigMerge=true', t3.bigMerge === true && t3.chains.length === 0 && t3.air.length === 0);
}
process.exit(fails ? 1 : 0);
