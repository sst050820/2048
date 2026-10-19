/*
 * Classic mode rules, following the original sobosuba
 * (docs/original-spec.md, sections 3, 6 to 11 and 15).
 *
 * Sobos spawn alternately from both sides, fly in through the walls and
 * float on the bar near the top. The player picks any selectable bar sobo
 * and drags to aim it: the shot goes the way the drag points. Two equal
 * sobos merge. The pile loses by shoving both side bumpers fully out
 * within half a second of each other.
 *
 * Mode owns the physics World and the rules. It draws nothing; the
 * renderer reads its state. Callers get events through `hooks`.
 */
(function (SB) {
  'use strict';

  var TICK = SB.PHYS.tick;
  var MAX_ARROW = 220;          // px of drag for a full-power shot
  var MAX_LAUNCH = 850;         // px/s added at full power
  var SELECT_RADIUS = 128;
  var SPAWN_SPEED = 400;
  var TICKS_BETWEEN_SPAWNS = 2;
  var SAFETY_TIME = 3;
  var HOLD_TIME = 0.5;
  var PREGAMEOVER_TIME = 3;
  var MAX_TIER = SB.TIERS.length - 1;   // 最高等级（0 起算）：不再向上升级

  /* Layouts (spec 3.1 and 3.2). Sides are [left, right]. */
  var LAYOUTS = {
    mobile: {
      field: [[-196, -320], [196, -320], [196, 240], [148, 288], [-148, 288], [-196, 240]],
      play: { x0: -218, y0: -344, x1: 218, y1: 311 },
      barY: -240,
      unlock: [0, 1, 3, 6, 10, 15],
      sides: [
        { spawnX: -260, rayLen: 488, detect: 196, zone: [-380, -304, -196, 288], bumperX: -228, wallX: -196,
          rayGauge: [-196, -64], dangerX: -208 },
        { spawnX: 260, rayLen: 808, detect: 196, zone: [196, -304, 348, 288], bumperX: 228, wallX: 196,
          rayGauge: [196, 64], dangerX: 208 }
      ]
    },
    desktop: {
      field: [[-296, -320], [296, -320], [296, 256], [232, 320], [-232, 320], [-296, 256]],
      play: { x0: -328, y0: -360, x1: 328, y1: 360 },
      barY: -240,
      unlock: [0, 1, 3, 6, 10, 15, 21],
      sides: [
        { spawnX: -360, rayLen: 808, detect: 280, zone: [-480, -304, -296, 288], bumperX: -328, wallX: -296,
          rayGauge: [-296, -80], dangerX: -308 },
        { spawnX: 360, rayLen: 808, detect: 280, zone: [296, -304, 448, 288], bumperX: 328, wallX: 296,
          rayGauge: [296, 80], dangerX: 308 }
      ]
    }
  };
  var BUMPER_Y = -112;
  SB.LAYOUTS = LAYOUTS;

  function Classic(layoutName, hooks) {
    // 只用 LAYOUTS 的自有属性，避免 '__proto__'/'constructor' 等原型链名字被真值检查误判为布局。
    var hasLayout = typeof layoutName === 'string'
      && Object.prototype.hasOwnProperty.call(LAYOUTS, layoutName);
    var L = this.layout = hasLayout ? LAYOUTS[layoutName] : LAYOUTS.mobile;
    this.layoutName = hasLayout ? layoutName : 'mobile';
    this.hooks = hooks || {};
    var w = this.world = new SB.World();
    w.setField(L.field);
    w.bar = { y: L.barY, freq: 140, dampX: 1.2, dampY: 3, inward: 300 };
    this.sides = L.sides.map(function (sd, i) {
      var dir = i === 0 ? -1 : 1;
      return {
        def: sd, index: i, dir: dir,
        bumper: w.addBumper(sd.bumperX, BUMPER_Y, dir),
        holding: false, holdT: 0, press: 0,
        canSpawn: true, rayHit: null, barHit: null, rayDist: Infinity,
        flash: 0, danger: 0, dangerGauge: 0, portal: null
      };
    });
    this.reset();
  }
  SB.Classic = Classic;

  Classic.prototype.reset = function () {
    this.world.clear();
    this.state = 'playing';      // playing | pregameover | gameover
    this.emerging = []; this.selectable = []; this.stack = [];
    this.score = 0;
    this.lastSide = 0;           // so the first spawn is on the right
    this.spawnDelay = 0;
    this.safetyT = 0;
    this.pool = [0];
    this.mergeCounts = {};
    this.aim = null;             // {sobo, ox, oy, px, py, vx, vy, passed, device}
    this.hovered = null;
    this.pointer = null;         // last pointer position in world units
    this.preT = 0;
    this.beam = 0;
    this.ticks = 0;
    this.biggest = 0;
    for (var i = 0; i < this.sides.length; i++) {
      var s = this.sides[i];
      s.holding = false; s.holdT = 0; s.press = 0; s.flash = 0; s.danger = 0; s.dangerGauge = 0;
    }
    var L = this.layout;
    for (var t = 0; t < L.unlock.length; t++) if (L.unlock[t] === 0 && this.pool.indexOf(t) < 0) this.pool.push(t);
  };

  /* ---------- roles ---------- */
  Classic.prototype.onBar = function (s) { return this.emerging.indexOf(s) >= 0 || this.selectable.indexOf(s) >= 0; };
  // 球是否仍处于侧边入场中（还有膜点尚未穿过墙）。
  Classic.prototype._inEntrance = function (s) {
    for (var i = 0; i < s.n; i++) if (s.entering[i]) return true;
    return false;
  };
  Classic.prototype._dropRoles = function (s) {
    var lists = [this.emerging, this.selectable, this.stack];
    for (var i = 0; i < lists.length; i++) { var k = lists[i].indexOf(s); if (k >= 0) lists[i].splice(k, 1); }
  };
  Classic.prototype._emerging = function (s) {
    this._dropRoles(s);
    this.emerging.push(s);
    s.onBar = true; s.allowMerges = false;
    this._emit('barJoin', s);
  };
  Classic.prototype._selectable = function (s) {
    var was = this.onBar(s);
    this._dropRoles(s);
    this.selectable.push(s);
    s.onBar = true; s.allowMerges = true;
    if (!was) this._emit('barJoin', s);
  };
  Classic.prototype._stack = function (s) {
    var was = this.onBar(s);
    this._dropRoles(s);
    this.stack.push(s);
    s.onBar = false;
    if (was) this._emit('barLeave', s);
  };
  Classic.prototype._emit = function (name) {
    var f = this.hooks[name];
    if (f) f.apply(null, Array.prototype.slice.call(arguments, 1));
  };

  /* ---------- one physics tick ---------- */
  Classic.prototype.tick = function () {
    if (this.state !== 'playing') return;
    this.ticks++;
    this.world.step();
    this._reenable();
    this._merges();
    this._rays();
    this._aimTick();
    this._spawning();
    this._bumpers();
    this._labels();
    if (this.sides[0].holding && this.sides[1].holding) this._preGameOver();
  };

  /* Cosmetic timers that keep running while the board is frozen. */
  Classic.prototype.frame = function (dt) {
    for (var i = 0; i < this.sides.length; i++) {
      var s = this.sides[i];
      s.flash += (0 - s.flash) * Math.min(1, 4 * dt); if (s.flash < 0.1) s.flash = 0;
      s.danger += (0 - s.danger) * Math.min(1, 4 * dt); if (s.danger < 0.1) s.danger = 0;
      if (s.holding && this.state === 'playing') s.danger = 1;
    }
    if (this.state === 'pregameover') {
      this.beam += (0 - this.beam) * Math.min(1, 3 * dt);
      this.preT += dt;
      if (this.preT >= PREGAMEOVER_TIME) { this.state = 'gameover'; this._emit('gameOver', this.score); }
    }
  };

  /* A suba that has crossed into the field gets its wall collision back;
   * the first one to cross makes the sobo selectable (spec 7.4). */
  Classic.prototype._reenable = function () {
    var sides = this.sides;
    var all = this.world.sobos;
    for (var si = 0; si < sides.length; si++) sides[si].inside = 0;
    for (var a = 0; a < all.length; a++) {
      var s = all[a], crossed = false;
      for (var i = 0; i < s.n; i++) {
        if (!s.entering[i]) continue;
        var inZone = false;
        for (si = 0; si < sides.length; si++) {
          var z = sides[si].def.zone, R = SB.SUBA_R;
          if (s.x[i] + R > z[0] && s.x[i] - R < z[2] && s.y[i] + R > z[1] && s.y[i] - R < z[3]) { inZone = true; sides[si].inside++; }
        }
        if (!inZone) { s.entering[i] = 0; s.wall[i] = 1; crossed = true; }
      }
      if (crossed && this.selectable.indexOf(s) < 0 && this.emerging.indexOf(s) >= 0) {
        var off = 0;
        for (i = 0; i < s.n; i++) if (!s.wall[i]) off++;
        if (off > s.n / 2) this._selectable(s);
      }
    }
    // 兜底：入场过程中发生合并的产物，首次更新时可能已有一半以上膜点在墙内，
    // 永远不满足上面的 off>n/2“首个点进入”早转条件。一旦所有膜点都已进场
    // （不再穿墙），就必须从 emerging 转为 selectable，否则会永久卡在入场状态。
    // 倒序遍历：_selectable 会把球从 emerging 数组移除。
    for (var e = this.emerging.length - 1; e >= 0; e--) {
      if (!this._inEntrance(this.emerging[e])) this._selectable(this.emerging[e]);
    }
  };

  /* At most one merge per tick: the lowest eligible contact (spec 6). */
  Classic.prototype._merges = function () {
    var pairs = this.world.pairs, best = null;
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (p.a.dead || p.b.dead) continue;
      if (p.a.flash > 0 || p.b.flash > 0 || !p.a.allowMerges || !p.b.allowMerges) continue;
      // 最高等级球仍正常碰撞、参与判负，但不再向上升级（无更大物理体数据）。
      if (p.a.tier >= MAX_TIER) continue;
      if (!best || p.y > best.y) best = p;
    }
    if (!best) return;
    var A = best.a, B = best.b;
    var cx = (A.x[best.ia] + B.x[best.ib]) / 2, cy = (A.y[best.ia] + B.y[best.ib]) / 2;
    var eitherOnBar = this.onBar(A) || this.onBar(B);
    var N = this.world.merge(A, B, best.ia, best.ib);
    if (!N) return;   // 底层越界保护：最高等级不创建更大球
    this.world.shock(cx, cy, A.data.outerArea / 20000);
    if (this.aim && (this.aim.sobo === A || this.aim.sobo === B)) this.aim.sobo = N;
    if (this.hovered === A || this.hovered === B) this.hovered = N;
    this._dropRoles(A); this._dropRoles(B);
    // 合并产物若仍有膜点在墙外，按入场球处理（emerging，暂不允许再合并），
    // 由 _reenable 随入场自然恢复墙并转为可选；不被墙强行推回而跳变。
    if (this._inEntrance(N)) this._emerging(N);
    else if (eitherOnBar) this._selectable(N);
    else this._stack(N);
    // Unlock bigger spawns after enough merges into a tier (spec 7.2).
    var t = N.tier, L = this.layout;
    if (t < L.unlock.length && this.pool.indexOf(t) < 0) {
      this.mergeCounts[t] = (this.mergeCounts[t] || 0) + 1;
      if (this.mergeCounts[t] >= L.unlock[t]) { this.pool.push(t); this.pool.sort(function (a, b) { return a - b; }); }
    }
    if (N.value > this.biggest) this.biggest = N.value;
    this._emit('merge', A, B, N, cx, cy);
    var sc = this.calcScore();
    if (sc !== this.score) {
      var gain = sc - this.score;
      this.score = sc;
      this._emit('gain', gain, cx, cy);
    }
  };

  /* Score = sum of values of merge-made sobos alive (spec 11). */
  Classic.prototype.calcScore = function () {
    var sum = 0, all = this.world.sobos;
    for (var i = 0; i < all.length; i++) if (all[i].merged) sum += all[i].value;
    return Math.max(sum, this.score);
  };

  /* Each side looks along the bar line for the nearest suba (spec 7.1). */
  Classic.prototype._rays = function () {
    var w = this.world, y = this.layout.barY, self = this;
    for (var i = 0; i < this.sides.length; i++) {
      var sd = this.sides[i], d = sd.def, dir = i === 0 ? 1 : -1;
      var hit = w.rayX(y, d.spawnX, dir, d.rayLen, null);
      var bar = w.rayX(y, d.spawnX, dir, d.rayLen, function (s) { return self.onBar(s); });
      sd.rayHit = hit; sd.barHit = bar;
      sd.rayDist = hit ? hit.dist : Infinity;
      sd.canSpawn = sd.inside === 0 && !(hit && hit.dist < d.detect);
      // Portal: where an entering sobo crosses this side's wall.
      sd.portal = null;
      for (var k = 0; k < this.emerging.length; k++) {
        var s = this.emerging[k], lo = Infinity, hi = -Infinity;
        for (var j = 0; j < s.n; j++) {
          if (Math.abs(s.x[j] - d.wallX) < SB.SUBA_R) { lo = Math.min(lo, s.y[j]); hi = Math.max(hi, s.y[j]); }
        }
        if (hi >= lo) sd.portal = [lo - SB.SUBA_R, hi + SB.SUBA_R];
      }
    }
  };

  Classic.prototype._spawning = function () {
    this.spawnDelay--;
    if (this.spawnDelay > 0) { if (!this._safetyCondition()) this.safetyT = 0; return; }
    var pref = this.sides[1 - this.lastSide], last = this.sides[this.lastSide];
    if (pref.canSpawn) this._spawn(pref, false);
    else if (last.canSpawn) this._spawn(last, false);
    if (this._safetyCondition()) {
      this.safetyT += TICK;
      if (this.safetyT >= SAFETY_TIME) {
        this._spawn(this.sides[0], true);
        this._spawn(this.sides[1], true);
        this._emit('safetySpawn');
      }
    } else this.safetyT = 0;
  };
  Classic.prototype._safetyCondition = function () {
    return !this.sides[0].canSpawn && !this.sides[1].canSpawn && this.emerging.length + this.selectable.length === 0;
  };

  Classic.prototype._spawn = function (side, safety) {
    this.lastSide = side.index;
    this.spawnDelay = TICKS_BETWEEN_SPAWNS;
    var exclude = [side.rayHit ? side.rayHit.sobo.tier : -1, side.barHit ? side.barHit.sobo.tier : -1];
    var choices = this.pool.filter(function (t) { return exclude.indexOf(t) < 0; });
    if (!choices.length) return null;
    var tier = choices[Math.floor(Math.random() * choices.length)];
    var d = side.def, y = this.layout.barY;
    var s = new SB.Sobo(tier, d.spawnX, y);
    s.setWalls(false);
    for (var i = 0; i < s.n; i++) s.entering[i] = 1;
    this.world.add(s);
    this._emerging(s);
    s.setVelocity(-Math.sign(d.spawnX) * SPAWN_SPEED, 0);
    if (safety) side.danger = 1; else side.flash = 1;
    if (s.value > this.biggest) this.biggest = s.value;
    this._emit('spawn', s, side.index, safety);
    return s;
  };

  /* Bumpers: fully pressed starts holding; holding lasts 0.5 s past the
   * last full press. Both holding at once ends the game (spec 10.3). */
  Classic.prototype._bumpers = function () {
    for (var i = 0; i < this.sides.length; i++) {
      var sd = this.sides[i], b = sd.bumper;
      sd.press = Math.abs(b.x - b.restX) / SB.PHYS.bumperTravel;
      if (sd.press >= 0.99) {
        sd.holdT = 0;
        if (!sd.holding) { sd.holding = true; this._emit('holdStart', i); }
      }
      if (sd.holding) {
        if (sd.holdT > HOLD_TIME) { sd.holding = false; sd.holdT = 0; this._emit('holdEnd', i); }
        else sd.holdT += TICK;
      }
    }
  };

  Classic.prototype._preGameOver = function () {
    this.state = 'pregameover';
    this.cancelAim(true);
    this.preT = 0;
    this.beam = 1;
    for (var i = 0; i < this.sides.length; i++) {
      var b = this.sides[i].bumper;
      b.locked = true; b.x = b.restX + b.dir * SB.PHYS.bumperTravel; b.vx = 0;
      this.sides[i].holding = false;
    }
    this._emit('preGameOver');
  };

  /* Number labels turn back upright on a spring after a merge spin. */
  Classic.prototype._labels = function () {
    var all = this.world.sobos;
    for (var i = 0; i < all.length; i++) {
      var s = all[i], A = s.data.outerArea;
      var acc = (100000 / A) * (0 - s.labelAng) - (60000 / A) * s.labelVel;
      s.labelVel += acc * TICK;
      s.labelAng += s.labelVel * TICK;
    }
  };

  /* ---------- input (spec 9) ---------- */
  Classic.prototype.closestSelectable = function (x, y, maxD) {
    var best = null, bd = maxD;
    for (var i = 0; i < this.selectable.length; i++) {
      var s = this.selectable[i], d = Math.hypot(s.cx - x, s.cy - y);
      if (d <= bd) { bd = d; best = s; }
    }
    return best;
  };

  Classic.prototype.pointerMove = function (x, y, device) {
    this.pointer = { x: x, y: y, device: device };
    if (this.aim) { this.aim.px = x; this.aim.py = y; }
  };

  /* Mouse hover follows the cursor every tick; touch has no hover. */
  Classic.prototype._aimTick = function () {
    var a = this.aim;
    if (!a) {
      this.hovered = this.pointer && this.pointer.device === 'mouse'
        ? this.closestSelectable(this.pointer.x, this.pointer.y, SELECT_RADIUS) : null;
      return;
    }
    if (a.sobo.dead) { this.aim = null; return; }
    this._updateAimVector();
    var len = Math.hypot(a.vx, a.vy);
    if (a.passed && len < 0.1 && Math.hypot(a.sobo.avx, a.sobo.avy) < 40) { this.cancelAim(); return; }
    if (len > 0.25) a.passed = true;
  };
  Classic.prototype._updateAimVector = function () {
    var a = this.aim, s = a.sobo;
    var tx = a.px + a.ox - s.cx, ty = a.py + a.oy - s.cy, d = Math.hypot(tx, ty);
    var m = Math.min(d, MAX_ARROW) / MAX_ARROW;
    a.vx = d > 1e-6 ? tx / d * m : 0; a.vy = d > 1e-6 ? ty / d * m : 0;
  };

  Classic.prototype.pointerDown = function (x, y, device) {
    this.pointerMove(x, y, device);
    if (this.state !== 'playing' || this.aim) return false;
    var s = device === 'mouse' && this.hovered ? this.hovered : this.closestSelectable(x, y, SELECT_RADIUS);
    if (!s) return false;
    this.aim = { sobo: s, ox: s.cx - x, oy: s.cy - y, px: x, py: y, vx: 0, vy: 0, passed: false, device: device };
    this._emit('select', s);
    return true;
  };

  Classic.prototype.pointerUp = function () {
    var a = this.aim;
    if (!a) return;
    this.aim = null;
    if (this.state !== 'playing' || a.sobo.dead) return;
    this._updateAimVectorFor(a);
    this.launch(a.sobo, a.vx, a.vy);
    this.hovered = a.device === 'mouse' && this.pointer ? this.closestSelectable(a.sobo.cx, a.sobo.cy, 512) : null;
  };
  Classic.prototype._updateAimVectorFor = function (a) {
    var keep = this.aim; this.aim = a; this._updateAimVector(); this.aim = keep;
  };

  Classic.prototype.cancelAim = function (silent) {
    if (!this.aim) return;
    this.aim = null;
    if (!silent) this._emit('cancel');
  };

  Classic.prototype.launch = function (s, vx, vy) {
    this._stack(s);
    // 球一旦被发射进水缸就是正式的堆内球，必须恢复合并资格。
    // 否则入场中合并产生、还在 emerging（allowMerges=false）的球被瞄准发射后，
    // 会永久禁止合并。冷却由 flash 控制，与此处资格无关。
    s.allowMerges = true;
    s.addVelocity(vx * MAX_LAUNCH, vy * MAX_LAUNCH);
    this._emit('launch', s, vx, vy);
  };

  /* ---------- save and restore (spec 15.1) ---------- */
  function r1(v) { return Math.round(v * 10) / 10; }
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function nonneg(v) { return finite(v) && v >= 0; }
  Classic.prototype.capture = function () {
    var self = this;
    function sobo(s) {
      var pts = [];
      for (var i = 0; i < s.n; i++) pts.push(r1(s.x[i]), r1(s.y[i]), r1(s.vx[i]), r1(s.vy[i]), s.wall[i] | (s.entering[i] << 1));
      return { t: s.tier, m: s.merged ? 1 : 0, f: r1(s.flash), b: [r1(s.bx), r1(s.by), r1(s.bvx), r1(s.bvy)], p: pts };
    }
    return {
      v: 3, layout: this.layoutName, score: this.score, biggest: this.biggest,
      lastSide: this.lastSide, spawnDelay: this.spawnDelay, safetyT: this.safetyT,
      pool: this.pool.slice(), mergeCounts: JSON.parse(JSON.stringify(this.mergeCounts)),
      bumpers: this.sides.map(function (sd) { return [r1(sd.bumper.x), r1(sd.bumper.vx), sd.holding ? 1 : 0, sd.holdT]; }),
      emerging: this.emerging.map(sobo), selectable: this.selectable.map(sobo), stack: this.stack.map(sobo)
    };
  };

  /* 按存档固定顺序（emerging → selectable → stack）返回全部球，
   * 供成就追踪器把球对象引用映射为稳定序号；恢复后顺序保持一致。 */
  Classic.prototype.allSobos = function () {
    return this.emerging.concat(this.selectable).concat(this.stack);
  };

  /* 完整解析并校验存档，但不修改当前世界（原子性）。任一不合法即返回 null，
   * 不抛未处理异常、不静默跳过损坏球。全部合法后调用方再 reset 并一次提交。 */
  Classic.prototype._parseSave = function (st) {
    if (!st || typeof st !== 'object') return null;
    if (st.v !== 3 || st.layout !== this.layoutName) return null;
    if (!nonneg(st.score) || !nonneg(st.biggest)) return null;
    if (st.lastSide !== 0 && st.lastSide !== 1) return null;
    if (!finite(st.spawnDelay) || !nonneg(st.safetyT)) return null;
    if (!Array.isArray(st.pool)) return null;
    var pool = [];
    for (var i = 0; i < st.pool.length; i++) {
      var t = st.pool[i];
      if (t !== (t | 0) || t < 0 || t > MAX_TIER || pool.indexOf(t) >= 0) return null;
      pool.push(t);
    }
    // 生成池必须非空且始终包含基础球 tier0；否则游戏将无法再生成任何球而卡死。
    if (pool.length === 0 || pool.indexOf(0) < 0) return null;
    if (!Array.isArray(st.bumpers) || st.bumpers.length !== 2) return null;
    var bumpers = [];
    for (i = 0; i < 2; i++) {
      var b = st.bumpers[i];
      if (!Array.isArray(b) || b.length !== 4) return null;
      if (!finite(b[0]) || !finite(b[1]) || !finite(b[3])) return null;
      if (b[2] !== 0 && b[2] !== 1) return null;
      bumpers.push([b[0], b[1], b[2], b[3]]);
    }
    var mergeCounts = (st.mergeCounts && typeof st.mergeCounts === 'object')
      ? JSON.parse(JSON.stringify(st.mergeCounts)) : {};
    function parseSobo(d) {
      if (!d || typeof d !== 'object') return null;
      if (d.t !== (d.t | 0) || d.t < 0 || d.t > MAX_TIER) return null;
      var s;
      try { s = new SB.Sobo(d.t, 0, 0); } catch (e) { return null; }
      if (!Array.isArray(d.p) || d.p.length !== s.n * 5) return null;
      for (var j = 0; j < s.n; j++) {
        var x = d.p[j * 5], y = d.p[j * 5 + 1], vx = d.p[j * 5 + 2], vy = d.p[j * 5 + 3], c = d.p[j * 5 + 4];
        if (!finite(x) || !finite(y) || !finite(vx) || !finite(vy)) return null;
        if (c !== (c | 0)) return null;
        s.x[j] = x; s.y[j] = y; s.vx[j] = vx; s.vy[j] = vy;
        s.wall[j] = c & 1; s.entering[j] = (c >> 1) & 1;
      }
      if (!Array.isArray(d.b) || d.b.length !== 4
        || !finite(d.b[0]) || !finite(d.b[1]) || !finite(d.b[2]) || !finite(d.b[3])) return null;
      s.bx = d.b[0]; s.by = d.b[1]; s.bvx = d.b[2]; s.bvy = d.b[3];
      if (!nonneg(d.f)) return null;
      s.merged = !!d.m;
      if (d.f > 0) { s.flash = d.f; s.flashT = s.data.flash * Math.sqrt(Math.max(0, 1 - d.f)); }
      return s;
    }
    function parseList(list) {
      if (!Array.isArray(list)) return null;
      var out = [];
      for (var k = 0; k < list.length; k++) {
        var s = parseSobo(list[k]);
        if (!s) return null;   // 损坏球绝不静默跳过：整体失败
        out.push(s);
      }
      return out;
    }
    var emerging = parseList(st.emerging);
    var selectable = parseList(st.selectable);
    var stack = parseList(st.stack);
    if (!emerging || !selectable || !stack) return null;
    return {
      score: st.score, biggest: st.biggest, lastSide: st.lastSide,
      spawnDelay: st.spawnDelay, safetyT: st.safetyT, pool: pool,
      mergeCounts: mergeCounts, bumpers: bumpers,
      emerging: emerging, selectable: selectable, stack: stack
    };
  };

  Classic.prototype.restore = function (st) {
    var parsed = this._parseSave(st);
    if (!parsed) return false;          // 校验失败：当前世界保持原样
    // 全部合法，一次提交：先 reset 再应用完整状态。
    var self = this;
    this.reset();
    this.score = parsed.score;
    this.biggest = parsed.biggest;
    this.lastSide = parsed.lastSide;
    this.spawnDelay = parsed.spawnDelay;
    this.safetyT = parsed.safetyT;
    this.pool = parsed.pool;
    this.mergeCounts = parsed.mergeCounts;
    parsed.bumpers.forEach(function (b, i) {
      var sd = self.sides[i];
      sd.bumper.x = b[0]; sd.bumper.vx = b[1]; sd.holding = !!b[2]; sd.holdT = b[3];
    });
    parsed.emerging.forEach(function (s) { self.world.add(s); self.emerging.push(s); s.onBar = true; s.allowMerges = false; });
    parsed.selectable.forEach(function (s) { self.world.add(s); self.selectable.push(s); s.onBar = true; });
    parsed.stack.forEach(function (s) { self.world.add(s); self.stack.push(s); });
    return true;
  };
})(window.SB = window.SB || {});
