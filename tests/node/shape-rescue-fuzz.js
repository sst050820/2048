// 形状恢复的多种子随机压测（R3 回归）：
//  合法连射 + 真实重力推进，任意球不得出现逐帧/隔帧自维持重建、NaN/超速、穿墙；
//  同时确认游戏玩法仍在正常推进（有合并发生，得分增长），深穿透 ghost 没有吞掉合并或把球“卡死”。
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

function summarize(resets, winW) {
  const by = new Map();
  for (const r of resets) { if (!by.has(r.id)) by.set(r.id, new Set()); by.get(r.id).add(r.frame); }
  let maxStreak = 0, maxRate = 0;
  for (const set of by.values()) {
    const F = [...set].sort((a, b) => a - b);
    let st = 1, ms = 1;
    for (let i = 1; i < F.length; i++) { if (F[i] === F[i - 1] + 1) st++; else st = 1; if (st > ms) ms = st; }
    let mr = 0;
    for (let i = 0; i < F.length; i++) { let j = i; while (j < F.length && F[j] < F[i] + winW) j++; mr = Math.max(mr, (j - i) / winW); }
    maxStreak = Math.max(maxStreak, ms); maxRate = Math.max(maxRate, mr);
  }
  return { total: resets.length, maxStreak, maxRate: +maxRate.toFixed(3) };
}

function play(seed, frames) {
  let rnd = seed; Math.random = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const orig = SB.Sobo.prototype.fixShape;
  const resets = [];
  let frame = 0;
  SB.Sobo.prototype.fixShape = function () { resets.push({ frame, id: this.id }); return orig.apply(this, arguments); };
  const m = new SB.Classic('mobile');
  const P = SB.LAYOUTS.mobile.play, R = SB.SUBA_R;
  let maxV = 0, bad = false, escape = false, maxEdge = 0, merges = 0;
  const hook = m.hooks;
  const oldMerge = hook.merge;
  hook.merge = function (A, B, N, cx, cy) { merges++; if (oldMerge) return oldMerge.apply(this, arguments); };
  for (frame = 0; frame < frames && m.state === 'playing'; frame++) {
    m.tick();
    if (frame % 16 === 0 && m.selectable.length) {
      const s = m.selectable[Math.floor(Math.random() * m.selectable.length)];
      if (m.pointerDown(s.cx, s.cy, 'touch')) {
        const ang = (Math.random() - 0.5) * 1.2;
        m.pointerMove(s.cx + Math.sin(ang) * 260, s.cy + Math.cos(ang) * 260 + 120, 'touch');
        m.pointerUp();
      }
    }
    for (const s of m.world.sobos) for (let i = 0; i < s.n; i++) {
      const v = Math.hypot(s.vx[i], s.vy[i]); maxV = Math.max(maxV, v);
      if (!isFinite(s.x[i] + s.y[i] + s.vx[i] + s.vy[i]) || v > 2000) bad = true;
      if (!s.entering[i] && (s.x[i] < P.x0 - R || s.x[i] > P.x1 + R || s.y[i] > P.y1 + R || s.y[i] < P.y0 - R)) escape = true;
      const j = (i + 1) % s.n; maxEdge = Math.max(maxEdge, Math.hypot(s.x[i] - s.x[j], s.y[i] - s.y[j]));
    }
  }
  SB.Sobo.prototype.fixShape = orig;
  return Object.assign({ frames: frame, maxV, bad, escape, maxEdge, merges, score: m.score, deep: m.world._deepCount || 0, lingering: m.world.recoveries.length },
    summarize(resets, 60));
}

const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 25, 30, 42, 77];
let allMerged = 0;
for (const seed of seeds) {
  const r = play(seed, 2200);
  allMerged += r.merges;
  const ok = r.maxStreak < 3 && r.maxRate < 0.1 && !r.bad && !r.escape;
  check(`seed${seed}：无卡死/NaN/穿墙`, ok,
    `连续=${r.maxStreak} 窗率=${r.maxRate} 重建=${r.total} maxV=${r.maxV.toFixed(0)} 长边=${r.maxEdge.toFixed(0)} 残留恢复=${r.lingering}`);
  check(`seed${seed}：合并正常发生`, r.merges > 0, `merges=${r.merges} score=${r.score}`);
  check(`seed${seed}：深穿透缓出无永久挂起`, r.lingering === 0, `lingering=${r.lingering}`);
}
check('全部种子合计发生大量合并（玩法未被冻结）', allMerged > 200, `merges=${allMerged}`);
process.exit(fails ? 1 : 0);
