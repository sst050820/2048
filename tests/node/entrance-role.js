// 入场合并后的“角色生命周期”回归：
// 球在从墙外飞入期间发生合并，产物可能首次更新时就有一半以上膜点在墙内，
// 旧逻辑的 off>n/2 早转条件永远不满足，导致永久卡在 emerging（不可选、不可合）；
// 若此时被瞄准发射，产物进 stack 后也永久 allowMerges=false。
// 本测试覆盖无输入合并与瞄准中合并两条路径、左右两个入口。
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }
const count = a => Array.from(a).filter(Boolean).length;
const BAR = SB.LAYOUTS.mobile.barY;

// 在指定入口（0=左，1=右）做“飞入球 + 浮条球”入场合并，返回合并产物。
function entranceMerge(side, bX) {
  const m = new SB.Classic('mobile');
  m._spawn(m.sides[side], false);
  for (let k = 0; !m.selectable.length && k < 100; k++) { m.world.step(); m._reenable(); }
  const b = m.world.add(new SB.Sobo(0, bX, BAR));
  m._selectable(b);
  let merged = false;
  for (let k = 0; k < 60 && !merged; k++) {
    m.world.step(); m._reenable(); m._merges();
    if (m.world.sobos.length === 1) merged = true;
  }
  return { m, n: m.world.sobos[0], merged };
}

// 角色列表互斥：同一球不能同时出现在多个列表，且每个列表内不重复。
function rolesAreDisjoint(m) {
  const all = [].concat(m.emerging, m.selectable, m.stack);
  const set = new Set(all);
  return set.size === all.length;
}

// 路径一：无输入合并，左右入口——最终必须转为可选、可合、可点选。
for (const [side, bX] of [[1, 150], [0, -150]]) {
  const { m, n, merged } = entranceMerge(side, bX);
  let resets = 0;
  const orig = n.fixShape; n.fixShape = function () { resets++; return orig.call(this); };
  for (let k = 0; k < 360; k++) m.world.step(), m._reenable();
  const label = side === 1 ? '右' : '左';
  check(`${label}入口：入场合并发生`, merged);
  check(`${label}入口：全部进场后转为 selectable`, m.selectable.includes(n) && !m.emerging.includes(n));
  check(`${label}入口：允许合并`, n.allowMerges === true);
  check(`${label}入口：可被点选 pointerDown`, m.pointerDown(n.cx, n.cy, 'touch') === true);
  check(`${label}入口：墙约束全部恢复`, Array.from(n.wall).every(Boolean) && count(n.entering) === 0);
  check(`${label}入口：角色列表互斥不重复`, rolesAreDisjoint(m));
  check(`${label}入口：无形状重置（无跳变）`, resets === 0, `resets=${resets}`);
}

// 路径二：飞入球在瞄准时发生合并，松手把产物发射进水缸——
// 产物最终在 stack、墙正常、allowMerges=true，且真实同级接触能再次合并。
{
  const m = new SB.Classic('mobile');
  m._spawn(m.sides[1], false);
  for (let k = 0; !m.selectable.length && k < 100; k++) { m.world.step(); m._reenable(); }
  const incoming = m.selectable[0];
  check('瞄准：飞入球可点选', m.pointerDown(incoming.cx, incoming.cy, 'touch') === true);
  const b = m.world.add(new SB.Sobo(0, 150, BAR)); m._selectable(b);
  m.world.step(); m._reenable(); m._merges();
  const n = m.world.sobos[0];
  check('瞄准：合并后瞄准焦点转移到产物', m.aim.sobo === n);
  // 松手发射（向下拖动）。
  m.pointerMove(n.cx, n.cy + 150, 'touch');
  m.pointerUp();
  for (let k = 0; k < 360; k++) { m.world.step(); m._reenable(); }
  check('瞄准：松手后产物进入 stack', m.stack.includes(n) && !m.emerging.includes(n) && !m.selectable.includes(n));
  check('瞄准：墙约束全部恢复', Array.from(n.wall).every(Boolean));
  check('瞄准：发射后恢复合并资格', n.allowMerges === true);
  // 真实同级接触应当能合并。
  const same = m.world.add(new SB.Sobo(n.tier, n.cx + 1, n.cy)); m._stack(same);
  let didMerge = false;
  for (let k = 0; k < 500 && !didMerge; k++) {
    m.world.step(); m._reenable(); m._merges();
    if (m.world.sobos.length === 1) didMerge = true;
  }
  check('瞄准：进 stack 后真实同级接触可合并', didMerge, `balls=${m.world.sobos.length}`);
}
process.exit(fails ? 1 : 0);
