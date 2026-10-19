// 形状恢复回归：
//  1) 整体健康但单条膜边被极端拉长（>4.5*SPACING）时，只做温和的局部缝合，
//     不把整个球缩成半径减半的小圆（那会让非相邻膜点自穿透、反推超速、逐帧重建）。
//  2) 真正灾难（面积崩/膜点飞散/速度爆/非有限）仍必须兜底，但兜底形状必须几何可行，
//     单次恢复后在空场不再持续/周期重建，并恢复健康面积。
//  3) 重建统计必须按“球 id 的帧集合”进行，不能用相邻日志条目，否则 A/B 交替重建漏报。
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }
const R = SB.SUBA_R;
const P = SB.LAYOUTS.mobile.play;

/* ------------------------------------------------------------------
 * 按球 id 统计 fixShape（形状兜底）重建：
 *  - 旧实现用“相邻两条日志 id 相同且帧号 +1”，当 A/B 两球交替重建
 *    （日志 …A,B,A,B…）时相邻 id 总是不同，会把各自连续上百帧误报成 1。
 *  - 改为按 id 收集“出现过的帧集合”（同帧重复只计一帧，单独统计），
 *    在每个 id 自己的帧序列上找最长连续帧；再用滑动窗口重建率
 *    捕捉隔帧/周期重建（连续帧检测抓不到的情形）。
 * ------------------------------------------------------------------ */
const STREAK_WIN = 60;
function summarizeResetStreaks(resets, winW) {
  winW = winW || STREAK_WIN;
  const framesById = new Map();
  const dupKeys = new Map();
  for (const r of resets) {
    let set = framesById.get(r.id);
    if (!set) { set = new Set(); framesById.set(r.id, set); }
    const key = r.frame + ':' + r.id;
    if (set.has(r.frame)) dupKeys.set(key, (dupKeys.get(key) || 1) + 1);
    else set.add(r.frame);
  }
  let dupSameFrame = 0;
  dupKeys.forEach(c => { if (c > 1) dupSameFrame++; });
  let total = 0, maxStreak = 0, worstId = -1, maxWinRate = 0, worstWinId = -1;
  for (const [id, set] of framesById) {
    const F = [...set].sort((a, b) => a - b);
    let streak = 1, ms = 1;
    for (let i = 1; i < F.length; i++) {
      if (F[i] === F[i - 1] + 1) streak++; else streak = 1;
      if (streak > ms) ms = streak;
    }
    let mRate = 0;
    for (let i = 0; i < F.length; i++) {
      let j = i;
      while (j < F.length && F[j] < F[i] + winW) j++;
      const rate = (j - i) / winW;
      if (rate > mRate) mRate = rate;
    }
    total += F.length;
    if (ms > maxStreak) { maxStreak = ms; worstId = id; }
    if (mRate > maxWinRate) { maxWinRate = mRate; worstWinId = id; }
  }
  return { total, maxStreak, worstId, maxWinRate: +maxWinRate.toFixed(3), worstWinId, dupSameFrame };
}

/* 合成日志：直接验证统计器，不跑物理。 */
function synth(label, resets, expect) {
  const s = summarizeResetStreaks(resets, 60);
  check(label + '·最长连续', s.maxStreak === expect.maxStreak, `got=${s.maxStreak} want=${expect.maxStreak}`);
  check(label + '·去重总帧', s.total === expect.total, `got=${s.total} want=${expect.total}`);
  if (expect.maxWinRate !== undefined)
    check(label + '·窗口重建率', Math.abs(s.maxWinRate - expect.maxWinRate) < 1e-9, `got=${s.maxWinRate} want=${expect.maxWinRate}`);
  if (expect.dup !== undefined)
    check(label + '·同帧重复', s.dupSameFrame === expect.dup, `got=${s.dupSameFrame} want=${expect.dup}`);
}
{
  // A/B 交替：每帧 A、B 都重建，旧相邻日志算法误报为 1，正确应各连续 3。
  const r = [];
  for (let f = 100; f < 103; f++) r.push({ frame: f, id: 'A' }, { frame: f, id: 'B' });
  synth('A/B交替', r, { maxStreak: 3, total: 6 });
  // 中断帧：100,101 与 103,104 两段，最长 2。
  synth('中断帧', [100, 101, 103, 104].map(f => ({ frame: f, id: 'A' })), { maxStreak: 2, total: 4 });
  // 同一帧对同一球重复记录：只计一帧，不计额外连续。
  synth('同帧重复', [{ frame: 100, id: 'A' }, { frame: 100, id: 'A' }, { frame: 101, id: 'A' }], { maxStreak: 2, total: 2, dup: 1 });
  // 单球连续 6 帧。
  synth('单球连续', Array.from({ length: 6 }, (_, i) => ({ frame: 100 + i, id: 'A' })), { maxStreak: 6, total: 6 });
  // 隔帧周期（偶数帧重建）：最长连续只有 1，但 60 帧窗率 0.5，必须被窗率抓住。
  synth('隔帧周期', Array.from({ length: 30 }, (_, i) => ({ frame: i * 2, id: 'A' })), { maxStreak: 1, total: 30, maxWinRate: 0.5 });
}

