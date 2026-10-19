/*
 * Soft-body physics for Soboscuba, ported from the original sobosuba's
 * model (docs/original-spec.md, sections 2, 5, 6, 10 and 17).
 *
 * A sobo is a closed ring of small circles (subas, radius 12, mass 1)
 * plus a heavy invisible "mass ball" tied to the ring's centre by a
 * spring. Three forces hold it together every substep:
 *   - skin: neighbouring subas pulled together when stretched past 16 px,
 *   - area: every suba pushed along its outward normal in proportion to
 *     the missing area (internal gas pressure),
 *   - ball spring: the ball chases the ring centre and the ring feels the
 *     reaction, which is what gives a big sobo its weight.
 * Contacts are frictionless and inelastic, as in the original (Godot
 * combines friction with min(), and every suba has friction 0).
 *
 * Forces are integrated with semi-implicit Euler; contacts are resolved by
 * position projection and velocities are taken from the corrected motion.
 * World units are the original's px, origin at the field centre, y down.
 */
(function (SB) {
  'use strict';

  var SUBA_R = 12;
  var SPACING = SUBA_R * 2 * (1 - 0.333333);  // rest distance between neighbours
  var CONTACT = SUBA_R * 2;
  var CELL = CONTACT;

  var CFG = SB.PHYS = {
    tick: 1 / 60,
    substeps: 4,
    iterations: 2,
    gravity: 150,
    linearDamp: 0.2,
    skinFreq: 2300, skinDamp: 9, skinMax: 50000,
    areaForce: 0.75, areaMax: 8000,
    ballFreq: 200, ballDamp: 15,
    bumperR: 64, bumperMass: 10, bumperTravel: 32, bumperFreq: 5, bumperDamp: 7,
    shockSpeed: 2000, shockImpulse: 100,
    overlapAccel: 200, overlapTimeout: 3
  };
  SB.SUBA_R = SUBA_R;

  /* ---------- tier table (spec 5.1) ---------- */
  var TIERS = [];
  (function () {
    for (var n = 0; n < 20; n++) {
      var outerArea = Math.pow(1.26, n) * 3700;
      var innerR0 = Math.sqrt(outerArea / Math.PI) - SUBA_R;
      var circ = Math.round(2 * Math.PI * innerR0 / SPACING) * SPACING;
      var innerR = circ / (2 * Math.PI);
      var outerR = innerR + SUBA_R;
      var count = Math.round(circ / SPACING);
      var oArea = Math.PI * outerR * outerR;
      var mass = oArea / 350;
      TIERS.push({
        tier: n, value: Math.pow(2, n), count: count,
        innerR: innerR, outerR: outerR, innerArea: Math.PI * innerR * innerR, outerArea: oArea,
        totalMass: mass, ballMass: mass - count,
        flash: Math.log(100) * oArea / 60000
      });
    }
  })();
  SB.TIERS = TIERS;

  /* ---------- sobo ---------- */
  var nextId = 1;

  function Sobo(tier, cx, cy) {
    var d = TIERS[tier];
    this.id = nextId++;
    this.tier = tier;
    this.value = d.value;
    this.data = d;
    var n = this.n = d.count;
    this.x = new Float64Array(n); this.y = new Float64Array(n);
    this.vx = new Float64Array(n); this.vy = new Float64Array(n);
    this.px = new Float64Array(n); this.py = new Float64Array(n);
    this.nx = new Float64Array(n); this.ny = new Float64Array(n);
    this.ax = new Float64Array(n); this.ay = new Float64Array(n);
    this.wall = new Uint8Array(n);      // collides with the field walls
    this.entering = new Uint8Array(n);  // still crossing in from outside a wall
    this.ghost = null;                  // overlap recovery: {soboId: true} this ring ignores
    this.ghostSubas = null;             // Uint8Array, which subas the ghost applies to
    this.base = new Float64Array(n);    // rest angle of each suba
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2;
      this.base[i] = a;
      this.x[i] = cx + Math.cos(a) * d.innerR;
      this.y[i] = cy + Math.sin(a) * d.innerR;
      this.wall[i] = 1;
    }
    this.bx = cx; this.by = cy; this.bvx = 0; this.bvy = 0;
    this.cx = cx; this.cy = cy; this.avx = 0; this.avy = 0;
    this.area = d.innerArea;
    this.merged = false;       // made by a merge (counts for score)
    this.allowMerges = true;
    this.flash = 0; this.flashT = 0;
    this.onBar = false;        // float bar forces apply
    this.frozen = false;
    this.dead = false;
    this.touched = false;      // any external contact this tick
    this.labelAng = 0; this.labelVel = 0;
  }
  SB.Sobo = Sobo;

  Sobo.prototype.setVelocity = function (vx, vy) {
    for (var i = 0; i < this.n; i++) { this.vx[i] = vx; this.vy[i] = vy; }
    this.bvx = vx; this.bvy = vy;
  };
  Sobo.prototype.addVelocity = function (vx, vy) {
    for (var i = 0; i < this.n; i++) { this.vx[i] += vx; this.vy[i] += vy; }
    this.bvx += vx; this.bvy += vy;
  };
  Sobo.prototype.setWalls = function (on) {
    for (var i = 0; i < this.n; i++) this.wall[i] = on ? 1 : 0;
  };
  Sobo.prototype.measure = function () {
    var n = this.n, x = this.x, y = this.y, sx = 0, sy = 0, svx = 0, svy = 0, i;
    for (i = 0; i < n; i++) { sx += x[i]; sy += y[i]; svx += this.vx[i]; svy += this.vy[i]; }
    this.cx = sx / n; this.cy = sy / n; this.avx = svx / n; this.avy = svy / n;
    // Signed area (positive for the ring's winding) and outward normals.
    var area = 0, j = n - 1;
    for (i = 0; i < n; i++) { area += x[j] * y[i] - y[j] * x[i]; j = i; }
    this.area = area / 2;
    var p = n - 1, e0x = x[0] - x[p], e0y = y[0] - y[p];
    var l0 = Math.hypot(e0x, e0y) || 1; e0x /= l0; e0y /= l0;
    for (i = 0; i < n; i++) {
      var k = i + 1 === n ? 0 : i + 1;
      var e1x = x[k] - x[i], e1y = y[k] - y[i];
      var l1 = Math.hypot(e1x, e1y) || 1; e1x /= l1; e1y /= l1;
      // Edge normal = edge direction turned -90 degrees; average the two.
      var nx = e0y + e1y, ny = -e0x - e1x, nl = Math.hypot(nx, ny);
      if (nl < 1e-9) { nx = e1y; ny = -e1x; nl = 1; }
      this.nx[i] = nx / nl; this.ny[i] = ny / nl;
      e0x = e1x; e0y = e1y;
    }
  };
  /* Point inside the ring polygon through the suba centres (pad grows it). */
  Sobo.prototype.contains = function (px, py, pad) {
    var x = this.x, y = this.y, n = this.n, inside = false, j = n - 1;
    pad = pad || 0;
    for (var i = 0; i < n; i++) {
      var xi = x[i] + this.nx[i] * pad, yi = y[i] + this.ny[i] * pad;
      var xj = x[j] + this.nx[j] * pad, yj = y[j] + this.ny[j] * pad;
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
      j = i;
    }
    return inside;
  };
  /* 几何可行的规则圆半径下限：在该半径下，同球非相邻（环上 dn=2）膜点的弦长
     恰好略大于接触距离 CONTACT，于是重排后的膜点不会自己穿透自己。
     旧实现固定 innerR*0.5，对大球该弦长仅约 16 < 24，自碰撞逐帧反推超速、
     又触发兜底，形成“缩成小圆卡死”的死循环。 */
  Sobo.prototype.safeRadius = function () {
    var n = this.n;
    var dn = (n >= 5) ? 2 : (n - 1);
    // 2*r*sin(pi*dn/n) = CONTACT*1.05 → r。再夹到健康半径以内。
    var r = (CONTACT * 1.05) / (2 * Math.sin(Math.PI * dn / n));
    if (!(r > 0) || !isFinite(r)) r = this.data.innerR;
    return Math.min(this.data.innerR, r);
  };

  /* 灾难兜底：把膜点重排到以当前球心为圆心的几何可行规则圆上，并一次性清零速度。
     radius 可由世界根据墙/邻球环境给出；默认恢复到健康尺寸 innerR。
     无论如何半径不会小于 safeRadius()（保证不自穿透），也不会超过 innerR。
     px/py 同步到新位置，避免下一步 _settle 用旧位置反推出巨速度。 */
  Sobo.prototype.fixShape = function (radius) {
    var r = radius;
    if (!(r > 0) || !isFinite(r)) r = this.data.innerR;
    var rs = this.safeRadius();
    if (r < rs) r = rs;
    if (r > this.data.innerR) r = this.data.innerR;
    if (!isFinite(this.cx) || !isFinite(this.cy)) { this.cx = this.bx; this.cy = this.by; }
    if (!isFinite(this.cx) || !isFinite(this.cy)) { this.cx = 0; this.cy = 0; }
    var cx = this.cx, cy = this.cy;
    for (var i = 0; i < this.n; i++) {
      this.x[i] = cx + Math.cos(this.base[i]) * r;
      this.y[i] = cy + Math.sin(this.base[i]) * r;
      this.px[i] = this.x[i]; this.py[i] = this.y[i];
      this.vx[i] = 0; this.vy[i] = 0;
    }
    this.bx = cx; this.by = cy; this.bvx = 0; this.bvy = 0;
    this.measure();
  };
  Sobo.prototype.blownUp = function () {
    var d = this.data, max2 = 2000 * 2000;
    if (!(this.area > 0) || this.area > d.innerArea * 1.8) return true;
    if (!isFinite(this.cx + this.cy + this.bx + this.by + this.bvx + this.bvy)) return true;
    if (this.bvx * this.bvx + this.bvy * this.bvy > max2) return true;
    // 注意：这里只判定“整体灾难”（面积崩、膜点飞散、速度爆、非有限）。
    // 单条膜边被极端拉长（>4.5*SPACING）但整体健康时，不再整体重置，
    // 而是由 World._clampEdges 在约束阶段做温和的局部缝合，避免把正常球缩到
    // 约四分之一、塞进外物并引发速度爆炸的连锁重建。
    var rad2 = d.innerR * d.innerR * 9;
    for (var i = 0; i < this.n; i++) {
      var vx = this.vx[i], vy = this.vy[i];
      if (!isFinite(this.x[i] + this.y[i] + vx + vy)) return true;
      if (vx * vx + vy * vy > max2) return true;
      var dx = this.x[i] - this.cx, dy = this.y[i] - this.cy;
      if (dx * dx + dy * dy > rad2) return true;
    }
    return false;
  };

  /* 局部膜边缝合：整体健康的球，个别膜边被极端拉长（超过 4.5*SPACING，
   * 常见于合并颈部），把该边两端点沿连线等距、渐进地收回到安全长度，
   * 保持中点不动。这是纯位置投影，必须在 _settle 之前调用，使速度由
   * 修正后的位置反推（位置/速度一致）。只收超长部分的 beta，单步位移
   * 温和，不会造成速度爆炸；皮肤力随后继续把边拉回静止间距。 */
  World.prototype._clampEdges = function (s) {
    if (s.frozen) return;
    var n = s.n, x = s.x, y = s.y, hard = SPACING * 4.5, safe = SPACING * 2, beta = 0.35;
    var j = n - 1;
    for (var i = 0; i < n; i++) {
      var dx = x[i] - x[j], dy = y[i] - y[j], d = Math.sqrt(dx * dx + dy * dy);
      if (d > hard) {
        var target = d + (safe - d) * beta;
        var t = (d - target) / (2 * d);
        x[j] += dx * t; y[j] += dy * t;
        x[i] -= dx * t; y[i] -= dy * t;
      }
      j = i;
    }
  };

  /* 两条非相邻边严格相交（拓扑自交）检测。环顺序 p→q、r→s。
   * 面积检测（blownUp）会漏掉这种交叉，需单独按几何判断。 */
  function segCross(x, y, p, q, r, s) {
    function orient(a, b, c) {
      return (x[b] - x[a]) * (y[c] - y[a]) - (y[b] - y[a]) * (x[c] - x[a]);
    }
    var o1 = orient(p, q, r), o2 = orient(p, q, s);
    var o3 = orient(r, s, p), o4 = orient(r, s, q);
    return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))
      && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
  }
  /* 检测并理顺颈部局部翻转：合并后颈部相邻点顺序颠倒（如 b 应在 c 上方却在下方），
   * 会让两条非相邻边交叉。做法是以两个外部点 i→d 为纵轴，把内部相邻点 b、c
   * 的纵向分量重新排序（位置投影），不重置圆、不加持续外力。返回是否修正。 */
  Sobo.prototype._untangle = function () {
    var n = this.n, x = this.x, y = this.y, changed = false;
    // 四个连续膜点 i→b→c→d（下标全部 mod n），当首边 (i,b) 与尾边 (c,d)
    // 严格交叉时，说明中间相邻点 b、c 纵向顺序颠倒。纯循环下标可自然覆盖
    // n-1→0 接缝（旧实现用线性内层循环，漏掉跨接缝的翻转）。
    for (var q = 0; q < n; q++) {
      var i = q, b = (q + 1) % n, c = (q + 2) % n, d = (q + 3) % n;
      if (!segCross(x, y, i, b, c, d)) continue;
      // 以两个外部点 i→d 为纵轴，分解内部点 b、c 的纵向/横向分量。
      var aX = x[i], aY = y[i], vX = x[d] - x[i], vY = y[d] - y[i], vL2 = vX * vX + vY * vY;
      if (vL2 < 1e-9) continue;
      function local(p) {
        var dx = x[p] - aX, dy = y[p] - aY;
        var t = (dx * vX + dy * vY) / vL2;
        return { t: t, nx: dx - vX * t, ny: dy - vY * t };
      }
      var lb = local(b), lc = local(c);
      if (lb.t > lc.t) {
        // 纵向顺序颠倒：交换纵向分量，各自保留横向分量。
        x[b] = aX + vX * lc.t + lb.nx; y[b] = aY + vY * lc.t + lb.ny;
        x[c] = aX + vX * lb.t + lc.nx; y[c] = aY + vY * lb.t + lc.ny;
        changed = true;
      }
    }
    return changed;
  };

  /* ---------- world ---------- */
  function World() {
    this.sobos = [];
    this.edges = [];          // field walls: {px, py, nx, ny} with inward normal
    this.bumpers = [];
    this.bar = null;          // {y, freq, dampX, dampY, inward}
    this.shocks = [];
    this.recoveries = [];
    this.pairs = [];          // same-tier contacts this tick: {a, b, ia, ib, y}
    this._pairKeys = {};
    this.impact = 0;          // hardest suba hit this tick (for sound)
    this.scan = 0;
    this._hash = { cell: new Map() };
  }
  SB.World = World;

  /* Field walls from a convex polygon (any winding). */
  World.prototype.setField = function (pts) {
    var cx = 0, cy = 0, i;
    for (i = 0; i < pts.length; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx /= pts.length; cy /= pts.length;
    this.edges = [];
    for (i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      var ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey);
      var nx = -ey / l, ny = ex / l;
      if ((cx - a[0]) * nx + (cy - a[1]) * ny < 0) { nx = -nx; ny = -ny; }
      this.edges.push({ px: a[0], py: a[1], nx: nx, ny: ny });
    }
    this.field = pts;
  };

  /* A bumper slides along x from its rest position outward by `travel`. */
  World.prototype.addBumper = function (x, y, dir) {
    var b = { restX: x, x: x, y: y, vx: 0, dir: dir, r: CFG.bumperR, locked: false, touch: false };
    this.bumpers.push(b);
    return b;
  };

  World.prototype.add = function (s) { this.sobos.push(s); s.measure(); return s; };
  World.prototype.remove = function (s) {
    s.dead = true;
    var i = this.sobos.indexOf(s);
    if (i >= 0) this.sobos.splice(i, 1);
  };
  World.prototype.clear = function () {
    this.sobos.length = 0; this.shocks.length = 0; this.recoveries.length = 0;
    for (var i = 0; i < this.bumpers.length; i++) {
      var b = this.bumpers[i]; b.x = b.restX; b.vx = 0; b.locked = false;
    }
  };

  World.prototype.step = function () {
    var dt = CFG.tick, sub = CFG.substeps, h = dt / sub, i, s;
    this.pairs.length = 0; this._pairKeys = {};
    this.impact = 0;
    for (i = 0; i < this.sobos.length; i++) this.sobos[i].touched = false;
    for (i = 0; i < this.bumpers.length; i++) this.bumpers[i].touch = false;

    for (var st = 0; st < sub; st++) {
      for (i = 0; i < this.sobos.length; i++) {
        s = this.sobos[i];
        if (s.frozen) continue;
        s.measure();
        this._forces(s, h);
      }
      this._bumperForces(h);
      this._move(h);
      for (var it = 0; it < CFG.iterations; it++) {
        this._collide(it === CFG.iterations - 1);
        this._walls();
      }
      // 极端拉长的膜边先做局部缝合（位置投影），与碰撞/墙同处 _settle 之前，
      // 速度由修正后的位置反推，保证位置/速度一致。
      for (var cI = 0; cI < this.sobos.length; cI++) this._clampEdges(this.sobos[cI]);
      this._settle(h);
      // 约束求解后理顺颈部局部翻转（位置投影，不影响速度/材料）。
      for (var uI = 0; uI < this.sobos.length; uI++) {
        if (!this.sobos[uI].frozen) this.sobos[uI]._untangle();
      }
    }

    for (i = 0; i < this.sobos.length; i++) {
      s = this.sobos[i];
      s.measure();
      if (s.flash > 0) {
        s.flashT += dt;
        var t = s.flashT / s.data.flash;
        s.flash = t >= 1 ? 0 : 1 - t * t;
      }
      if (!s.frozen && s.blownUp()) this._rescue(s);
    }
    this._shockwaves(dt);
    this._overlaps(dt);
  };

  /* Accelerations from gravity, damping, skin, area, the ball spring and the bar. */
  World.prototype._forces = function (s, h) {
    var n = s.n, x = s.x, y = s.y, vx = s.vx, vy = s.vy, ax = s.ax, ay = s.ay, i, j;
    var g = CFG.gravity;
    for (i = 0; i < n; i++) { ax[i] = 0; ay[i] = g; }

    // Skin: only resists stretching.
    j = n - 1;
    for (i = 0; i < n; i++) {
      var dx = x[i] - x[j], dy = y[i] - y[j], d = Math.sqrt(dx * dx + dy * dy);
      if (d > SPACING) {
        var ux = dx / d, uy = dy / d;
        var f = CFG.skinFreq * (d - SPACING) + CFG.skinDamp * ((vx[i] - vx[j]) * ux + (vy[i] - vy[j]) * uy);
        if (f > CFG.skinMax) f = CFG.skinMax; else if (f < -CFG.skinMax) f = -CFG.skinMax;
        ax[j] += f * ux; ay[j] += f * uy;
        ax[i] -= f * ux; ay[i] -= f * uy;
      }
      j = i;
    }

    // Area: push out along the normals by the missing area, net force zero.
    var diff = s.data.innerArea - s.area, mx = 0, my = 0, fx, fy, fm;
    for (i = 0; i < n; i++) {
      fx = CFG.areaForce * diff * s.nx[i]; fy = CFG.areaForce * diff * s.ny[i];
      fm = Math.sqrt(fx * fx + fy * fy);
      if (fm > CFG.areaMax) { fx *= CFG.areaMax / fm; fy *= CFG.areaMax / fm; }
      s.nx[i] = fx; s.ny[i] = fy;   // reuse as scratch; measure() refreshes them
      mx += fx; my += fy;
    }
    mx /= n; my /= n;
    for (i = 0; i < n; i++) { ax[i] += s.nx[i] - mx; ay[i] += s.ny[i] - my; }

    // Mass ball spring, with the reaction shared by the ring.
    var M = s.data.ballMass;
    var bfx = (CFG.ballFreq * (s.cx - s.bx) + CFG.ballDamp * (s.avx - s.bvx)) * M;
    var bfy = (CFG.ballFreq * (s.cy - s.by) + CFG.ballDamp * (s.avy - s.bvy)) * M;
    var rx = -bfx / n, ry = -bfy / n;
    for (i = 0; i < n; i++) { ax[i] += rx; ay[i] += ry; }
    var bax = bfx / M, bay = bfy / M + g;

    // Float bar: vertical spring to the bar line, damping, push to the middle.
    var bar = this.bar;
    if (s.onBar && bar) {
      for (i = 0; i < n; i++) {
        ax[i] += -bar.dampX * vx[i] - bar.inward * (x[i] > 0 ? 1 : x[i] < 0 ? -1 : 0);
        ay[i] += bar.freq * (bar.y - y[i]) - bar.dampY * vy[i];
      }
    }
    if (s.ghostSubas) {
      // Overlap recovery: stuck subas crawl back toward their own centre.
      for (i = 0; i < n; i++) {
        if (!s.ghostSubas[i]) continue;
        var ox = s.cx - x[i], oy = s.cy - y[i], ol = Math.hypot(ox, oy) || 1;
        ax[i] += ox / ol * CFG.overlapAccel; ay[i] += oy / ol * CFG.overlapAccel;
      }
    }
    if (s.push) { for (i = 0; i < n; i++) { ax[i] += s.push[0]; ay[i] += s.push[1]; } bax += s.push[0]; bay += s.push[1]; }

    // Integrate velocities (semi-implicit Euler) with Godot's linear damp.
    var damp = Math.max(0, 1 - h * CFG.linearDamp);
    for (i = 0; i < n; i++) {
      vx[i] = (vx[i] + ax[i] * h) * damp;
      vy[i] = (vy[i] + ay[i] * h) * damp;
    }
    s.bvx = (s.bvx + bax * h) * damp;
    s.bvy = (s.bvy + bay * h) * damp;
  };

  World.prototype._bumperForces = function (h) {
    for (var i = 0; i < this.bumpers.length; i++) {
      var b = this.bumpers[i];
      if (b.locked) { b.vx = 0; continue; }
      var a = CFG.bumperFreq * (b.restX - b.x) - CFG.bumperDamp * b.vx;
      b.vx += a * h;
      b.px = b.x;
      b.x += b.vx * h;
      this._clampBumper(b);
    }
  };
  World.prototype._clampBumper = function (b) {
    var far = b.restX + b.dir * CFG.bumperTravel;
    var lo = Math.min(b.restX, far), hi = Math.max(b.restX, far);
    if (b.x < lo) b.x = lo; else if (b.x > hi) b.x = hi;
  };

  World.prototype._move = function (h) {
    for (var k = 0; k < this.sobos.length; k++) {
      var s = this.sobos[k];
      if (s.frozen) continue;
      for (var i = 0; i < s.n; i++) {
        s.px[i] = s.x[i]; s.py[i] = s.y[i];
        s.x[i] += s.vx[i] * h; s.y[i] += s.vy[i] * h;
      }
      s.bx += s.bvx * h; s.by += s.bvy * h;
    }
  };

  /* Velocities from the corrected motion (inelastic, frictionless contacts). */
  World.prototype._settle = function (h) {
    var inv = 1 / h, k, i;
    for (k = 0; k < this.sobos.length; k++) {
      var s = this.sobos[k];
      if (s.frozen) continue;
      for (i = 0; i < s.n; i++) {
        s.vx[i] = (s.x[i] - s.px[i]) * inv;
        s.vy[i] = (s.y[i] - s.py[i]) * inv;
      }
    }
    for (k = 0; k < this.bumpers.length; k++) {
      var b = this.bumpers[k];
      if (!b.locked && b.px !== undefined) b.vx = (b.x - b.px) * inv;
    }
  };

  /* Suba against suba, through a spatial hash. Adjacent subas of one ring
   * never collide; other subas of the same ring do, so rings cannot fold. */
  World.prototype._collide = function (record) {
    var sobos = this.sobos, map = this._hash.cell, k, i, s;
    map.clear();
    var total = 0;
    // 本帧发现的“跨球深穿透”配对（tunneling：两膜点几乎重叠）。这种情况硬接触
    // 投影会把单点在一帧内暴推数十像素、由 _settle 反推出几千的假速度，统一改为
    // 在本次 _collide 结束后转 ghost 缓出（复用 _overlaps 机制），不做硬投影。
    var deepPairs = [], deepKeys = {};
    var DEEP2 = (CONTACT * 0.5) * (CONTACT * 0.5);
    for (k = 0; k < sobos.length; k++) {
      s = sobos[k];
      for (i = 0; i < s.n; i++) {
        var key = (Math.floor(s.x[i] / CELL) + 512) * 4096 + (Math.floor(s.y[i] / CELL) + 512);
        var list = map.get(key);
        if (!list) { list = []; map.set(key, list); }
        list.push(k, i);
        total++;
      }
    }
    var C2 = CONTACT * CONTACT;
    // 预建“球对 → 该配对穿透节点 mask”的查表。碰撞解碰过滤只能看当前 A/B
    // 这一对的 mask；不能用球级聚合的 ghostSubas（它把 A-C、A-B 等多个恢复关系
    // 合并在一起），否则 A-C 标记的节点会让 A-B 的真实表面接触被错误跳过。
    var rm = this._recMask || (this._recMask = new Map());
    rm.clear();
    for (var rr = 0; rr < this.recoveries.length; rr++) {
      var RC = this.recoveries[rr];
      rm.set(RC.a.id * 65536 + RC.b.id, { a: RC.aMask, b: RC.bMask });
      rm.set(RC.b.id * 65536 + RC.a.id, { a: RC.bMask, b: RC.aMask });
    }
    for (k = 0; k < sobos.length; k++) {
      var A = sobos[k];
      for (i = 0; i < A.n; i++) {
        var gx = Math.floor(A.x[i] / CELL) + 512, gy = Math.floor(A.y[i] / CELL) + 512;
        for (var ox = -1; ox <= 1; ox++) {
          for (var oy = -1; oy <= 1; oy++) {
            var cell = map.get((gx + ox) * 4096 + gy + oy);
            if (!cell) continue;
            for (var c = 0; c < cell.length; c += 2) {
              var kb = cell[c], j = cell[c + 1];
              if (kb < k || (kb === k && j <= i)) continue;
              var B = sobos[kb];
              if (kb === k) {
                var dn = j - i;
                if (dn === 1 || dn === A.n - 1) continue;
              } else if (A.ghost || B.ghost) {
                // 只跳过“本配对”仍处于穿透恢复中的节点；其他配对的标记不得串用。
                var pm = rm.get(A.id * 65536 + B.id);
                if (pm && (pm.a[i] || pm.b[j])) continue;
              }
              var dx = B.x[j] - A.x[i], dy = B.y[j] - A.y[i], d2 = dx * dx + dy * dy;
              if (d2 >= C2 || d2 < 1e-12) continue;
              var d = Math.sqrt(d2), nx = dx / d, ny = dy / d, p = (CONTACT - d) * 0.5;
              if (kb !== k && d2 < DEEP2) {
                // 跨球膜点几乎重叠（整体穿透）：排队转 ghost 缓出，不做暴推硬投影。
                var dk = A.id < B.id ? A.id * 65536 + B.id : B.id * 65536 + A.id;
                if (!deepKeys[dk]) {
                  deepKeys[dk] = 1;
                  deepPairs.push(A.id < B.id ? [A, B] : [B, A]);
                }
                continue;
              }
              var fa = A.frozen ? 0 : B.frozen ? 2 : 1, fb = B.frozen ? 0 : A.frozen ? 2 : 1;
              A.x[i] -= nx * p * fa; A.y[i] -= ny * p * fa;
              B.x[j] += nx * p * fb; B.y[j] += ny * p * fb;
              if (kb !== k && record) {
                A.touched = B.touched = true;
                var rv = (A.vx[i] - B.vx[j]) * nx + (A.vy[i] - B.vy[j]) * ny;
                if (rv > this.impact) this.impact = rv;
                if (A.tier === B.tier) {
                  var pk = A.id < B.id ? A.id * 65536 + B.id : B.id * 65536 + A.id;
                  var my = (A.y[i] + B.y[j]) / 2, prev = this._pairKeys[pk];
                  if (prev === undefined) {
                    this._pairKeys[pk] = this.pairs.length;
                    this.pairs.push({ a: A, b: B, ia: i, ib: j, y: my });
                  } else if (my > this.pairs[prev].y) {
                    var pr = this.pairs[prev]; pr.a = A; pr.b = B; pr.ia = i; pr.ib = j; pr.y = my;
                  }
                }
              }
            }
          }
        }
      }
    }
    this.count = total;
    this._deepCount = (this._deepCount || 0) + deepPairs.length;
    // 本帧发现的深穿透配对：按真实轮廓收集互相侵入的节点，立即转 ghost 缓出。
    // 不等 _overlaps 的 1/15 轮扫（否则接触力已先暴推），也不触碰浅接触（d≥DEEP）。
    for (var dp = 0; dp < deepPairs.length; dp++) {
      var DA = deepPairs[dp][0], DB = deepPairs[dp][1];
      if (DA.dead || DB.dead || this._recovering(DA, DB)) continue;
      var inA = null, inB = null, qq;
      for (qq = 0; qq < DA.n; qq++) if (DB.contains(DA.x[qq], DA.y[qq])) { (inA = inA || []).push(qq); }
      for (qq = 0; qq < DB.n; qq++) if (DA.contains(DB.x[qq], DB.y[qq])) { (inB = inB || []).push(qq); }
      if (inA || inB) this._startRecovery(DA, DB, inA || [], inB || []);
    }
  };

  /* Field walls (only for subas whose wall collision is on) and bumpers. */
  World.prototype._walls = function () {
    var edges = this.edges, bumpers = this.bumpers, R = SUBA_R;
    for (var k = 0; k < this.sobos.length; k++) {
      var s = this.sobos[k];
      if (s.frozen) continue;
      var x = s.x, y = s.y;
      for (var i = 0; i < s.n; i++) {
        if (s.wall[i]) {
          for (var e = 0; e < edges.length; e++) {
            var E = edges[e];
            var d = (x[i] - E.px) * E.nx + (y[i] - E.py) * E.ny;
            if (d < R) { x[i] += E.nx * (R - d); y[i] += E.ny * (R - d); s.touched = true; }
          }
        }
        for (var b = 0; b < bumpers.length; b++) {
          var B = bumpers[b];
          var dx = x[i] - B.x, dy = y[i] - B.y, d2 = dx * dx + dy * dy, lim = B.r + R;
          if (d2 >= lim * lim) continue;
          var dd = Math.sqrt(d2) || 1, pen = lim - dd, ux = dx / dd, uy = dy / dd;
          // Suba (mass 1) against the bumper (mass 10, free only along x).
          var wB = B.locked ? 0 : ux * ux / CFG.bumperMass, lam = pen / (1 + wB);
          x[i] += ux * lam; y[i] += uy * lam;
          if (wB > 0) { B.x -= ux * lam / CFG.bumperMass; this._clampBumper(B); }
          B.touch = true; s.touched = true;
        }
      }
    }
  };

  /* Expanding shockwave from a merge: each suba it reaches gets one kick
   * outward, worth 100 px/s per second of remaining life (spec 17). */
  World.prototype.shock = function (x, y, life) {
    this.shocks.push({ x: x, y: y, life: life, r: 0, hit: {} });
  };
  World.prototype._shockwaves = function (dt) {
    for (var w = this.shocks.length - 1; w >= 0; w--) {
      var S = this.shocks[w];
      S.life -= dt;
      S.r += CFG.shockSpeed * dt;
      if (S.life <= 0) { this.shocks.splice(w, 1); continue; }
      var lim = S.r + SUBA_R, lim2 = lim * lim, kick = S.life * CFG.shockImpulse;
      for (var k = 0; k < this.sobos.length; k++) {
        var s = this.sobos[k];
        if (s.frozen) continue;
        for (var i = 0; i < s.n; i++) {
          var dx = s.x[i] - S.x, dy = s.y[i] - S.y, d2 = dx * dx + dy * dy;
          if (d2 > lim2) continue;
          var key = s.id * 1024 + i;
          if (S.hit[key]) continue;
          S.hit[key] = 1;
          var d = Math.sqrt(d2) || 1;
          s.vx[i] += dx / d * kick; s.vy[i] += dy / d * kick;
        }
      }
    }
  };

  /* Overlap recovery (spec 5.4): a suba that ended up inside another sobo
   * stops colliding with it and crawls back toward its own centre. */
  World.prototype._overlaps = function (dt) {
    var sobos = this.sobos, i, k, r;
    // Scan a fifteenth of the sobos each tick.
    var step = 15, start = this.scan % step;
    this.scan++;
    for (k = start; k < sobos.length; k += step) {
      var A = sobos[k];
      for (var m = 0; m < sobos.length; m++) {
        var B = sobos[m];
        if (B === A) continue;
        var dx = B.cx - A.cx, dy = B.cy - A.cy, reach = A.data.outerR + B.data.outerR;
        if (dx * dx + dy * dy > reach * reach) continue;
        if (this._recovering(A, B)) continue;
        var inA = null, inB = null;
        for (i = 0; i < A.n; i++) if (B.contains(A.x[i], A.y[i])) { (inA = inA || []).push(i); }
        if (!inA) continue;
        for (i = 0; i < B.n; i++) if (A.contains(B.x[i], B.y[i])) { (inB = inB || []).push(i); }
        this._startRecovery(A, B, inA, inB || []);
      }
    }
    for (r = this.recoveries.length - 1; r >= 0; r--) {
      var R = this.recoveries[r];
      if (R.a.dead || R.b.dead) { this._endRecovery(r); continue; }
      R.t += dt;
      if (R.t >= CFG.overlapTimeout) {
        var ta = R.a, tb = R.b;
        // 先解除本配对 ghost，_rescue 才能据当前穿透决定是否重新缓出。
        this._endRecovery(r);
        this._rescue(ta); this._rescue(tb);
        continue;
      }
      var stillA = false, stillB = false;
      // 逐节点检查的是“本配对”的 mask（R.aMask/R.bMask），不直接改球级数组。
      for (i = 0; i < R.a.n; i++) {
        if (!R.aMask[i]) continue;
        if (R.b.contains(R.a.x[i], R.a.y[i], 4)) stillA = true; else R.aMask[i] = 0;
      }
      for (i = 0; i < R.b.n; i++) {
        if (!R.bMask[i]) continue;
        if (R.a.contains(R.b.x[i], R.b.y[i], 4)) stillB = true; else R.bMask[i] = 0;
      }
      // 配对 mask 变化后重新聚合为球的有效 ghostSubas，保留其他配对的标记。
      this._rebuildGhost(R.a); this._rebuildGhost(R.b);
      if (R.contain) {
        // The smaller one is fully inside: push it out of the container.
        var ex = R.a.cx - R.b.cx, ey = R.a.cy - R.b.cy, el = Math.hypot(ex, ey);
        if (el < 1e-6) { ex = 1; ey = 0; el = 1; }
        R.a.push = [ex / el * CFG.overlapAccel, ey / el * CFG.overlapAccel];
      }
      if (!stillA && !stillB) this._endRecovery(r);
    }
  };
  /* 环境感知的灾难兜底：先用几何可行半径重建规则圆（fixShape），半径还要避开
     墙与非幽灵邻球；当球被严重夹死、连最小可行圆都放不下时，把仍侵入的邻球
     配对转成 ghost 穿透缓出（复用 _overlaps 机制），而不是缩到更小的自碰撞圆。
     blownUp 与 overlapTimeout 两条路径都经这里，保持恢复行为一致。 */
  World.prototype._rescue = function (s) {
    if (!s || s.dead) return;
    // 0) 重置会改变膜点位置，该球既有穿透恢复的 mask（按旧轮廓索引）与 push 随即失效。
    //    先解除它参与的全部旧恢复（连同残留的分离 push），重置后再按新轮廓统一重新判定，
    //    避免旧 mask/push 用旧位置在下一步制造新冲量。倒序删除以保持索引有效。
    for (var ri = this.recoveries.length - 1; ri >= 0; ri--) {
      var R0 = this.recoveries[ri];
      if (R0.a === s || R0.b === s) this._endRecovery(ri);
    }
    var rs = s.safeRadius();
    // 1) 球心若贴墙（比 rs+SUBA_R 还近），先沿墙法线整体回拉，否则规则圆整片穿墙，
    //    会被墙投影逐点暴推、由 _settle 反推出几千速度。
    for (var e = 0; e < this.edges.length; e++) {
      var E = this.edges[e];
      var dw = (s.cx - E.px) * E.nx + (s.cy - E.py) * E.ny;
      var need = rs + SUBA_R;
      if (dw < need) { s.cx += E.nx * (need - dw); s.cy += E.ny * (need - dw); }
    }
    // 2) 环境允许的最大规则圆半径：墙方向 r ≤ 距墙 - SUBA_R；邻球连心方向
    //    r + rB + 2*SUBA_R ≤ d。
    var rEnv = s.data.innerR;
    for (e = 0; e < this.edges.length; e++) {
      E = this.edges[e];
      dw = (s.cx - E.px) * E.nx + (s.cy - E.py) * E.ny;
      rEnv = Math.min(rEnv, dw - SUBA_R);
    }
    for (var k = 0; k < this.sobos.length; k++) {
      var B = this.sobos[k];
      if (B === s || B.dead || this._recovering(s, B)) continue;
      var dx = B.cx - s.cx, dy = B.cy - s.cy, d = Math.hypot(dx, dy) || 1e-6;
      rEnv = Math.min(rEnv, d - B.data.innerR - 2 * SUBA_R);
    }
    // 3) 半径夹在 [几何可行下限, 健康半径]，绝不缩到会自穿透的尺寸。
    var r = Math.max(rs, Math.min(s.data.innerR, rEnv));
    s.fixShape(r);
    // 4) 安全网：重置后用真实轮廓实测，凡与非 ghost 邻球仍互相侵入的配对，
    //    一律立刻转 ghost 缓出（不等 _overlaps 的 1/15 扫描，否则下一帧接触力
    //    先爆发）。这样重置圆只参与有界的正常接触，不会被深穿透反推出超速。
    for (k = 0; k < this.sobos.length; k++) {
      B = this.sobos[k];
      if (B === s || B.dead || this._recovering(s, B)) continue;
      var inS = null, inB = null;
      for (var i = 0; i < s.n; i++) if (B.contains(s.x[i], s.y[i])) { (inS = inS || []).push(i); }
      for (var j = 0; j < B.n; j++) if (s.contains(B.x[j], B.y[j])) { (inB = inB || []).push(j); }
      if (inS || inB) this._startRecovery(s, B, inS || [], inB || []);
    }
  };
  World.prototype._recovering = function (A, B) {
    for (var r = 0; r < this.recoveries.length; r++) {
      var R = this.recoveries[r];
      if ((R.a === A && R.b === B) || (R.a === B && R.b === A)) return true;
    }
    return false;
  };
  World.prototype._startRecovery = function (A, B, inA, inB) {
    // 穿透节点归属“本配对”：aMask/bMask 各自独立，不再直接写球级共享数组。
    var R = {
      a: A, b: B, t: 0,
      contain: inB.length === 0 && inA.length >= A.n * 0.75,
      aMask: new Uint8Array(A.n), bMask: new Uint8Array(B.n)
    };
    for (var i = 0; i < inA.length; i++) R.aMask[inA[i]] = 1;
    for (var j = 0; j < inB.length; j++) R.bMask[inB[j]] = 1;
    if (R.contain) for (var k = 0; k < A.n; k++) R.aMask[k] = 1;
    // ghost（per-soboId）天然按对象隔离。
    A.ghost = A.ghost || {}; A.ghost[B.id] = true;
    B.ghost = B.ghost || {}; B.ghost[A.id] = true;
    this.recoveries.push(R);
    this._rebuildGhost(A); this._rebuildGhost(B);
  };
  /* 把所有活跃配对中涉及球 s 的 mask 聚合为球的有效 ghostSubas；
   * 没有任何活跃配对时清空 ghost/ghostSubas。 */
  World.prototype._rebuildGhost = function (s) {
    var active = false;
    var mask = new Uint8Array(s.n);
    for (var r = 0; r < this.recoveries.length; r++) {
      var R = this.recoveries[r];
      if (R.a === s) { for (var i = 0; i < s.n; i++) if (R.aMask[i]) mask[i] = 1; active = true; }
      else if (R.b === s) { for (var j = 0; j < s.n; j++) if (R.bMask[j]) mask[j] = 1; active = true; }
    }
    if (active) {
      s.ghostSubas = mask;
    } else {
      s.ghost = null;
      s.ghostSubas = null;
    }
  };
  World.prototype._endRecovery = function (r) {
    var R = this.recoveries[r];
    this.recoveries.splice(r, 1);
    var A = R.a, B = R.b;
    // 只移除本配对的 per-soboId 标记，再重新聚合：其他配对的标记完整保留。
    if (A.ghost) delete A.ghost[B.id];
    if (B.ghost) delete B.ghost[A.id];
    this._rebuildGhost(A);
    this._rebuildGhost(B);
    R.a.push = null;
  };

  /* Merge two same-tier sobos touching at subas ia and ib (spec 6). The new
   * ring follows both old outlines (a peanut), resampled evenly by arc
   * length, and pressure inflates it to the next tier's size. */
  World.prototype.merge = function (A, B, ia, ib) {
    // 越界保护：没有更高等级数据时不创建更大物理体（由调用方决定如何处理）。
    if (A.tier + 1 >= TIERS.length) return null;
    var px = [], py = [], pvx = [], pvy = [], pwall = [], pent = [];
    [[A, ia], [B, ib]].forEach(function (q) {
      var s = q[0], c = q[1], n = s.n;
      for (var m = c + 1; m < c + n - 1; m++) {
        var i = m % n;
        px.push(s.x[i]); py.push(s.y[i]); pvx.push(s.vx[i]); pvy.push(s.vy[i]);
        // 同步收集每个源膜点的墙/入场状态，供新球继承。
        pwall.push(s.wall[i]); pent.push(s.entering[i]);
      }
    });
    var N = new Sobo(A.tier + 1, 0, 0), L = px.length, total = 0, seg = new Float64Array(L), k;
    for (k = 0; k < L; k++) {
      var k1 = (k + 1) % L;
      seg[k] = Math.hypot(px[k1] - px[k], py[k1] - py[k]);
      total += seg[k];
    }
    var per = total / N.n, dist = 0, walked = 0, at = 0;
    for (var i = 0; i < N.n; i++) {
      while (at < L - 1 && walked + seg[at] <= dist) { walked += seg[at]; at++; }
      var a1 = (at + 1) % L, t = seg[at] > 0 ? Math.min(1, (dist - walked) / seg[at]) : 0;
      N.x[i] = px[at] + (px[a1] - px[at]) * t; N.y[i] = py[at] + (py[a1] - py[at]) * t;
      N.vx[i] = pvx[at] + (pvx[a1] - pvx[at]) * t; N.vy[i] = pvy[at] + (pvy[a1] - pvy[at]) * t;
      // 入场状态继承：插值两端任一仍在墙外（entering），新点保持入场并关闭墙；
      // 只有两端都已恢复墙、且不在入场时，新点才恢复墙。墙外点绝不被墙强行推回。
      var e0 = pent[at], e1 = pent[a1], w0 = pwall[at], w1 = pwall[a1];
      N.entering[i] = (e0 || e1) ? 1 : 0;
      N.wall[i] = (!N.entering[i] && w0 && w1) ? 1 : 0;
      dist += per;
    }
    N.bx = (A.bx + B.bx) / 2; N.by = (A.by + B.by) / 2;
    N.bvx = (A.bvx + B.bvx) / 2; N.bvy = (A.bvy + B.bvy) / 2;
    N.merged = true;
    N.flash = 1; N.flashT = 0;
    N.labelAng = (A.labelAng + B.labelAng) / 2;
    N.labelVel = Math.random() < 0.5 ? -50 : 50;
    this.remove(A); this.remove(B);
    this.add(N);
    return N;
  };

  /* Nearest suba hit by a horizontal ray along y from x0 in direction dir
   * (+1 or -1). A ray starting inside a suba hits it at distance 0. */
  World.prototype.rayX = function (y0, x0, dir, maxLen, filter) {
    var best = Infinity, who = null, R2 = SUBA_R * SUBA_R;
    for (var k = 0; k < this.sobos.length; k++) {
      var s = this.sobos[k];
      if (filter && !filter(s)) continue;
      for (var i = 0; i < s.n; i++) {
        var dy = s.y[i] - y0;
        if (dy * dy >= R2) continue;
        var half = Math.sqrt(R2 - dy * dy);
        var along = (s.x[i] - x0) * dir;
        var hit = along - half;
        if (along + half < 0) continue;
        if (hit < 0) hit = 0;
        if (hit < best && hit <= maxLen) { best = hit; who = s; }
      }
    }
    return who ? { dist: best, sobo: who } : null;
  };

  /* Does a circle of radius r at (x, y) touch any suba? */
  World.prototype.circleFree = function (x, y, r) {
    var lim = r + SUBA_R, lim2 = lim * lim;
    for (var k = 0; k < this.sobos.length; k++) {
      var s = this.sobos[k];
      var dx = s.cx - x, dy = s.cy - y, reach = lim + s.data.outerR;
      if (dx * dx + dy * dy > reach * reach) continue;
      if (s.contains(x, y)) return false;
      for (var i = 0; i < s.n; i++) {
        var ex = s.x[i] - x, ey = s.y[i] - y;
        if (ex * ex + ey * ey < lim2) return false;
      }
    }
    return true;
  };
})(window.SB = window.SB || {});
