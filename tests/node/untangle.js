// 合并颈部自交回归：两个同级球快速合并后，新球不得出现非相邻边交叉。
// 覆盖：报告点名场景、完整等级×速度×角度×放置顺序矩阵、n-1→0 接缝不变性、
// 以及“真实凹陷不是自交，不得被理顺”。
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

// 非相邻边严格相交（拓扑自交）检测，与 physics.js 的 segCross 同判据。
function crossings(s) {
  const hits = [];
  for (let i = 0; i < s.n; i++) {
    for (let j = i + 2; j < s.n; j++) {
      const k = (i + 1) % s.n, l = (j + 1) % s.n;
      if (l === i) continue;
      const f = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (f(s.x[i], s.y[i], s.x[k], s.y[k], s.x[j], s.y[j])
        * f(s.x[i], s.y[i], s.x[k], s.y[k], s.x[l], s.y[l]) < 0
        && f(s.x[j], s.y[j], s.x[l], s.y[l], s.x[i], s.y[i])
        * f(s.x[j], s.y[j], s.x[l], s.y[l], s.x[k], s.y[k]) < 0) hits.push([i, j]);
    }
  }
  return hits;
}

function trial(speed, angle, tier, reverse) {
  const w = new SB.World();
  w.setField(SB.LAYOUTS.mobile.field);
  const r = SB.TIERS[tier].outerR + 4, dx = Math.cos(angle), dy = Math.sin(angle);
  const a = new SB.Sobo(tier, -dx * r, -dy * r), b = new SB.Sobo(tier, dx * r, dy * r);
  if (reverse) { w.add(b); w.add(a); } else { w.add(a); w.add(b); }
  a.setVelocity(dx * speed, dy * speed);
  b.setVelocity(-dx * speed, -dy * speed);
  let merged = false, crossFrames = [];
  for (let f = 0; f < 90; f++) {
    w.step();
    if (!merged && w.pairs.length) {
      const p = w.pairs[0];
      if (w.merge(p.a, p.b, p.ia, p.ib)) merged = true;
    }
    for (const s of w.sobos) if (crossings(s).length) crossFrames.push(f);
  }
  return { merged, crossFrames };
}

// 报告点名场景：两个 tier2 球垂直相向、速度 ±400。
{
  const r = trial(400, Math.PI / 2, 2, false);
  check('报告场景：合并成功且无自交', r.merged && r.crossFrames.length === 0,
    `merged=${r.merged} cross=${JSON.stringify(r.crossFrames)}`);
}

// 完整矩阵：7 等级 × 5 速度 × 24 角度 × 2 种放置顺序（共 1680）。
let bad = [], count = 0;
for (const tier of [0, 1, 2, 3, 4, 5, 6]) {
  for (const speed of [100, 200, 400, 600, 850]) {
    for (let k = 0; k < 24; k++) {
      for (const reverse of [false, true]) {
        count++;
        const r = trial(speed, k * Math.PI / 12, tier, reverse);
        if (!r.merged || r.crossFrames.length) {
          bad.push(`tier${tier} v${speed} k${k} rev=${reverse} merged=${r.merged} cross=${r.crossFrames.join()}`);
        }
      }
    }
  }
}
check(`矩阵 ${count} 个场景全部无自交`, bad.length === 0, bad.slice(0, 6).join('  '));

// n-1→0 接缝：先临时关闭 _untangle，跑出“跨接缝翻转”的确定性形状（tier1/v600/π/4/先b后a）。
function captureSeamShape() {
  const realUntangle = SB.Sobo.prototype._untangle;
  SB.Sobo.prototype._untangle = function () { return false; };
  const w = new SB.World();
  w.setField(SB.LAYOUTS.mobile.field);
  const angle = Math.PI / 4, dx = Math.cos(angle), dy = Math.sin(angle), r = SB.TIERS[1].outerR + 4;
  const a = new SB.Sobo(1, -dx * r, -dy * r), b = new SB.Sobo(1, dx * r, dy * r);
  w.add(b); w.add(a);
  a.setVelocity(dx * 600, dy * 600); b.setVelocity(-dx * 600, -dy * 600);
  let captured = null;
  for (let f = 0; f < 90 && !captured; f++) {
    w.step();
    if (w.pairs.length) { const p = w.pairs[0]; w.merge(p.a, p.b, p.ia, p.ib); }
    for (const s of w.sobos) {
      const cr = crossings(s);
      // 跨接缝交叉：含边 (0,1) 或 (n-2,n-1) 之一。
      if (cr.some(([i, j]) => i === 0 || j === s.n - 2 || j === s.n - 1)) {
        captured = { n: s.n, tier: s.tier, x: Array.from(s.x), y: Array.from(s.y), cr };
      }
    }
  }
  SB.Sobo.prototype._untangle = realUntangle;
  return captured;
}
function cloneShapeInto(s, cap) {
  for (let i = 0; i < cap.n; i++) { s.x[i] = cap.x[i]; s.y[i] = cap.y[i]; }
  s.measure();
}
{
  const cap = captureSeamShape();
  check('接缝：能确定性抓到跨接缝翻转', !!cap && cap.cr.length > 0, cap ? JSON.stringify(cap.cr) : 'none');
  if (cap) {
    // 原始编号：_untangle 必须消除跨接缝交叉。
    const s1 = new SB.Sobo(cap.tier, 0, 0);
    cloneShapeInto(s1, cap);
    const changed1 = s1._untangle();
    const left1 = crossings(s1);
    check('接缝：原始编号下被理顺', changed1 && left1.length === 0, JSON.stringify(left1));

    // 循环重编号若干个起点：同一几何形状，换编号后也必须能理顺。
    const shifts = [1, 3, 5, 7, cap.n - 1];
    let relabelOk = true;
    for (const shift of shifts) {
      const s2 = new SB.Sobo(cap.tier, 0, 0);
      for (let i = 0; i < cap.n; i++) { s2.x[i] = cap.x[(i + shift) % cap.n]; s2.y[i] = cap.y[(i + shift) % cap.n]; }
      s2.measure();
      s2._untangle();
      if (crossings(s2).length) { relabelOk = false; break; }
    }
    check('接缝：所有循环重编号结果一致（都能理顺）', relabelOk);
  }
}

// 真实凹陷（凹但不交叉）不是自交，_untangle 不得改变它。
{
  const s = new SB.Sobo(2, 0, 100);
  const before = Array.from(s.x).join(',') + Array.from(s.y).join(',');
  // 把一个点沿径向往内压，形成凹陷但不产生非相邻边交叉。
  const i = 3; s.x[i] = s.cx + (s.x[i] - s.cx) * 0.45; s.y[i] = s.cy + (s.y[i] - s.cy) * 0.45;
  s.measure();
  const hasCross = crossings(s).length > 0;
  const changed = s._untangle();
  const after = Array.from(s.x).join(',') + Array.from(s.y).join(',');
  check('凹陷：构造本身无自交', !hasCross);
  check('凹陷：不被 _untangle 抹掉（无改动）', changed === false && before !== after && crossings(s).length === 0);
}
process.exit(fails ? 1 : 0);
