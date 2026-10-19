// 形状灾难兜底（fixShape/_rescue）的隔离回归。
//  1) 多档位（1/16/256/1024/2048/4096/8192）空场单次应急恢复后，不再持续/周期重建，
//     恢复健康面积，有限性与同球非相邻膜点不穿透约束成立。
//  2) 贴墙/角落：球心被回拉、规则圆不穿墙、不持续重建。
//  3) 恢复后的球对重力、平移与碰撞有运动/软体响应（不是永久冻结的硬糖球，不靠再合并）。
//  4) 深穿透在 _collide 内即时转 ghost，多配对各自缓出并最终分离，不留挂起恢复。
//  5) 穿透超时（overlapTimeout）路径也走几何可行的 _rescue，不缩成自穿透小圆。
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }
const CONTACT = SB.SUBA_R * 2;
const L = SB.LAYOUTS.mobile;
const G = SB.PHYS.gravity;

// 统计在指定区间内对每个球的 fixShape 调用次数。
function countResets() {
  const orig = SB.Sobo.prototype.fixShape;
  let n = 0;
  SB.Sobo.prototype.fixShape = function () { n++; return orig.apply(this, arguments); };
  return { stop() { SB.Sobo.prototype.fixShape = orig; return n; } };
}
function finiteAndSlow(s) {
  for (let i = 0; i < s.n; i++) {
    if (!isFinite(s.x[i] + s.y[i] + s.vx[i] + s.vy[i])) return false;
    if (Math.hypot(s.vx[i], s.vy[i]) > 2000) return false;
  }
  return isFinite(s.cx + s.cy + s.bvx + s.bvy);
}
// 同球非相邻膜点的最近距离（几何可行性）。
function minNonAdjacent(s) {
  let m = 1e9;
  for (let i = 0; i < s.n; i++) {
    for (let j = i + 2; j < s.n; j++) {
      if (i === 0 && j === s.n - 1) continue; // 环首尾相邻
      m = Math.min(m, Math.hypot(s.x[i] - s.x[j], s.y[i] - s.y[j]));
    }
  }
  return m;
}
function emptyWorld() {
  SB.PHYS.gravity = 0;
  const w = new SB.World();
  return w;
}
function singleSobo(w, tier, x, y) {
  const s = new SB.Sobo(tier, x || 0, y || 0);
  for (let i = 0; i < s.n; i++) s.wall[i] = 0;
  w.add(s);
  return s;
}

// 1) 多档位空场单次恢复。
for (const [tier, val] of [[0, 1], [4, 16], [8, 256], [10, 1024], [11, 2048], [12, 4096], [13, 8192]]) {
  const w = emptyWorld();
  const s = singleSobo(w, tier);
  for (let k = 0; k < 30; k++) w.step();
  s.fixShape(); // 模拟一次灾难兜底（几何可行半径，默认恢复健康尺寸）
  const c = countResets();
  for (let f = 0; f < 300; f++) w.step();
  const extra = c.stop();
  const polyA = (s.n / 2) * s.data.innerR * s.data.innerR * Math.sin(2 * Math.PI / s.n);
  check(`tier${tier}(${val})：恢复后不再重建`, extra === 0, `extra=${extra}`);
  check(`tier${tier}：有限且无超速`, finiteAndSlow(s), `maxV=${Math.max(...s.vx.map((vx, i) => Math.hypot(vx, s.vy[i]))).toFixed(0)}`);
  check(`tier${tier}：恢复健康面积`, s.area > 0.9 * polyA && s.area < 1.4 * s.data.innerArea,
    `area=${s.area.toFixed(1)} 多边形基准=${polyA.toFixed(1)}`);
  check(`tier${tier}：非相邻膜点不穿透`, minNonAdjacent(s) >= CONTACT - 1, `min=${minNonAdjacent(s).toFixed(2)}`);
}

// 2) 贴墙：球心被推到左墙内侧极近，_rescue 应回拉球心，规则圆不穿墙。
{
  const w = new SB.World(); SB.PHYS.gravity = 0;
  w.setField(L.field);
  const s = new SB.Sobo(8, 0, 0); w.add(s);
  const left = w.edges.find(e => e.nx > 0.9 && Math.abs(e.ny) < 0.1);
  s.cx = left.px + 1; s.cy = 0;
  w._rescue(s); // 自身的一次合法 fixShape 不计入“后续重建”
  const c = countResets();
  for (let steps = 0; steps < 150; steps++) w.step();
  const extra = c.stop();
  let breach = 0;
  for (const E of w.edges) for (let i = 0; i < s.n; i++) {
    const d = (s.x[i] - E.px) * E.nx + (s.y[i] - E.py) * E.ny;
    if (d < SB.SUBA_R - 1.5) breach++;
  }
  check('贴墙：球心被回拉到安全距离', (s.cx - left.px) >= s.safeRadius() + SB.SUBA_R - 1,
    `dist=${(s.cx - left.px).toFixed(1)} need=${(s.safeRadius() + SB.SUBA_R).toFixed(1)}`);
  check('贴墙：规则圆不穿墙', breach === 0, `breach=${breach}`);
  check('贴墙：恢复后不持续重建', extra === 0, `extra=${extra}`);
  check('贴墙：有限', finiteAndSlow(s));
}

