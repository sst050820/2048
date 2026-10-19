/*
 * The original's 30 achievements and the rules that unlock them
 * (docs/original-spec.md, section 13). Each unlocked achievement is worth
 * one colour-theme unlock token.
 */
(function (SB) {
  'use strict';

  var D = [
    ['score_0', '得分 0', '以恰好 0 分结束一局游戏。', 'exact', 0],
    ['score_10', '得分 10', '以恰好 10 分结束一局游戏。', 'exact', 10],
    ['score_100', '得分 100', '以恰好 100 分结束一局游戏。', 'exact', 100],
    ['score_1000', '得分 1000', '以恰好 1000 分结束一局游戏。', 'exact', 1000],
    ['8192', '8192', '拥有一个 8192 软球。', 'reach', 8192],
    ['bar_64', '浮条 64', '浮条上有一个 64 软球。', 'bar', 64],
    ['bar_128', '浮条 128', '浮条上有一个 128 软球。', 'bar', 128],
    ['bar_256', '浮条 256', '浮条上有一个 256 软球。', 'bar', 256],
    ['bar_512', '浮条 512', '浮条上有一个 512 软球。', 'bar', 512],
    ['air_32', '空合 32', '合成出 32 软球，且该球在 0.25 秒内不接触任何物体。', 'air', 32],
    ['air_64', '空合 64', '合成出 64 软球，且该球在 0.25 秒内不接触任何物体。', 'air', 64],
    ['air_128', '空合 128', '合成出 128 软球，且该球在 0.25 秒内不接触任何物体。', 'air', 128],
    ['air_256', '空合 256', '合成出 256 软球，且该球在 0.25 秒内不接触任何物体。', 'air', 256],
    ['clean_512', '孤立 512', '球堆里只剩一个 512 软球。', 'clean', 512],
    ['clean_1024', '孤立 1024', '球堆里只剩一个 1024 软球。', 'clean', 1024],
    ['clean_2048', '孤立 2048', '球堆里只剩一个 2048 软球。', 'clean', 2048],
    ['clean_4096', '孤立 4096', '球堆里只剩一个 4096 软球。', 'clean', 4096],
    ['6x_128', '6 个 128', '同时拥有 6 个 128 软球并保持 10 秒。', 'hold', 128, 6],
    ['5x_256', '5 个 256', '同时拥有 5 个 256 软球并保持 10 秒。', 'hold', 256, 5],
    ['4x_512', '4 个 512', '同时拥有 4 个 512 软球并保持 10 秒。', 'hold', 512, 4],
    ['3x_1024', '3 个 1024', '同时拥有 3 个 1024 软球并保持 10 秒。', 'hold', 1024, 3],
    ['121212', '121212', '不合成任何大于 2 的软球，让球堆里有 6 个软球并连续保持 10 秒。', 'nomerge', 2, 6],
    ['1212121212', '1212121212', '不合成任何大于 2 的软球，让球堆里有 10 个软球并连续保持 10 秒。', 'nomerge', 2, 10],
    ['chain_1_16', '从 1 连到 16', '不间断地从 1 连续合成到 16。', 'chain', 1, 16],
    ['chain_1_128', '从 1 连到 128', '不间断地从 1 连续合成到 128。', 'chain', 1, 128],
    ['chain_1_512', '从 1 连到 512', '不间断地从 1 连续合成到 512。', 'chain', 1, 512],
    ['chain_32_1024', '从 32 连到 1024', '不间断地从 32 连续合成到 1024。', 'chain', 32, 1024],
    ['chain_128_2048', '从 128 连到 2048', '不间断地从 128 连续合成到 2048。', 'chain', 128, 2048],
    ['chain_512_4096', '从 512 连到 4096', '不间断地从 512 连续合成到 4096。', 'chain', 512, 4096],
    ['suncle', '赞美太阳', '两个生成口都被堵住时触发安全生成。', 'event']
  ];
  var DEFS = D.map(function (d) { return { id: d[0], name: d[1], desc: d[2], kind: d[3], a: d[4], b: d[5] }; });
  var DEF_IDS = {};
  for (var di = 0; di < DEFS.length; di++) DEF_IDS[DEFS[di].id] = true;
  var HOLD = 10, AIR_TICKS = 15;
  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  function isPosNum(v) { return typeof v === 'number' && isFinite(v) && v > 0; }

  /* Watches one game. `unlock(id)` is called once per new achievement. */
  function Tracker(unlock) {
    this.unlock = unlock;
    this.reset();
  }
  Tracker.prototype.reset = function () {
    this.air = [];          // {sobo, ticks}
    this.holdT = {};        // def id -> seconds
    this.bigMerge = false;  // a merge produced a value above 2 this game
    this.chains = [];       // {start, head, value}
  };

  /* ---- 本局成就进度的存档与恢复（续玩不丢历史）---- */
  // sobos：mode.allSobos()，提供"球对象 → 稳定序号"的映射基准。
  Tracker.prototype.capture = function (sobos) {
    var idx = new Map();
    for (var i = 0; i < sobos.length; i++) idx.set(sobos[i], i);
    return {
      bigMerge: this.bigMerge,
      holdT: Object.assign({}, this.holdT),
      air: this.air.map(function (a) {
        var i = idx.get(a.sobo);
        return i === undefined ? null : { i: i, ticks: a.ticks };
      }).filter(Boolean),
      chains: this.chains.map(function (c) {
        var i = idx.get(c.head);
        // start 是 chain 定义的起始数字（如 1），直接存档。
        return i === undefined ? null : { start: c.start, head: i, value: c.value };
      }).filter(Boolean)
    };
  };
  // 严格校验后“整体提交”：先在局部变量里构造候选状态，任一字段非法即返回 false，
  // 且绝不半改当前追踪器（不 reset、不抛异常），由调用方决定是否放弃续玩。
  // 旧版本存档完全没有该字段（null/undefined）属于合法的保守兼容：假定已合成过 >2，
  // 避免续玩后错误解锁“不合成”类成就。
  Tracker.prototype.restore = function (data, sobos) {
    var bigMerge, holdT, air, chains;
    if (data === null || data === undefined) {
      bigMerge = true; holdT = {}; air = []; chains = [];
    } else {
      if (typeof data !== 'object' || Array.isArray(data)) return false;

      // bigMerge：明确布尔才尊重；字段缺失则无法确认历史，保守 true；其他类型非法。
      if (data.bigMerge === undefined) bigMerge = true;
      else if (typeof data.bigMerge === 'boolean') bigMerge = data.bigMerge;
      else return false;

      // holdT：纯对象，值必须是有限数字；只保留已知成就 id 的键。
      if (data.holdT === undefined) {
        holdT = {};
      } else if (typeof data.holdT !== 'object' || data.holdT === null || Array.isArray(data.holdT)) {
        return false;
      } else {
        holdT = {};
        for (var k in data.holdT) {
          if (!Object.prototype.hasOwnProperty.call(data.holdT, k)) continue;
          var hv = data.holdT[k];
          if (typeof hv !== 'number' || !isFinite(hv)) return false;
          if (DEF_IDS[k]) holdT[k] = hv;
        }
      }

      // air：数组，每项 {i: 球序号, ticks: 计数}，序号必须对应到实际球。
      if (data.air === undefined) {
        air = [];
      } else if (!Array.isArray(data.air)) {
        return false;
      } else {
        air = [];
        for (var ai = 0; ai < data.air.length; ai++) {
          var e = data.air[ai];
          if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
          if (!isInt(e.i) || e.i < 0 || e.i >= sobos.length || !sobos[e.i]) return false;
          if (!isInt(e.ticks) || e.ticks < 0 || e.ticks > AIR_TICKS) return false;
          air.push({ sobo: sobos[e.i], ticks: e.ticks });
        }
      }

      // chains：数组，每项 {start: 起始数字, head: 球序号, value: 当前值}。
      if (data.chains === undefined) {
        chains = [];
      } else if (!Array.isArray(data.chains)) {
        return false;
      } else {
        chains = [];
        for (var ci = 0; ci < data.chains.length; ci++) {
          var c = data.chains[ci];
          if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
          if (!isPosNum(c.start) || !isPosNum(c.value)) return false;
          if (!isInt(c.head) || c.head < 0 || c.head >= sobos.length || !sobos[c.head]) return false;
          chains.push({ start: c.start, head: sobos[c.head], value: c.value });
        }
      }
    }
    // 全部字段合法：一次性提交。
    this.air = air;
    this.holdT = holdT;
    this.bigMerge = bigMerge;
    this.chains = chains;
    return true;
  };
  Tracker.prototype._each = function (kind, fn) {
    for (var i = 0; i < DEFS.length; i++) if (DEFS[i].kind === kind) fn(DEFS[i]);
  };
  Tracker.prototype.created = function (s) {
    var self = this;
    this._each('reach', function (d) { if (s.value === d.a) self.unlock(d.id); });
  };
  Tracker.prototype.barJoin = function (s) {
    var self = this;
    this._each('bar', function (d) { if (s.value === d.a) self.unlock(d.id); });
  };
  Tracker.prototype.merge = function (A, B, N, onBar) {
    var self = this;
    this.created(N);
    if (N.value > 2) this.bigMerge = true;
    if (!onBar) this.air.push({ sobo: N, ticks: 0 });
    // Lineages: continue a chain whose head was consumed, start new ones.
    var next = [];
    for (var i = 0; i < this.chains.length; i++) {
      var c = this.chains[i];
      if (c.head === A || c.head === B) { c.head = N; c.value = N.value; next.push(c); }
      else if (!c.head.dead) next.push(c);
    }
    this._each('chain', function (d) {
      if (N.value === d.a * 2 && !next.some(function (c) { return c.start === d.a && c.head === N; })) {
        next.push({ start: d.a, head: N, value: N.value });
      }
    });
    this.chains = next;
    this._each('chain', function (d) {
      for (var k = 0; k < next.length; k++) if (next[k].start === d.a && next[k].value === d.b) self.unlock(d.id);
    });
  };
  Tracker.prototype.launch = function () { this.chains = []; };
  Tracker.prototype.safetySpawn = function () { this.unlock('suncle'); };
  Tracker.prototype.gameOver = function (score) {
    var self = this;
    this._each('exact', function (d) { if (score === d.a) self.unlock(d.id); });
  };
  /* Once per physics tick while playing. */
  Tracker.prototype.tick = function (mode, dt) {
    var self = this, all = mode.world.sobos, i;
    for (i = this.air.length - 1; i >= 0; i--) {
      var a = this.air[i];
      if (a.sobo.dead || mode.onBar(a.sobo) || a.sobo.touched) { this.air.splice(i, 1); continue; }
      if (++a.ticks >= AIR_TICKS) {
        this.air.splice(i, 1);
        this._each('air', function (d) { if (a.sobo.value === d.a) self.unlock(d.id); });
      }
    }
    if (mode.stack.length === 1) {
      var lone = mode.stack[0];
      this._each('clean', function (d) { if (lone.value === d.a) self.unlock(d.id); });
    }
    var counts = {};
    for (i = 0; i < all.length; i++) counts[all[i].value] = (counts[all[i].value] || 0) + 1;
    this._each('hold', function (d) { self._hold(d, (counts[d.a] || 0) >= d.b, dt); });
    this._each('nomerge', function (d) { self._hold(d, !self.bigMerge && mode.stack.length >= d.b, dt); });
  };
  Tracker.prototype._hold = function (d, ok, dt) {
    if (!ok) { this.holdT[d.id] = 0; return; }
    this.holdT[d.id] = (this.holdT[d.id] || 0) + dt;
    if (this.holdT[d.id] >= HOLD) this.unlock(d.id);
  };

  SB.Achievements = { DEFS: DEFS, Tracker: Tracker };
})(window.SB = window.SB || {});
