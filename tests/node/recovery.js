// 恢复标记配对隔离：一个球同时与两个球形成穿透恢复时，结束其中一个配对
// 只清除该配对的标记，另一个配对的 ghostSubas / ghost 必须完整保留。
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

const inside = (A, B) => Array.from(A.x).map((x, i) => (B.contains(x, A.y[i]) ? i : -1)).filter(i => i >= 0);
const count = a => (a ? Array.from(a).filter(Boolean).length : 0);

// 三个 tier0 球：x 居中 (0,0)，y/v 分别在 (-12,0)/(12,0)，x 同时与两侧穿透。
const w = new SB.World();
const x = w.add(new SB.Sobo(0, 0, 0));
const y = w.add(new SB.Sobo(0, -12, 0));
const v = w.add(new SB.Sobo(0, 12, 0));
w._startRecovery(x, y, inside(x, y), inside(y, x));
w._startRecovery(x, v, inside(x, v), inside(v, x));

check('两个配对都激活', w.recoveries.length === 2, `n=${w.recoveries.length}`);
const insideXV = inside(x, v);
check('聚合 mask 是两对并集（7 节点）', count(x.ghostSubas) === 7, `mask=${count(x.ghostSubas)}`);

// 按引用找到并结束 xy 配对（不依赖数组顺序）。
const idx = w.recoveries.findIndex(R => (R.a === x && R.b === y) || (R.a === y && R.b === x));
w._endRecovery(idx);

check('结束 xy 后只剩 xv 配对', w.recoveries.length === 1, `n=${w.recoveries.length}`);
check('xv 配对的 mask 完整保留', count(x.ghostSubas) === insideXV.length && insideXV.every(i => x.ghostSubas[i] === 1),
  `mask=${count(x.ghostSubas)} want=${insideXV.length}`);
check('x 仍记录与 v 的 ghost', !!x.ghost && x.ghost[v.id] === true, JSON.stringify(x.ghost));
check('x 已移除与 y 的 ghost', !x.ghost || x.ghost[y.id] === undefined);
check('结束的配对 y 标记已清', y.ghost === null && y.ghostSubas === null);

// 碰撞解碰过滤必须只看“当前 A/B 配对”的 mask，不能用球级聚合的 ghostSubas：
// A 同时与 B、C 处于恢复中，A3 被 A-C 配对标记（但在 A-B 配对未标记），
// 它与 B2 是真实表面接触（距离<24），_collide 必须照常解碰，不得被 A-C 标记串用跳过。
{
  const angle = 7 * Math.PI / 12;
  const z = new SB.World();
  const A = z.add(new SB.Sobo(0, 0, 0));
  const B = z.add(new SB.Sobo(0, -30, 0));
  const C = z.add(new SB.Sobo(0, 40 * Math.cos(angle), 40 * Math.sin(angle)));
  z._startRecovery(A, B, inside(A, B), inside(B, A));
  z._startRecovery(A, C, inside(A, C), inside(C, A));
  const AB = z.recoveries.find(R => (R.a === A && R.b === B) || (R.a === B && R.b === A));
  const AC = z.recoveries.find(R => (R.a === A && R.b === C) || (R.a === C && R.b === A));
  const i = 3, j = 2;
  const distBefore = Math.hypot(A.x[i] - B.x[j], A.y[i] - B.y[j]);
  check('前置：A3 在 A-B 未标记、在 A-C 被标记',
    AB.aMask[i] === 0 && AB.bMask[j] === 0 && AC.aMask[i] === 1 && A.ghostSubas[i] === 1,
    `ab=${AB.aMask[i]}/${AB.bMask[j]} ac=${AC.aMask[i]} agg=${A.ghostSubas[i]}`);
  check('前置：A3/B2 是真实接触（穿透中）', distBefore < 24, `d=${distBefore.toFixed(2)}`);
  // 隔离 A/B 在 broadphase 中，仅运行生产 _collide。
  z.sobos = [A, B];
  z._collide(false);
  const distAfter = Math.hypot(A.x[i] - B.x[j], A.y[i] - B.y[j]);
  check('真实接触被解碰（不被 A-C 标记串用跳过）', Math.abs(distAfter - 24) < 1e-6, `d=${distAfter.toFixed(3)}`);

  // 反向：真正处于 A-B 配对穿透中的节点仍应被跳过（交给恢复力，不硬解碰）。
  const z2 = new SB.World();
  const X = z2.add(new SB.Sobo(0, 0, 0));
  const Y = z2.add(new SB.Sobo(0, -30, 0));
  z2._startRecovery(X, Y, inside(X, Y), inside(Y, X));
  const XY = z2.recoveries[0];
  // 找一对都在本配对 mask 内、且距离<24 的节点。
  let pair = null;
  for (let p = 0; p < X.n && !pair; p++) {
    if (!XY.aMask[p]) continue;
    for (let q = 0; q < Y.n; q++) {
      if (!XY.bMask[q]) continue;
      if (Math.hypot(X.x[p] - Y.x[q], X.y[p] - Y.y[q]) < 24) { pair = [p, q]; break; }
    }
  }
  check('能找到本配对内的穿透节点对', !!pair, pair ? `(${pair[0]},${pair[1]})` : 'none');
  if (pair) {
    const [p, q] = pair;
    const bx = X.x[p], by = X.y[p];
    z2.sobos = [X, Y];
    z2._collide(false);
    const untouched = X.x[p] === bx && X.y[p] === by;
    check('本配对穿透节点仍被跳过（不硬解碰）', untouched);
  }
}
process.exit(fails ? 1 : 0);