// 用合法的指针输入连续发射（含斜向瞄准），制造密集堆叠与斜碰。
function play(seed, frames) {
  let rnd = seed; Math.random = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const orig = SB.Sobo.prototype.fixShape;
  const resets = [];
  let frame = 0;
  // 必须原样透传 _rescue 给出的环境半径参数，否则测试会把每次恢复强制成完整圆，
  // 与真实运行路径不一致（用 apply 透传所有参数）。
  SB.Sobo.prototype.fixShape = function () { resets.push({ frame, id: this.id }); return orig.apply(this, arguments); };
  const m = new SB.Classic('mobile');
  let maxEdge = 0, maxV = 0, nan = false, escape = false;
  for (frame = 0; frame < frames && m.state === 'playing'; frame++) {
    m.tick();
    if (frame % 16 === 0 && m.selectable.length) {
      const s = m.selectable[Math.floor(Math.random() * m.selectable.length)];
      if (m.pointerDown(s.cx, s.cy, 'touch')) {
        // 斜向 + 正上方混合，制造斜碰与正落。
        const ang = (Math.random() - 0.5) * 1.2;
        m.pointerMove(s.cx + Math.sin(ang) * 260, s.cy + Math.cos(ang) * 260 + 120, 'touch');
        m.pointerUp();
      }
    }
    for (const s of m.world.sobos) {
      for (let i = 0; i < s.n; i++) {
        const j = (i + 1) % s.n;
        maxEdge = Math.max(maxEdge, Math.hypot(s.x[i] - s.x[j], s.y[i] - s.y[j]));
        const v = Math.hypot(s.vx[i], s.vy[i]);
        maxV = Math.max(maxV, v);
        if (!isFinite(s.x[i] + s.y[i] + s.vx[i] + s.vy[i])) nan = true;
        if (v > 2000) nan = true; // 步后仍超速说明保护失效
        if (!s.entering[i]) {
          if (s.x[i] < P.x0 - R || s.x[i] > P.x1 + R || s.y[i] > P.y1 + R || s.y[i] < P.y0 - R) escape = true;
        }
      }
    }
  }
  SB.Sobo.prototype.fixShape = orig;
  return Object.assign({ frames: frame, resets: resets.length, maxEdge, maxV, nan, escape },
    summarizeResetStreaks(resets));
}

for (const seed of [1, 2, 3, 4, 5]) {
  const r = play(seed, 2500);
  console.log(`seed${seed} 帧=${r.frames} 重建帧=${r.total} 最长连续=${r.maxStreak}(球${r.worstId}) 60窗率=${r.maxWinRate}(球${r.worstWinId}) 最长边=${r.maxEdge.toFixed(1)} 最大速度=${r.maxV.toFixed(0)}`);
  check(`seed${seed}：无连续重建（同球连续≥3帧）`, r.maxStreak < 3, `streak=${r.maxStreak}`);
  // 周期/隔帧自维持会使窗率接近 0.5（隔帧）~1.0（逐帧）；偶发独立碰撞只有 0.017~0.05。
  // 红线取 0.1：同一球在任意 60 帧窗内重建不得超过 5 帧，既抓住自维持又不误伤偶发。
  check(`seed${seed}：无周期/持续重建（60帧窗率≥0.1）`, r.maxWinRate < 0.1, `winRate=${r.maxWinRate}`);
  check(`seed${seed}：无 NaN/步后超速`, !r.nan, `maxV=${r.maxV.toFixed(0)}`);
  check(`seed${seed}：无穿墙`, !r.escape);
  check(`seed${seed}：膜边被缝合在硬阈值内`, r.maxEdge <= 4.5 * (R * 2 * (1 - 0.333333)) + 1, `maxEdge=${r.maxEdge.toFixed(1)}`);
}

// 整体健康但单条膜边极端拉长：只缝合，不整体重置。
{
  const s = new SB.Sobo(4, 0, 100);
  const i = 0, k = 1;
  const mx = (s.x[i] + s.x[k]) / 2, my = (s.y[i] + s.y[k]) / 2;
  let dx = s.x[k] - s.x[i], dy = s.y[k] - s.y[i], dl = Math.hypot(dx, dy);
  dx /= dl; dy /= dl;
  s.x[i] = mx - dx * 36; s.y[i] = my - dy * 36;
  s.x[k] = mx + dx * 36; s.y[k] = my + dy * 36;
  s.measure();
  const m = new SB.Classic('mobile'); m.world.add(s);
  let reset = false; const orig = SB.Sobo.prototype.fixShape;
  SB.Sobo.prototype.fixShape = function () { reset = true; return orig.call(this); };
  m.world.step();
  SB.Sobo.prototype.fixShape = orig;
  let edge = 0; for (let p = 0; p < s.n; p++) { const j = (p + 1) % s.n; edge = Math.max(edge, Math.hypot(s.x[p] - s.x[j])); }
  check('局部长边：不整体重置', reset === false);
  check('局部长边：被温和缝合（72 → 明显收回）', edge < 72 && edge > 16, `edge=${edge.toFixed(1)}`);
  check('局部长边：面积保持健康', s.area > 0.7 * s.data.innerArea && s.area < 1.3 * s.data.innerArea, `ratio=${(s.area / s.data.innerArea).toFixed(2)}`);
}

// 真正灾难仍必须被兜底重置。
function disaster(setup) {
  const m = new SB.Classic('mobile');
  const s = new SB.Sobo(0, 0, 100); m.world.add(s);
  setup(s);
  let reset = false; const orig = SB.Sobo.prototype.fixShape;
  SB.Sobo.prototype.fixShape = function () { reset = true; return orig.call(this); };
  m.world.step();
  SB.Sobo.prototype.fixShape = orig;
  return reset;
}
check('灾难：膜点速度爆炸仍重置', disaster(s => { s.vx[0] = 5000; }));
check('灾难：膜点飞散仍重置', disaster(s => { s.x[0] = s.cx + s.data.innerR * 5; }));
check('灾难：NaN 仍重置', disaster(s => { s.x[0] = NaN; }));
process.exit(fails ? 1 : 0);