// 3a) 恢复后响应重力：球会下落（质心移动），不是冻结。
{
  const w = new SB.World(); SB.PHYS.gravity = 150;
  const s = singleSobo(w, 6, 0, -200);
  s.fixShape();
  const y0 = s.cy;
  for (let f = 0; f < 60; f++) w.step();
  // gravity=150 时自由落体 1 秒位移约 ½gt²=75px，软体阻尼下略小，>60 即显著下落。
  check('恢复后受重力下落', s.cy - y0 > 60, `dy=${(s.cy - y0).toFixed(1)}`);
  check('下落中仍有限', finiteAndSlow(s));
  SB.PHYS.gravity = 0;
}

// 3b) 恢复后被另一球撞击会运动（证明不是死硬球，不依赖再合并）。
{
  const w = emptyWorld();
  const A = singleSobo(w, 6, 0, 0);
  for (let k = 0; k < 20; k++) w.step();
  A.fixShape();
  const B = singleSobo(w, 6, 0, -180);
  for (let i = 0; i < B.n; i++) B.vy[i] = 320; // 从上方高速撞向 A
  B.bvy = 320;
  const ay0 = A.cy;
  let deforming = false;
  for (let f = 0; f < 45; f++) {
    w.step();
    // 软体变形：膜点到质心距离的极差随碰撞变化
    const radii = [];
    for (let i = 0; i < A.n; i++) radii.push(Math.hypot(A.x[i] - A.cx, A.y[i] - A.cy));
    if (Math.max(...radii) - Math.min(...radii) > 3) deforming = true;
  }
  check('恢复后被撞会运动', A.cy - ay0 > 8, `dy=${(A.cy - ay0).toFixed(1)}`);
  check('恢复后被撞有软体变形', deforming);
  check('撞击后仍有限', finiteAndSlow(A) && finiteAndSlow(B));
}

// 4) 深穿透即时转 ghost，多配对缓出后分离，无残留恢复。
{
  const w = emptyWorld();
  const A = singleSobo(w, 4, 0, 0);
  const B = singleSobo(w, 4, 0, 26);   // 深穿透 A
  const C = singleSobo(w, 4, 0, -26);  // 深穿透 A（另一侧）
  let maxPair = 0;
  for (let f = 0; f < 240; f++) { w.step(); maxPair = Math.max(maxPair, w.recoveries.length); }
  // 两球最近膜点距离。
  const closest = (X, Y) => { let m = 1e9; for (let i = 0; i < X.n; i++) for (let j = 0; j < Y.n; j++) m = Math.min(m, Math.hypot(X.x[i] - Y.x[j], X.y[i] - Y.y[j])); return m; };
  check('深穿透期间建立过多个恢复配对', maxPair >= 2, `maxPair=${maxPair}`);
  check('缓出后恢复配对全部结束', w.recoveries.length === 0, `left=${w.recoveries.length}`);
  check('缓出后 A/B 分离', closest(A, B) >= CONTACT - 2, `d=${closest(A, B).toFixed(1)}`);
  check('缓出后 A/C 分离', closest(A, C) >= CONTACT - 2, `d=${closest(A, C).toFixed(1)}`);
  check('深穿透场景有限', finiteAndSlow(A) && finiteAndSlow(B) && finiteAndSlow(C));
}

// 5) 穿透超时路径走几何可行 _rescue（临时把超时压到 0）。
{
  const w = emptyWorld();
  const A = singleSobo(w, 8, 0, 0);
  const B = singleSobo(w, 8, 0, 30);
  const oldTimeout = SB.PHYS.overlapTimeout;
  SB.PHYS.overlapTimeout = 0;
  let called = 0;
  const origF = SB.Sobo.prototype.fixShape;
  SB.Sobo.prototype.fixShape = function () { called++; return origF.apply(this, arguments); };
  for (let f = 0; f < 60; f++) w.step();
  SB.Sobo.prototype.fixShape = origF;
  SB.PHYS.overlapTimeout = oldTimeout;
  // overlapTimeout=0 时超时路径立即走 _rescue；关键是每次兜底几何可行，不缩小成自穿透小圆。
  check('超时路径触发过 _rescue', called > 0, `called=${called}`);
  check('超时兜底后几何可行（非相邻不穿透）', minNonAdjacent(A) >= CONTACT - 1 && minNonAdjacent(B) >= CONTACT - 1,
    `minA=${minNonAdjacent(A).toFixed(1)} minB=${minNonAdjacent(B).toFixed(1)}`);
  check('超时场景有限', finiteAndSlow(A) && finiteAndSlow(B));
}

