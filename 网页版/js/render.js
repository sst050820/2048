/*
 * Camera and canvas drawing for classic mode, following the original's
 * look (docs/original-spec.md, sections 3.3, 5.5, 9.5, 10.4 and 14.1).
 * Draw order matches the original's z order: background, bumpers, the
 * out-of-bounds mask and frame, markers, outlines, sobos and labels,
 * the danger beam, gauges, portals, the aim arrow, then the HUD.
 */
(function (SB) {
  'use strict';

  var GAP = 2;                 // style collider_gap
  var LINE_W = SB.SUBA_R * 2 - GAP * 2 - 0.5;
  var NUM_FONT = "'Souba Score', 'Audiowide', monospace";
  var TEXT_FONT = "'Souba Text', 'Nunito', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, sans-serif";
  var TAU = Math.PI * 2;

  function hexRgb(h) {
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    var x = hexRgb(a), y = hexRgb(b), out = '#';
    for (var i = 0; i < 3; i++) out += (256 + Math.round(x[i] + (y[i] - x[i]) * t)).toString(16).slice(1);
    return out;
  }
  function rgba(h, a) { var c = hexRgb(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  SB.mix = mix; SB.rgba = rgba;

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { w: 1, h: 1, dpr: 1, u: 1, inset: [0, 0, 0, 0], desktop: false, wide: false, play: { x: 0, y: 0, w: 1, h: 1 } };
    this.cam = { x: 0, y: 0, vx: 0, vy: 0, rot: 0, av: 0, zoom: 1, zv: 0, vib: 0, ox: 0, oy: 0 };
    this.fitZoom = 1; this.fitX = 0; this.fitY = 0;
    this.negative = 0;       // inverted-colour flash (game start, loss)
    this.whiteFlash = 0;
    this.settings = { push: 1, shake: 1 };
    this.gains = [];         // floating "+N" in the right panel (desktop)
    this.shownScore = 0;
  }
  SB.Renderer = Renderer;

  /* Screen layout: on a landscape screen the side panels flank the field
   * (desktop layout); on portrait a top panel holds the score and a thin
   * bottom panel sits under the field (mobile layout). */
  Renderer.prototype.resize = function (w, h, dpr, inset, layoutName) {
    var v = this.view;
    v.w = w; v.h = h; v.dpr = dpr; v.inset = inset;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    var aw = w - inset[1] - inset[3], ah = h - inset[0] - inset[2];
    var P = SB.LAYOUTS[layoutName].play;
    var worldW = P.x1 - P.x0, worldH = P.y1 - P.y0;
    v.layoutName = layoutName;
    v.desktop = layoutName === 'desktop';

    // desktop 物理布局仅在“宽屏 + 两侧余量足以容纳侧栏”时使用两侧 HUD。
    if (v.desktop) {
      var zH = ah / worldH, fieldW = worldW * zH, sidePx = (aw - fieldW) / 2, minSide = 56 * zH;
      if (aw >= ah && sidePx >= minSide) {
        v.u = zH;
        v.play = { x: inset[3] + sidePx, y: inset[0], w: fieldW, h: ah };
        v.side = sidePx;
        v.wide = true;          // 侧栏 HUD
        return;
      }
    }

    // 竖屏 / 窄屏（含 desktop 局被旋转到竖屏）：固定顶部/底部面板，场地在
    // 可用区完整 fit（绝不超出屏幕），并在可用区内居中。
    v.side = 0;
    v.wide = false;             // 顶部面板 HUD（即使物理布局是 desktop）
    v.u = Math.min(aw / 512, ah / 720);
    var top = 128 * v.u, bottom = 48 * v.u;
    var availH = ah - top - bottom;
    var z = Math.min(aw / worldW, availH / worldH);
    var pw = worldW * z, ph = worldH * z;
    var y = top + (availH - ph) / 2;
    v.play = { x: inset[3] + (aw - pw) / 2, y: inset[0] + y, w: pw, h: ph };
    v.topPanel = { x: inset[3], y: inset[0], w: aw, h: top };
    v.bottomPanel = { x: inset[3], y: inset[0] + ah - bottom, w: aw, h: bottom };
  };

  Renderer.prototype.fit = function (mode) {
    var P = mode.layout.play, v = this.view;
    this.fitZoom = Math.min(v.play.w / (P.x1 - P.x0), v.play.h / (P.y1 - P.y0));
    this.fitX = (P.x0 + P.x1) / 2; this.fitY = (P.y0 + P.y1) / 2;
  };
  Renderer.prototype.snap = function () {
    var c = this.cam;
    c.x = this.fitX; c.y = this.fitY; c.vx = c.vy = 0; c.rot = 0; c.av = 0; c.zoom = 1; c.zv = 0; c.vib = 0;
  };
  /* New game "juice": zoomed in 3x and spinning, springing back (spec 3.3). */
  Renderer.prototype.startJuice = function () {
    this.snap();
    this.cam.zoom = 3; this.cam.av = Math.random() < 0.5 ? -20 : 20;
    this.negative = 1;
  };

  /* ---------- camera feel ---------- */
  Renderer.prototype.push = function (fx, fy, px, py) {
    var k = this.settings.push, c = this.cam;
    c.vx += fx * k; c.vy += fy * k;
    if (px !== undefined) c.av += ((px - c.x) * fy * k - (py - c.y) * fx * k) * 1e-5;
  };
  Renderer.prototype.pushZoom = function (f) { this.cam.zv += f * this.settings.push; };
  Renderer.prototype.vibrate = function (s) { this.cam.vib += s * this.settings.shake; };

  Renderer.prototype.update = function (dt, paused) {
    dt = Math.min(dt, 1 / 15);
    var c = this.cam;
    if (!paused) {
      c.vx += 150 * (this.fitX - c.x) * dt; c.vy += 150 * (this.fitY - c.y) * dt;
      c.vx -= 12 * c.vx * dt; c.vy -= 12 * c.vy * dt;
      c.x += c.vx * dt; c.y += c.vy * dt;
      var ad = Math.atan2(Math.sin(-c.rot), Math.cos(-c.rot));
      c.av += 150 * ad * dt; c.av -= 12 * c.av * dt; c.rot += c.av * dt;
      c.zv += 100 * (1 - c.zoom) * dt; c.zv -= 10 * c.zv * dt; c.zoom += c.zv * dt;
      c.vib -= c.vib * 8 * dt;
      var a = Math.random() * TAU;
      c.ox = Math.cos(a) * c.vib; c.oy = Math.sin(a) * c.vib;
    }
    this.negative = Math.max(0, this.negative - 4 * dt);
    this.whiteFlash = Math.max(0, this.whiteFlash - this.whiteFlash * 0.5 * dt - 0.02 * dt);
    for (var i = this.gains.length - 1; i >= 0; i--) {
      var g = this.gains[i];
      g.a -= (i === 0 ? 4 : 2) * dt;
      if (g.a <= 0) this.gains.splice(i, 1);
    }
  };

  /* World to screen (CSS px). */
  Renderer.prototype.scale = function () { return this.fitZoom * this.cam.zoom; };
  Renderer.prototype.toScreen = function (x, y) {
    var c = this.cam, z = this.scale(), p = this.view.play;
    var dx = x - (c.x + c.ox), dy = y - (c.y + c.oy), cs = Math.cos(-c.rot), sn = Math.sin(-c.rot);
    return { x: p.x + p.w / 2 + (dx * cs - dy * sn) * z, y: p.y + p.h / 2 + (dx * sn + dy * cs) * z };
  };
  Renderer.prototype.toWorld = function (sx, sy) {
    var c = this.cam, z = this.scale(), p = this.view.play;
    var dx = (sx - p.x - p.w / 2) / z, dy = (sy - p.y - p.h / 2) / z, cs = Math.cos(c.rot), sn = Math.sin(c.rot);
    return { x: c.x + c.ox + dx * cs - dy * sn, y: c.y + c.oy + dx * sn + dy * cs };
  };
  Renderer.prototype._worldTransform = function () {
    var c = this.cam, z = this.scale(), d = this.view.dpr, p = this.view.play;
    var cs = Math.cos(-c.rot) * z * d, sn = Math.sin(-c.rot) * z * d;
    var tx = (p.x + p.w / 2) * d, ty = (p.y + p.h / 2) * d;
    var wx = c.x + c.ox, wy = c.y + c.oy;
    this.ctx.setTransform(cs, sn, -sn, cs, tx - (cs * wx - sn * wy), ty - (sn * wx + cs * wy));
  };

  /* ---------- drawing ---------- */
  Renderer.prototype.draw = function (mode, st, extra) {
    var ctx = this.ctx, v = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = st.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (mode) {
      this._worldTransform();
      this._bumpers(mode, st);
      this._outside(mode, st);
      this._markers(mode, st);
      this._outlines(mode, st);
      this._sobos(mode, st);
      this._beam(mode, st);
      this._gauges(mode, st);
      this._shocks(mode, st);
      if (mode.aim && mode.state === 'playing') this._arrow(mode, st, extra.device);
      if (extra.instructions) this._instructions(mode, st, extra);
    }
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    this._hud(mode, st, extra);
    if (this.negative > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = 'rgba(255,255,255,' + Math.min(1, this.negative) + ')';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (this.whiteFlash > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(255,255,255,' + Math.min(1, this.whiteFlash) + ')';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  };

  function fieldPath(ctx, pts, grow) {
    // The polygon pushed outward by `grow` along its corner bisectors.
    var n = pts.length, cx = 0, cy = 0, i;
    for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx /= n; cy /= n;
    ctx.beginPath();
    for (i = 0; i < n; i++) {
      var p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
      var n0 = edgeOut(p0, p1, cx, cy), n1 = edgeOut(p1, p2, cx, cy);
      var bx = n0[0] + n1[0], by = n0[1] + n1[1], bl = Math.hypot(bx, by);
      bx /= bl; by /= bl;
      var k = grow / (bx * n0[0] + by * n0[1]);
      var x = p1[0] + bx * k, y = p1[1] + by * k;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
  function edgeOut(a, b, cx, cy) {
    var ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey), nx = -ey / l, ny = ex / l;
    if ((cx - a[0]) * nx + (cy - a[1]) * ny > 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  }

  Renderer.prototype._bumpers = function (mode, st) {
    var ctx = this.ctx;
    for (var i = 0; i < mode.sides.length; i++) {
      var b = mode.sides[i].bumper;
      ctx.fillStyle = st.fill;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r - GAP - 1, 0, TAU); ctx.fill();
      ctx.strokeStyle = st.structure; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r - GAP - 4, 0, TAU); ctx.stroke();
    }
  };

  /* Everything outside the field in the out-of-bounds colour, then the frame. */
  Renderer.prototype._outside = function (mode, st) {
    var ctx = this.ctx, pts = mode.layout.field;
    ctx.beginPath();
    ctx.rect(-4000, -4000, 8000, 8000);
    fieldPathAppend(ctx, pts, GAP);
    ctx.fillStyle = st.oob;
    ctx.fill('evenodd');
    fieldPath(ctx, pts, GAP + 12);
    ctx.strokeStyle = st.structure;
    ctx.lineWidth = 24;
    ctx.lineJoin = 'miter';
    ctx.stroke();
  };
  function fieldPathAppend(ctx, pts, grow) {
    var n = pts.length, cx = 0, cy = 0, i;
    for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx /= n; cy /= n;
    for (i = 0; i < n; i++) {
      var p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
      var n0 = edgeOut(p0, p1, cx, cy), n1 = edgeOut(p1, p2, cx, cy);
      var bx = n0[0] + n1[0], by = n0[1] + n1[1], bl = Math.hypot(bx, by);
      bx /= bl; by /= bl;
      var k = grow / (bx * n0[0] + by * n0[1]);
      if (i) ctx.lineTo(p1[0] + bx * k, p1[1] + by * k); else ctx.moveTo(p1[0] + bx * k, p1[1] + by * k);
    }
    ctx.closePath();
  }

  /* Dots on the top wall under each selectable sobo. */
  Renderer.prototype._markers = function (mode, st) {
    var ctx = this.ctx, y = mode.layout.field[0][1];
    for (var i = 0; i < mode.selectable.length; i++) {
      var s = mode.selectable[i], r = 4, a = 0.5;
      if (mode.aim && mode.aim.sobo === s) { r = 8; a = 1; }
      else if (mode.hovered === s) { a = 1; }
      ctx.fillStyle = rgba(st.marker, a);
      ctx.beginPath(); ctx.arc(s.cx, y, r, 0, TAU); ctx.fill();
    }
  };

  function ringPath(ctx, s) {
    ctx.beginPath();
    ctx.moveTo(s.x[0], s.y[0]);
    for (var i = 1; i < s.n; i++) ctx.lineTo(s.x[i], s.y[i]);
    ctx.closePath();
  }

  Renderer.prototype._outlines = function (mode, st) {
    var ctx = this.ctx, s = null, th = 0;
    if (mode.aim && mode.state === 'playing') { s = mode.aim.sobo; th = 8; }
    else if (mode.hovered) { s = mode.hovered; th = 4; }
    if (!s || s.dead) return;
    ringPath(ctx, s);
    ctx.lineJoin = 'round';
    ctx.lineWidth = LINE_W + th * 2;
    ctx.strokeStyle = st.marker;
    ctx.stroke();
  };

  Renderer.prototype._sobos = function (mode, st) {
    var ctx = this.ctx, all = mode.world.sobos, pal = st.palette, i, s;
    // Dark well behind freshly merged sobos.
    for (i = 0; i < all.length; i++) {
      s = all[i];
      if (s.flash <= 0) continue;
      var inner = s.data.outerR * 0.5, outer = inner + 128;
      var g = ctx.createRadialGradient(s.cx, s.cy, inner, s.cx, s.cy, outer);
      g.addColorStop(0, 'rgba(0,0,0,' + (0.15 * s.flash) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.cx, s.cy, outer, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(s.cx, s.cy, inner, 0, TAU);
      ctx.fillStyle = 'rgba(0,0,0,' + (0.15 * s.flash) + ')'; ctx.fill();
    }
    ctx.lineJoin = 'round';
    ctx.lineWidth = LINE_W;
    for (i = 0; i < all.length; i++) {
      s = all[i];
      var col = pal[s.tier % pal.length];
      if (s.flash > 0) col = mix(col, '#ffffff', s.flash);
      ringPath(ctx, s);
      ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = col; ctx.stroke();
    }
    // Numbers: fixed 15 px, centred on the mass ball; faint until merged.
    ctx.font = '15px ' + NUM_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < all.length; i++) {
      s = all[i];
      var lc = s.flash > 0 ? mix(st.label, '#000000', s.flash) : st.label;
      ctx.fillStyle = rgba(lc, s.merged ? 1 : 0.4);
      ctx.save();
      ctx.translate(s.bx, s.by);
      ctx.rotate(s.labelAng);
      ctx.fillText(String(s.value), 0, 1);
      ctx.restore();
    }
  };

  /* Red band across the bumpers when the game is lost (spec 10.5). */
  Renderer.prototype._beam = function (mode, st) {
    if (mode.state === 'playing' || mode.beam <= 0.01) return;
    var ctx = this.ctx;
    ctx.fillStyle = rgba(st.danger, mode.beam);
    ctx.fillRect(-1024, -176, 2048, 128 * mode.beam);
  };

  function capLine(ctx, x0, y0, x1, y1, col, w) {
    ctx.strokeStyle = col; ctx.lineWidth = w || 8; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }

  Renderer.prototype._gauges = function (mode, st) {
    var ctx = this.ctx, top = mode.layout.field[0][1] - 12 - GAP, sides = mode.sides;
    for (var i = 0; i < sides.length; i++) {
      var sd = sides[i], d = sd.def, g = d.rayGauge, dir = g[1] > g[0] ? 1 : -1, len = Math.abs(g[1] - g[0]);
      // Ray gauge on the top frame: the free distance along the bar line.
      capLine(ctx, g[0], top, g[1], top, st.recess);
      var free = Math.max(0, Math.min(len, sd.rayDist - Math.abs(d.spawnX - d.wallX)));
      if (free > 0) capLine(ctx, g[0], top, g[0] + dir * free, top, st.fill);
      var safety = mode.safetyT / 3;
      if (safety > 0) capLine(ctx, g[0], top, g[0] + dir * len * Math.min(1, safety), top, st.special);
      if (sd.flash > 0) capLine(ctx, g[0], top, g[1], top, rgba('#ffffff', sd.flash));
      if (sd.danger > 0 && mode.state === 'playing' && !sd.holding) capLine(ctx, g[0], top, g[1], top, rgba(st.danger, sd.danger));
      // Bumper gauge in the side frame: fills from its middle as it is pushed.
      var x = d.dangerX + (i === 0 ? -GAP : GAP), cy = -112;
      capLine(ctx, x, cy - 64, x, cy + 64, st.recess);
      var p = Math.max(0.01, Math.min(1, sd.press)) * 64;
      capLine(ctx, x, cy - p, x, cy + p, st.fill);
      if (sd.holding || (sd.danger > 0 && mode.state === 'playing' && sd.press > 0.9)) {
        var a = sd.holding ? 1 : sd.danger;
        capLine(ctx, x, cy - 64, x, cy + 64, rgba(st.danger, a));
        var gl = ctx.createLinearGradient(x - 40, 0, x + 40, 0);
        gl.addColorStop(0, rgba(st.danger, 0)); gl.addColorStop(0.5, rgba(st.danger, 0.35 * a)); gl.addColorStop(1, rgba(st.danger, 0));
        ctx.fillStyle = gl; ctx.fillRect(x - 40, cy - 64, 80, 128);
      }
      // Portal: a white line where an entering sobo crosses the wall.
      if (sd.portal) capLine(ctx, d.wallX, sd.portal[0], d.wallX, sd.portal[1], '#ffffff');
    }
  };

  Renderer.prototype._shocks = function (mode, st) {
    var ctx = this.ctx, w = mode.world.shocks;
    if (!w.length) return;
    ctx.save();
    fieldPath(ctx, mode.layout.field, 0);
    ctx.clip();
    for (var i = 0; i < w.length; i++) {
      var s = w[i];
      ctx.strokeStyle = rgba(st.marker, Math.min(0.18, s.life * 0.25));
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  };

  /* Aim arrow (spec 9.3): thick for short pulls, thin for long ones. */
  Renderer.prototype._arrow = function (mode, st, device) {
    var ctx = this.ctx, a = mode.aim, s = a.sobo;
    var vx = a.vx * 220, vy = a.vy * 220, len = Math.hypot(vx, vy);
    var px = s.cx, py = s.cy, tx = px + vx, ty = py + vy;
    if (device === 'touch' && len > 0) { tx += vx / len * 32; ty += vy / len * 32; }
    var L = Math.hypot(tx - px, ty - py), th = Math.min(16, L > 0 ? 1400 / L : 16);
    ctx.fillStyle = st.marker; ctx.strokeStyle = st.marker;
    ctx.beginPath(); ctx.arc(px, py, 16, 0, TAU); ctx.fill();
    if (len < 0.5) return;
    ctx.lineCap = 'butt';
    ctx.lineWidth = th;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.beginPath(); ctx.arc(tx, ty, th / 2, 0, TAU); ctx.fill();
    var ang = (85 + (20 - 85) * Math.min(1, len / 220)) * Math.PI / 180;
    var hx = -vx * 0.25, hy = -vy * 0.25;
    for (var k = -1; k <= 1; k += 2) {
      var c = Math.cos(ang * k), sn = Math.sin(ang * k);
      var ex = tx + hx * c - hy * sn, ey = ty + hx * sn + hy * c;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath(); ctx.arc(ex, ey, th / 2, 0, TAU); ctx.fill();
    }
  };

  /* First games: how to launch, in the marker colour (spec 9.5). */
  Renderer.prototype._instructions = function (mode, st, extra) {
    var ctx = this.ctx, lines = extra.device === 'mouse'
      ? ['按住鼠标左键', '拖动瞄准', '松开发射', '右键取消发射']
      : ['按住并拖动以发射', '拖回中心可取消'];
    ctx.save();
    ctx.translate(0, 20);
    ctx.rotate(this.cam.rot);
    ctx.fillStyle = rgba(st.marker, 0.85);
    ctx.font = '22px ' + TEXT_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], 0, (i - (lines.length - 1) / 2) * 34);
    ctx.restore();
  };

  /* ---------- HUD (screen space, CSS px) ---------- */
  Renderer.prototype._hud = function (mode, st, extra) {
    var ctx = this.ctx, v = this.view, u = v.u;
    var score = mode ? mode.score : extra.best || 0;
    this.shownScore += (score - this.shownScore) * Math.min(1, extra.dt * 8);
    if (Math.abs(score - this.shownScore) < 0.5) this.shownScore = score;
    var txt = String(Math.round(this.shownScore));
    var ui = st.uiColors;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (extra.hidePanels) return;
    var showScore = !!mode && extra.inGame;
    if (v.wide) {
      var cy = v.inset[0] + (v.h - v.inset[0] - v.inset[2]) / 2;
      var lx = v.inset[3] + v.side * 0.5, rx = v.w - v.inset[1] - v.side * 0.5;
      ctx.save();
      ctx.translate(lx, cy); ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = ui.panel;
      ctx.font = Math.round(54 * u) + 'px ' + TEXT_FONT;
      ctx.fillText(extra.sideTitle || '凝合', 0, 0);
      ctx.restore();
      if (extra.menuIcon) this._burger(lx, v.inset[0] + 54 * u, 26 * u, ui.highlight);
      if (showScore) {
        ctx.save();
        ctx.translate(rx, cy); ctx.rotate(Math.PI / 2);
        ctx.fillStyle = ui.panelHover;
        ctx.font = Math.round(72 * u) + 'px ' + NUM_FONT;
        ctx.fillText(txt, 0, 0);
        ctx.restore();
        ctx.font = Math.round(30 * u) + 'px ' + NUM_FONT;
        for (var i = 0; i < this.gains.length; i++) {
          var g = this.gains[i];
          ctx.fillStyle = rgba(ui.panelHover, Math.min(1, g.a));
          ctx.save();
          ctx.translate(rx - 92 * u, v.inset[0] + (128 + i * 40) * u); ctx.rotate(Math.PI / 2);
          var gw = ctx.measureText(String(g.n)).width;
          ctx.fillText(String(g.n), 0, 0);
          ctx.font = Math.round(30 * u) + 'px ' + TEXT_FONT;
          ctx.fillText('+', -gw / 2 - 12 * u, 0);
          ctx.font = Math.round(30 * u) + 'px ' + NUM_FONT;
          ctx.restore();
        }
      }
    } else {
      var tp = v.topPanel;
      if (showScore) {
        ctx.fillStyle = ui.panelHover;
        ctx.font = Math.round(60 * u) + 'px ' + NUM_FONT;
        ctx.fillText(txt, tp.x + tp.w / 2, tp.y + tp.h * 0.55);
      }
      if (extra.menuIcon) this._burger(tp.x + 44 * u, tp.y + tp.h * 0.55, 26 * u, ui.highlight);
    }
  };
  Renderer.prototype._burger = function (x, y, w, col) {
    var ctx = this.ctx, h = w * 0.2;
    ctx.fillStyle = col;
    for (var i = -1; i <= 1; i++) {
      var yy = y + i * w * 0.36 - h / 2;
      ctx.beginPath();
      ctx.moveTo(x - w / 2 + h / 2, yy);
      ctx.arcTo(x + w / 2, yy, x + w / 2, yy + h, h / 2);
      ctx.arcTo(x + w / 2, yy + h, x - w / 2, yy + h, h / 2);
      ctx.arcTo(x - w / 2, yy + h, x - w / 2, yy, h / 2);
      ctx.arcTo(x - w / 2, yy, x + w / 2, yy, h / 2);
      ctx.fill();
    }
  };
  /* Where the menu button is, in CSS px, for hit testing. */
  Renderer.prototype.menuButton = function () {
    var v = this.view, u = v.u;
    if (v.wide) return { x: v.inset[3], y: v.inset[0], w: Math.max(v.side, 60 * u), h: v.h };
    return { x: v.topPanel.x, y: v.topPanel.y, w: 100 * u, h: v.topPanel.h };
  };
})(window.SB = window.SB || {});
