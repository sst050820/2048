// 成就追踪器存档恢复：损坏的 tracker 字段（air={}、chains={} 等）不得抛 TypeError、
// 不得半改当前追踪器；整体校验通过才一次性提交；旧存档无字段时保守兼容。
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

// 一个至少有一个球的局面，用于校验球序号引用。
const m = new SB.Classic('mobile');
m._spawn(m.sides[1], false);
for (let k = 0; !m.selectable.length && k < 100; k++) { m.world.step(); m._reenable(); }
const sobos = m.allSobos();
check('测试前置：恢复出至少一个球', sobos.length >= 1, `n=${sobos.length}`);

// 尝试恢复，返回是否抛异常/结果；调用前先在 tracker 里放入“旧状态”，验证失败时不被改动。
function tryRestore(data) {
  const t = new SB.Achievements.Tracker(function () {});
  t.bigMerge = false; t.holdT = { old: 5 }; t.air = ['OLD']; t.chains = ['OLD'];
  let result, threw = null;
  try { result = t.restore(data, sobos); } catch (e) { threw = e.message; }
  return { result, threw, t };
}
function rejected(name, data) {
  const r = tryRestore(data);
  const untouched = r.threw === null && r.result === false
    && r.t.air.length === 1 && r.t.air[0] === 'OLD'
    && r.t.chains.length === 1 && r.t.chains[0] === 'OLD'
    && r.t.bigMerge === false;
  check(name, untouched, r.threw ? `抛异常: ${r.threw}` : `result=${r.result}`);
}

// 损坏/非法字段：返回 false，不抛异常，保留原状态。
rejected('air 是对象（非数组）→ 拒绝', { bigMerge: true, air: {} });
rejected('chains 是对象（非数组）→ 拒绝', { bigMerge: true, chains: {} });
rejected('holdT 是数组 → 拒绝', { bigMerge: true, holdT: [] });
rejected('holdT 值非数字 → 拒绝', { bigMerge: true, holdT: { score_0: 'x' } });
rejected('air 引用越界球序号 → 拒绝', { bigMerge: true, air: [{ i: 9999, ticks: 3 }] });
rejected('air ticks 非整数 → 拒绝', { bigMerge: true, air: [{ i: 0, ticks: 2.5 }] });
rejected('chains 引用越界球序号 → 拒绝', { bigMerge: true, chains: [{ start: 1, head: 9999, value: 4 }] });
rejected('chains 缺 start → 拒绝', { bigMerge: true, chains: [{ head: 0, value: 4 }] });
rejected('bigMerge 是字符串 → 拒绝', { bigMerge: 'yes' });
rejected('data 本身是数组 → 拒绝', []);
rejected('data 是字符串 → 拒绝', 'junk');

// 旧存档/空字段：合法且保守 bigMerge=true（避免错误解锁“不合成”成就）。
for (const [name, data] of [['null', null], ['undefined', undefined], ['空对象 {}', {}]]) {
  const r = tryRestore(data);
  check(`${name}：成功且 bigMerge 保守为 true`, r.threw === null && r.result === true && r.t.bigMerge === true);
  check(`${name}：air/chains 清空`, r.t.air.length === 0 && r.t.chains.length === 0);
}

// 明确的布尔 bigMerge 被尊重。
{
  const r = tryRestore({ bigMerge: false });
  check('bigMerge 明确 false 被尊重', r.result === true && r.t.bigMerge === false);
}

// 合法字段恢复：air/chains 正确引用恢复后的球。
{
  const data = {
    bigMerge: true,
    air: [{ i: 0, ticks: 3 }],
    chains: [{ start: 1, head: 0, value: 4 }],
    holdT: { score_0: 7.5, unknown_id: 9 }
  };
  const r = tryRestore(data);
  check('合法数据：恢复成功', r.result === true && r.threw === null);
  check('air 引用到真实球', r.t.air.length === 1 && r.t.air[0].sobo === sobos[0] && r.t.air[0].ticks === 3);
  check('chains 引用到真实球', r.t.chains.length === 1 && r.t.chains[0].head === sobos[0] && r.t.chains[0].value === 4);
  check('holdT 保留已知 id、忽略未知 id', r.t.holdT.score_0 === 7.5 && r.t.holdT.unknown_id === undefined);
}

// 真实 capture → restore 往返：merge 产生进度后存档，恢复结果等价。
{
  const t = new SB.Achievements.Tracker(function () {});
  const A = new SB.Sobo(0, 0, 0), B = new SB.Sobo(0, 0, 0);
  // 直接构造一个 merge 产物记录（air 引用 N）。
  const N = new SB.Sobo(1, 10, 10);
  const world = m.world; world.add(N);
  t.air.push({ sobo: N, ticks: 4 });
  const list = [N];
  const cap = t.capture(list);
  const t2 = new SB.Achievements.Tracker(function () {});
  const ok = t2.restore(cap, list);
  check('capture→restore 往返成功', ok && t2.air.length === 1 && t2.air[0].sobo === N && t2.air[0].ticks === 4,
    JSON.stringify(cap));
}
process.exit(fails ? 1 : 0);
