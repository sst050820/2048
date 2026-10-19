// 形状恢复回归：正常合并球可能因颈部单条膜边略超 4.5*SPACING（面积、半径、速度都健康）
// 被旧逻辑整体 fixShape（缩到约四分之一、塞进外物），进而速度爆炸、连续数十帧重建。
// 新逻辑：整体健康的局部长边走温和缝合；只有真正灾难（面积崩/膜点飞散/速度爆/非有限）才重置。
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }
const R = SB.SUBA_R;
const P = SB.LAYOUTS.mobile.play;

// 用合法的指针输入连续发射（含斜向瞄准），制造密集堆叠与斜碰。
function play(seed, frames) {
  let rnd = seed; Math.random = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const orig = SB.Sobo.prototype.fixShape;
  const resets = [];
  let frame = 0;
  SB.Sobo.prototype.fixShape = function () { resets.push({ frame, id: this.id }); return orig.call(this); };
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
  // 同一球在连续帧（frame 递增 1）被 fixShape 的最长长度。
  let streak = 0, maxStreak = 0;
  for (let i = 0; i < resets.length; i++) {
    if (i > 0 && resets[i].id === resets[i - 1].id && resets[i].frame === resets[i - 1].frame + 1) streak++;
    else streak = 1;
    maxStreak = Math.max(maxStreak, streak);
  }
  return { frames: frame, resets: resets.length, maxStreak, maxEdge, maxV, nan, escape };
}

for (const seed of [1, 2, 3, 4, 5]) {
  const r = play(seed, 2500);
  console.log(`seed${seed} 帧=${r.frames} 重置=${r.resets} 最长连续=${r.maxStreak} 最长边=${r.maxEdge.toFixed(1)} 最大速度=${r.maxV.toFixed(0)}`);
  check(`seed${seed}：无连续重建（同球连续≥3帧）`, r.maxStreak < 3, `streak=${r.maxStreak}`);
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
  let edge = 0; for (let p = 0; p < s.n; p++) { const j = (p + 1) % s.n; edge = Math.max(edge, Math.hypot(s.x[p] - s.x[j], s.y[p] - s.y[j])); }
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