// 6) 同数字球深穿透缓出结束后，重新浅接触能正常登记合并（recovery 不永久封禁合并）。
{
  const w = emptyWorld();
  const A = singleSobo(w, 4, 0, 0);
  const B = singleSobo(w, 4, 0, 26); // 深穿透
  for (let f = 0; f < 240; f++) w.step();
  check('再合并：深穿透已缓出', w.recoveries.length === 0, `left=${w.recoveries.length}`);
  check('再合并：allowMerges 保持开启', A.allowMerges && B.allowMerges);
  check('再合并：ghost 标记已清干净', A.ghost === null && B.ghost === null && A.ghostSubas === null && B.ghostSubas === null);
  const place = (s, cx, cy) => {
    s.cx = cx; s.cy = cy; s.bx = cx; s.by = cy; s.bvx = s.bvy = 0; s.avx = s.avy = 0;
    for (let i = 0; i < s.n; i++) {
      const a = (i / s.n) * Math.PI * 2;
      s.px[i] = s.x[i] = cx + Math.cos(a) * s.data.innerR;
      s.py[i] = s.y[i] = cy + Math.sin(a) * s.data.innerR;
      s.vx[i] = s.vy[i] = 0;
    }
    s.area = s.data.innerArea;
  };
  place(A, 0, 0); place(B, 0, 100); // tier4 innerR≈43，最近膜点≈13（浅接触 12<d<24）
  w.pairs.length = 0; w._pairKeys = {};
  w.step();
  const pair = w.pairs.find(p => (p.a === A && p.b === B) || (p.a === B && p.b === A));
  check('再合并：浅接触登记同数字配对', !!pair, `pairs=${w.pairs.length}`);
}

// 7) 角落：球心被推到左墙与左下斜边的交点，_rescue 对所有墙回拉后规则圆不穿任何墙。
{
  const w = new SB.World(); SB.PHYS.gravity = 0; w.setField(L.field);
  const s = new SB.Sobo(8, 0, 0); w.add(s);
  s.cx = -196; s.cy = 240; // 左墙 x=-196 与左下斜边 [(-148,288),(-196,240)] 交点
  w._rescue(s);
  const c = countResets();
  for (let f = 0; f < 150; f++) w.step();
  const extra = c.stop();
  let breach = 0;
  for (const E of w.edges) for (let i = 0; i < s.n; i++) {
    const d = (s.x[i] - E.px) * E.nx + (s.y[i] - E.py) * E.ny;
    if (d < SB.SUBA_R - 1.5) breach++;
  }
  check('角落：规则圆不穿任何墙', breach === 0, `breach=${breach}`);
  check('角落：不持续重建', extra === 0, `extra=${extra}`);
  check('角落：有限', finiteAndSlow(s));
}

// 8) 密集异数挤压：不同数字球在重力下挤成堆，向其中一个大球注入超速灾难，
//    环境感知 _rescue 必须在拥挤环境中安全兜底，不卡死、不 NaN、不残留恢复。
{
  const w = new SB.World(); w.setField(L.field); SB.PHYS.gravity = 150;
  const specs = [[0, -60, -240], [1, -20, -240], [2, 20, -240], [3, 60, -240],
    [4, -40, -190], [5, 0, -190], [6, 40, -190], [2, -60, -150], [3, -20, -150], [4, 20, -150], [5, 60, -150]];
  for (const [t, x, y] of specs) w.add(new SB.Sobo(t, x, y));
  for (let f = 0; f < 120; f++) w.step(); // 先让它们下落、挤压、合并
  let rescued = 0;
  const orig = SB.Sobo.prototype.fixShape;
  SB.Sobo.prototype.fixShape = function () { rescued++; return orig.apply(this, arguments); };
  const big = w.sobos.filter(s => !s.dead).sort((a, b) => b.n - a.n)[0];
  for (let i = 0; i < big.n; i++) { big.vx[i] = 2600 * Math.cos(i); big.vy[i] = 2600 * Math.sin(i); }
  for (let f = 0; f < 400; f++) w.step();
  SB.Sobo.prototype.fixShape = orig;
  let bad = false;
  for (const s of w.sobos) if (!finiteAndSlow(s)) bad = true;
  check('密集挤压：拥挤环境中触发过环境恢复', rescued > 0, `rescued=${rescued}`);
  check('密集挤压：现存球全部有限无超速', !bad);
  check('密集挤压：无残留/挂起恢复', w.recoveries.length === 0, `left=${w.recoveries.length}`);
}

SB.PHYS.gravity = G;
process.exit(fails ? 1 : 0);
