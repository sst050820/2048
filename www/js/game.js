/*
 * Soboscuba app shell: storage, settings, colour themes, menus,
 * achievements, save and resume, input and the main loop. The rules live
 * in mode.js, the physics in physics.js and all drawing in render.js.
 */
(function (SB) {
  'use strict';

  var Audio = SB.Audio;
  var TICK = SB.PHYS.tick;
  var SAVE_EVERY = 4;
  var TEACH_LAUNCHES = 4;
  var DEFAULT_STYLE = 'dark_mode';
  var LIGHT_STYLE = 'light_mode';

  var canvas = document.getElementById('game');
  var R = new SB.Renderer(canvas);
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- storage (may throw in private mode / sandboxes) ---------- */
  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('soboscuba.' + k); return v == null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem('soboscuba.' + k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem('soboscuba.' + k); } catch (e) {} }
  };
  // Saves and awards from the earlier rules no longer apply.
  store.del('session'); store.del('awards');

  var best = store.get('best', 0);
  var hapticsOn = store.get('haptics', true);
  var taught = store.get('taught', { mouse: 0, touch: 0 });
  Audio.setMuted(store.get('muted', false));

  /* ---------- colour themes ---------- */
  var STYLE = {};
  SB.STYLES.forEach(function (s) { STYLE[s.id] = s; });
  var styleUnlocks = store.get('styleUnlocks', []).filter(function (id) { return STYLE[id] && !STYLE[id].free; });
  var achieved = store.get('achievements', {});
  var A_DEFS = SB.Achievements.DEFS;

  function achCount() { return A_DEFS.filter(function (a) { return achieved[a.id]; }).length; }
  function tokens() { return achCount() - styleUnlocks.length; }
  function styleOpen(id) { return STYLE[id].free || styleUnlocks.indexOf(id) >= 0; }

  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function luma(h) { var c = hexRgb(h); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255; }
  // sRGB 相对亮度（WCAG 定义）。
  function relLum(h) {
    var c = hexRgb(h);
    var v = [c[0] / 255, c[1] / 255, c[2] / 255].map(function (x) {
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  // 两种颜色的 WCAG 对比度（1~21）。
  function contrast(h1, h2) {
    var L1 = relLum(h1), L2 = relLum(h2);
    var hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return (hi + 0.05) / (lo + 0.05);
  }
  var INK_DARK = '#000000', INK_LIGHT = '#ffffff';
  // 主按钮（accent 底）上的前景字色：按真实 WCAG 对比度选深/浅，
  // 已用纯黑/纯白作为候选，保证 28 个主题主按钮文字均 ≥4.5:1。
  function inkFor(accent) {
    var cd = contrast(accent, INK_DARK), cl = contrast(accent, INK_LIGHT);
    return cd >= cl ? INK_DARK : INK_LIGHT;
  }
  // 半透明前景 fg（alpha=a）叠在不透明背景 bg 上的合成颜色（hex）。
  function overHex(fg, a, bg) {
    var x = hexRgb(fg), y = hexRgb(bg);
    var c = [0, 1, 2].map(function (i) { return Math.round(x[i] * a + y[i] * (1 - a)); });
    return '#' + c.map(function (v) { return (v + 256).toString(16).slice(1); }).join('');
  }
  // 在背景 bg 上把文字色 c 调到对比度≥target：保持原色相，朝对比更高的极（黑/白）做最小混合。
  function ensureContrast(c, bg, target) {
    if (contrast(c, bg) >= target) return c;
    var goal = contrast(INK_DARK, bg) >= contrast(INK_LIGHT, bg) ? INK_DARK : INK_LIGHT;
    var lo = 0, hi = 1;
    for (var i = 0; i < 24; i++) {
      var mid = (lo + hi) / 2;
      if (contrast(SB.mix(c, goal, mid), bg) >= target) hi = mid; else lo = mid;
    }
    return SB.mix(c, goal, hi);
  }
  // 主按钮 hover 背景：朝与文字相反的方向微调（深字提亮、浅字压暗），保证 hover 态文字仍 ≥4.5:1。
  function primaryHoverFor(coral, ink) {
    var goal = ink === INK_DARK ? INK_LIGHT : INK_DARK;
    var at = function (t) { return SB.mix(coral, goal, t); };
    if (contrast(at(0.15), ink) >= 4.5) return at(0.15);
    var lo = 0.15, hi = 0.9;
    for (var i = 0; i < 24; i++) {
      var mid = (lo + hi) / 2;
      if (contrast(at(mid), ink) >= 4.5) hi = mid; else lo = mid;
    }
    return at(hi);
  }

  var st = null;
  function applyStyle(id) {
    var def = STYLE[id] && styleOpen(id) ? STYLE[id] : STYLE[DEFAULT_STYLE];
    st = {};
    for (var k in def) st[k] = def[k];
    st.uiColors = {};
    SB.UI_KEYS.forEach(function (key, i) { st.uiColors[key] = def.ui[i]; });
    var ui = st.uiColors, accent = def.special;
    var root = document.documentElement.style;
    root.setProperty('--sea', def.bg);
    root.setProperty('--glass', ui.background);
    root.setProperty('--card-edge', ui.backgroundHover);
    root.setProperty('--foam', ui.highlightHover);
    root.setProperty('--mist', ui.highlight);
    root.setProperty('--coral', accent);
    root.setProperty('--coral-deep', SB.mix(accent, '#000000', 0.35));
    var ink = inkFor(accent);
    root.setProperty('--ink', ink);
    // 主按钮 hover 背景按当前主题文字色反向微调，保证 hover 态文字仍达 4.5:1。
    root.setProperty('--coral-hover', primaryHoverFor(accent, ink));
    root.setProperty('--hot', def.danger);
    // 危险/红色底上的标记（成就对勾）独立选前景，不沿用按 accent 选的 --ink。
    root.setProperty('--mark-ink', inkFor(def.danger));
    // 普通/quiet 按钮透明背景透出卡片 --glass，hover 与计数胶囊再在其上叠 6%/14% 的 --foam。
    // 以最亮的胶囊背景为基准，把按钮文字在保持色相的前提下调到 WCAG 4.5:1。
    var glass = ui.background, foam = ui.highlightHover, mist = ui.highlight;
    var hoverTint = overHex(foam, 0.06, glass), pillTint = overHex(foam, 0.14, glass);
    root.setProperty('--btn-ink', ensureContrast(foam, hoverTint, 4.5));
    root.setProperty('--btn-quiet-ink', ensureContrast(mist, pillTint, 4.5));
    document.documentElement.style.colorScheme = def.light ? 'light' : 'dark';
    var logo = document.querySelectorAll('#logo span');
    // 中文“凝合”两字：取调色板中段冷色（凝=青）与偏暖色（合=粉），形成冷暖对比；
    // 其余字数仍沿用原顺序逐色，且随主题切换而变色。
    for (var j = 0; j < logo.length; j++) {
      var logoIdx = logo.length === 2
        ? (j === 0 ? Math.floor(def.palette.length / 2) : Math.floor(def.palette.length * 0.3))
        : (j % def.palette.length);
      logo[j].style.setProperty('--c', def.palette[logoIdx]);
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', def.bg);
    return def.id;
  }
  var styleId = applyStyle(store.get('style', DEFAULT_STYLE));

  function setStyle(id) {
    if (!STYLE[id]) return false;
    if (!styleOpen(id)) {
      if (tokens() <= 0) return false;
      styleUnlocks.push(id);
      store.set('styleUnlocks', styleUnlocks);
    }
    styleId = applyStyle(id);
    store.set('style', styleId);
    return true;
  }
  function cycleStyle() {
    var open = SB.STYLES.filter(function (s) { return styleOpen(s.id); });
    var i = open.findIndex(function (s) { return s.id === styleId; });
    setStyle(open[(i + 1) % open.length].id);
  }

  /* ---------- feedback ---------- */
  var lastHaptic = 0;
  function haptic(strength) {
    if (!hapticsOn || strength <= 0) return;
    var now = performance.now();
    if (now - lastHaptic < 40 && strength < 0.9) return;
    lastHaptic = now;
    try {
      var H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
      if (H) H.impact({ style: strength >= 0.7 ? 'HEAVY' : strength >= 0.3 ? 'MEDIUM' : 'LIGHT' });
      else if (navigator.vibrate) navigator.vibrate(Math.round(6 + strength * 30));
    } catch (e) {}
  }

  var toastQueue = [], toastBusy = false;
  // Desktop: low in the score panel, clear of the +points list. Phone: over the score panel.
  function placeToast() {
    var t = $('toast'), v = R.view;
    if (v.wide && v.side >= 220) {
      t.style.left = (v.play.x + v.play.w + 16) + 'px';
      t.style.width = (v.side - 32) + 'px';
      t.style.top = 'auto';
      t.style.bottom = (v.inset[2] + 16) + 'px';
      t.style.setProperty('--toast-x', '0px');
    } else {
      t.style.left = '50%';
      t.style.width = '';
      t.style.top = (v.inset[0] + 8) + 'px';
      t.style.bottom = 'auto';
      t.style.setProperty('--toast-x', '-50%');
    }
  }
  function showToast() {
    if (toastBusy || !toastQueue.length) return;
    toastBusy = true;
    var a = toastQueue.shift(), el = $('toast');
    $('toast-name').textContent = a.name;
    $('toast-desc').textContent = a.desc;
    $('toast-extra').textContent = '获得一次主题解锁';
    $('toast-extra').hidden = false;
    placeToast();
    el.hidden = false;
    el.classList.remove('toast--out');
    Audio.award();
    setTimeout(function () { el.classList.add('toast--out'); }, 2600);
    setTimeout(function () { el.hidden = true; toastBusy = false; showToast(); }, 3000);
  }
  function unlock(id) {
    if (achieved[id] || app.screen === 'title') return;
    achieved[id] = Date.now();
    store.set('achievements', achieved);
    var a = A_DEFS.filter(function (x) { return x.id === id; })[0];
    toastQueue.push(a);
    showToast();
  }
  var tracker = new SB.Achievements.Tracker(unlock);

  /* ---------- game ---------- */
  var app = { screen: 'title', saveT: 0, device: matchMedia('(pointer: fine)').matches ? 'mouse' : 'touch', overScore: 0, dangerT: 0 };
  var mode = null;
  var lastArrow = 0;

  function layoutFor() { return window.innerWidth > window.innerHeight ? 'desktop' : 'mobile'; }

  var hooks = {
    spawn: function () { if (live()) Audio.drop(); },
    barJoin: function (s) { if (live()) tracker.barJoin(s); },
    merge: function (A, B, N, x, y) {
      if (!live()) return;
      var life = A.data.outerArea / 20000;
      Audio.merge(N.tier, 0);
      R.vibrate(N.data.outerArea * 0.0001);
      R.pushZoom(-life * 0.3);
      var dx = R.cam.x - x, dy = R.cam.y - y, d = Math.hypot(dx, dy) || 1;
      R.push(dx / d * life * 300, dy / d * life * 300);
      haptic(Math.min(1, life));
      tracker.merge(A, B, N, mode.onBar(N));
    },
    gain: function (n) { if (live()) R.gains.unshift({ n: n, a: 1 }); },
    select: function (s) { Audio.click(); haptic(0.5); lastArrow = 0; },
    cancel: function () { Audio.drop(); },
    launch: function (s, vx, vy) {
      var len = Math.hypot(vx, vy), m = s.data.totalMass;
      Audio.launch(len);
      haptic(0.25 + len * 0.5);
      if (len > 0) R.push(vx / len * 8 * m, vy / len * 8 * m, s.cx, s.cy);
      tracker.launch();
      if (len > 0.25 && taught[app.device] < TEACH_LAUNCHES) { taught[app.device]++; store.set('taught', taught); }
    },
    holdStart: function () { Audio.warn(); haptic(0.4); },
    safetySpawn: function () { if (live()) tracker.safetySpawn(); },
    preGameOver: function () {
      store.del('game');
      Audio.over();
      R.negative = 1;
      R.vibrate(20);
      haptic(1);
    },
    gameOver: function (score) {
      tracker.gameOver(score);
      app.newBest = score > best;
      if (app.newBest) { best = score; store.set('best', best); }
      showOver();
    }
  };
  function live() { return app.screen !== 'title'; }

  function newMode(layout) {
    mode = new SB.Classic(layout, hooks);
    R.resize(window.innerWidth, window.innerHeight, dpr(), insets(), mode.layoutName);
    R.fit(mode);
    tracker.reset();
    R.gains.length = 0;
    R.shownScore = 0;
  }

  function newGame() {
    newMode(layoutFor());
    R.startJuice();
    app.saveT = 0;
    setScreen('play');
  }

  function attract() {
    newMode(layoutFor());
    R.snap();
  }

  /* ---------- save / resume ---------- */
  function save() {
    if (!mode || app.screen === 'title' || mode.state !== 'playing') return;
    var data = mode.capture();
    data.taught = taught;
    data.tracker = tracker.capture(mode.allSobos());   // 保存本局成就进度
    store.set('game', data);
  }
  function resume() {
    var data = store.get('game', null);
    // 布局必须是 LAYOUTS 的自有键，拒绝 '__proto__'/'constructor' 等原型链名字。
    var layoutOk = data && typeof data.layout === 'string'
      && Object.prototype.hasOwnProperty.call(SB.LAYOUTS, data.layout);
    if (!data || data.v !== 3 || !layoutOk) return false;
    // 在候选模式上完整校验：不破坏当前局面、不删除存档。
    var candidate = new SB.Classic(data.layout, hooks);
    if (!candidate.restore(data)) return false;   // 存档损坏：保留存档、由 UI 提示
    // 成就追踪器同样先在候选模式上、用临时 Tracker 完整验证，不改动全局 tracker。
    var probe = new SB.Achievements.Tracker(function () {});
    if (!probe.restore(data.tracker, candidate.allSobos())) return false;
    // 模式与追踪器都合法：一次性切换并提交。
    mode = candidate;
    tracker.restore(data.tracker, mode.allSobos());
    R.resize(window.innerWidth, window.innerHeight, dpr(), insets(), candidate.layoutName);
    R.fit(candidate);
    R.gains.length = 0;
    R.shownScore = candidate.score;
    R.snap();
    app.saveT = 0;
    setScreen('play');
    return true;
  }

  /* ---------- menus ---------- */
  var overlays = { title: $('title'), paused: $('pause'), over: $('over') };
  function setScreen(s) {
    app.screen = s;
    overlays.title.hidden = s !== 'title';
    overlays.paused.hidden = s !== 'paused';
    overlays.over.hidden = s !== 'over';
    if (s === 'title') {
      $('btn-continue').hidden = !store.get('game', null);
      $('btn-play').textContent = $('btn-continue').hidden ? '开始游戏' : '新游戏';
      $('title-best').textContent = String(best);
      $('awards-count').textContent = achCount() + '/' + A_DEFS.length;
    }
    if (mode && s !== 'play') mode.cancelAim(true);
  }
  function pause() {
    if (app.screen !== 'play' || !mode || mode.state !== 'playing') return;
    setScreen('paused');
    save();
  }
  // Shrinks a number until it fits its box, so long scores never wrap.
  function setFit(el, text) {
    if (el.textContent === text && el.dataset.fit) return;
    el.textContent = text;
    el.style.fontSize = '';
    var avail = el.parentElement.clientWidth - 8, w = el.scrollWidth;
    if (w > avail) el.style.fontSize = (parseFloat(getComputedStyle(el).fontSize) * avail / w) + 'px';
    el.dataset.fit = '1';
  }
  function showOver() {
    app.overScore = 0;
    $('over-newbest').hidden = !app.newBest || mode.score === 0;
    setScreen('over');
    setFit($('over-score'), '0');
    setFit($('over-best'), String(best));
    setFit($('over-biggest'), String(mode.biggest));
    R.whiteFlash = 1;
  }

  function bind(id, fn) {
    $(id).addEventListener('click', function () { Audio.unlock(); Audio.click(); fn(); });
  }
  function syncToggles() {
    $('btn-sound').textContent = Audio.isMuted() ? '音效：关' : '音效：开';
    $('btn-haptics').textContent = hapticsOn ? '震动：开' : '震动：关';
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function openAwards() {
    var list = $('awards-list');
    list.textContent = '';
    A_DEFS.forEach(function (a) {
      var li = el('li', achieved[a.id] ? 'done' : '');
      li.appendChild(el('span', 'mark', achieved[a.id] ? '✓' : '?'));
      var txt = el('div');
      txt.appendChild(el('b', null, a.name));
      txt.appendChild(el('span', null, a.desc));
      li.appendChild(txt);
      list.appendChild(li);
    });
    $('awards-progress').textContent = '已解锁 ' + achCount() + ' / ' + A_DEFS.length;
    renderStyles();
    var ov = $('awards');
    ov.hidden = false;
    ov.scrollTop = 0;
    $('btn-awards-close').focus({ preventScroll: true });
  }
  function renderStyles() {
    var t = tokens();
    $('styles-tokens').textContent = '剩余 ' + t + ' 次主题解锁';
    var box = $('styles-list');
    box.textContent = '';
    SB.STYLES.forEach(function (s) {
      var open = styleOpen(s.id);
      var b = el('button', 'style-opt' + (open ? '' : ' style-opt--locked'));
      b.type = 'button';
      b.id = 'style-' + s.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(styleId === s.id));
      b.disabled = !open && t <= 0;
      b.style.setProperty('--sw-bg', s.bg);
      b.style.setProperty('--sw-edge', s.structure);
      var sw = el('span', 'swatches');
      [0, 1, 2, 3, 4, 5].forEach(function (k) {
        var i = el('i');
        i.style.background = s.palette[k % s.palette.length];
        sw.appendChild(i);
      });
      b.appendChild(sw);
      b.appendChild(el('b', null, s.name));
      if (!open) b.appendChild(el('small', null, t > 0 ? '点击解锁' : '未解锁'));
      b.addEventListener('click', function () {
        if (!setStyle(s.id)) return;
        Audio.click();
        renderStyles();
        $('style-' + s.id).focus({ preventScroll: true });
      });
      box.appendChild(b);
    });
  }
  function closeAwards() {
    $('awards').hidden = true;
    if (app.screen === 'title') $('awards-count').textContent = achCount() + '/' + A_DEFS.length;
  }

  bind('btn-play', newGame);
  bind('btn-continue', function () {
    if (!resume()) window.alert('存档已损坏或与当前版本不兼容，无法继续。\n原存档未被删除；你可以直接开始新游戏。');
  });
  bind('btn-resume', function () { setScreen('play'); });
  bind('btn-restart', newGame);
  bind('btn-home', function () { save(); attract(); setScreen('title'); });
  bind('btn-again', newGame);
  bind('btn-view', function () { setScreen('view'); });
  bind('btn-over-home', function () { attract(); setScreen('title'); });
  bind('btn-haptics', function () {
    hapticsOn = !hapticsOn;
    store.set('haptics', hapticsOn);
    syncToggles();
    haptic(0.5);
  });
  bind('btn-sound', function () {
    Audio.setMuted(!Audio.isMuted());
    store.set('muted', Audio.isMuted());
    syncToggles();
  });
  bind('btn-awards', openAwards);
  bind('btn-awards-pause', openAwards);
  bind('btn-awards-close', closeAwards);
  bind('btn-awards-x', closeAwards);
  syncToggles();

  var sideways = window.matchMedia('(orientation: landscape) and (max-height: 500px) and (pointer: coarse)');
  function onSideways() { if (sideways.matches) pause(); }
  if (sideways.addEventListener) sideways.addEventListener('change', onSideways);
  else if (sideways.addListener) sideways.addListener(onSideways);
  document.addEventListener('visibilitychange', function () { if (document.hidden) { pause(); save(); } });
  window.addEventListener('pagehide', save);

  /* ---------- view ---------- */
  var safeEl = $('safe');
  function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }
  function insets() {
    var cs = getComputedStyle(safeEl);
    return [parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingRight) || 0, parseFloat(cs.paddingBottom) || 0, parseFloat(cs.paddingLeft) || 0];
  }
  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    // A new layout only takes over between games; a running game keeps its own.
    if (mode && app.screen === 'title' && mode.layoutName !== layoutFor() && !mode.world.sobos.some(function (s) { return s.merged; })) attract();
    R.resize(w, h, dpr(), insets(), mode ? mode.layoutName : layoutFor());
    if (mode) R.fit(mode);
    if (!$('toast').hidden) placeToast();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 200); });

  /* ---------- input ---------- */
  var activePointer = null;
  function inMenuButton(e) {
    var b = R.menuButton();
    return e.clientX >= b.x && e.clientX <= b.x + b.w && e.clientY >= b.y && e.clientY <= b.y + b.h;
  }
  function worldAt(e) { return R.toWorld(e.clientX, e.clientY); }
  function deviceOf(e) { return e.pointerType === 'mouse' ? 'mouse' : 'touch'; }

  canvas.addEventListener('pointerdown', function (e) {
    Audio.unlock();
    app.device = deviceOf(e);
    if (app.screen === 'view') { setScreen('over'); return; }
    if (app.screen !== 'play' || !mode) return;
    if (e.button === 2) return;
    if (inMenuButton(e) && !mode.aim) { Audio.click(); pause(); return; }
    if (activePointer !== null) return;
    var p = worldAt(e);
    if (mode.pointerDown(p.x, p.y, app.device)) {
      activePointer = e.pointerId;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!mode || app.screen !== 'play') return;
    if (activePointer !== null && e.pointerId !== activePointer) return;
    // A right press while the left button aims arrives as a chorded
    // pointermove, never a pointerdown.
    if (e.button === 2 && (e.buttons & 2)) { mode.cancelAim(); return; }
    if (e.pointerType === 'mouse') app.device = 'mouse';
    var p = worldAt(e);
    mode.pointerMove(p.x, p.y, deviceOf(e));
    canvas.style.cursor = inMenuButton(e) ? 'pointer' : '';
  });
  canvas.addEventListener('pointerup', function (e) {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    if (mode && app.screen === 'play') mode.pointerUp();
  });
  canvas.addEventListener('pointercancel', function (e) {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    if (mode) mode.cancelAim(true);
  });
  canvas.addEventListener('pointerleave', function (e) {
    if (e.pointerType === 'mouse' && mode && activePointer === null) mode.pointer = null;
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('keydown', function (e) {
    var modal = !$('awards').hidden;   // 模态弹窗（成就与主题）是否打开
    if (e.key === 'Escape') {
      // 弹窗打开时，Escape 只关闭弹窗，保留打开前的 screen（暂停/标题），不改变暂停状态。
      if (modal) { closeAwards(); return; }
      if (app.screen === 'play') pause();
      else if (app.screen === 'paused') setScreen('play');
      else if (app.screen === 'view') setScreen('over');
      return;
    }
    if (e.key === 'p' || e.key === 'P') {
      // 弹窗打开时，P/p 绝不穿透成就页改变暂停状态；普通暂停页照常恢复。
      if (modal) return;
      if (app.screen === 'play') pause();
      else if (app.screen === 'paused') setScreen('play');
      return;
    }
    if (e.key === 'm' || e.key === 'M') { Audio.setMuted(!Audio.isMuted()); store.set('muted', Audio.isMuted()); syncToggles(); return; }
    if (e.key === 'k' || e.key === 'K') { cycleStyle(); if (modal) renderStyles(); return; }
    if (e.key === 'l' || e.key === 'L') { setStyle(styleId === LIGHT_STYLE ? DEFAULT_STYLE : LIGHT_STYLE); if (modal) renderStyles(); }
  });

  /* ---------- loop ---------- */
  function tick() {
    if (!mode) return;
    var playing = app.screen === 'play' || app.screen === 'title';
    if (!playing || mode.state !== 'playing') return;
    mode.tick();
    if (app.screen !== 'play') return;
    tracker.tick(mode, TICK);
    var a = mode.aim;
    if (a) {
      var m = a.sobo.data.totalMass, len = Math.hypot(a.vx, a.vy);
      if (len > 0) R.push(-a.vx / len * m, -a.vy / len * m, a.sobo.cx, a.sobo.cy);
      var px = len * 220;
      R.vibrate(px * 0.02 * TICK);
      if (Math.abs(px - lastArrow) > 10) { lastArrow = px; Audio.bump(0.4 + len); haptic(len * 0.3); }
    }
    if (mode.sides[0].holding || mode.sides[1].holding) {
      app.dangerT -= TICK;
      if (app.dangerT <= 0) { app.dangerT = 0.3; Audio.warn(); haptic(0.1); }
    } else app.dangerT = 0;
    app.saveT += TICK;
    if (app.saveT >= SAVE_EVERY) { app.saveT = 0; save(); }
  }

  var last = 0, acc = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    var t = ts / 1000;
    if (!last) last = t;
    var dt = Math.min(0.1, t - last);
    last = t;
    acc += dt;
    var steps = 0;
    while (acc >= TICK && steps < 4) { tick(); acc -= TICK; steps++; }
    if (steps >= 4) acc = 0;
    if (mode && (app.screen === 'play' || app.screen === 'title')) mode.frame(dt);
    R.update(dt, app.screen === 'paused');
    if (app.screen === 'over') {
      app.overScore += (mode.score - app.overScore) * Math.min(1, 2 * dt);
      if (mode.score - app.overScore < 0.5) app.overScore = mode.score;
      setFit($('over-score'), String(Math.round(app.overScore)));
    }
    var inGame = app.screen !== 'title';
    R.draw(mode, st, {
      dt: dt,
      device: app.device,
      inGame: inGame,
      menuIcon: app.screen === 'play',
      hidePanels: app.screen === 'over',
      instructions: app.screen === 'play' && mode && mode.state === 'playing' && taught[app.device] < TEACH_LAUNCHES,
      sideTitle: app.screen === 'over' || app.screen === 'view' || (mode && mode.state !== 'playing' && inGame) ? '游戏结束' : '凝合'
    });
  }

  resize();
  attract();
  setScreen('title');
  requestAnimationFrame(frame);
  if (document.fonts && document.fonts.load) {
    document.fonts.load('15px "Souba Score"').catch(function () {});
    document.fonts.load('22px "Souba Text"').catch(function () {});
  }

  // Hooks for automated tests.
  SB.game = {
    app: app, renderer: R, store: store, unlock: unlock, achieved: achieved, setStyle: setStyle,
    newGame: newGame, resume: resume, save: save, pause: pause,
    get mode() { return mode; }, get style() { return styleId; }, tokens: tokens
  };
})(window.SB = window.SB || {});
