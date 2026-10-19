/*
 * Tiny WebAudio synth: every sound is generated, no audio files.
 * iOS only allows audio after a user gesture, so unlock() is called
 * from the first pointerdown.
 */
(function (SB) {
  'use strict';

  var ctx = null, master = null, muted = false;

  function ensure() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.55;
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  function tone(type, f0, f1, dur, vol, delay) {
    if (!ctx || muted) return;
    var t = ctx.currentTime + (delay || 0);
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(dur, freq, vol) {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(freq * 0.4, t + dur);
    f.Q.value = 1.2;
    var g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
  }

  SB.Audio = {
    unlock: function () {
      var c = ensure();
      if (c && c.state === 'suspended') c.resume();
    },
    setMuted: function (m) {
      muted = m;
      if (master) master.gain.value = m ? 0 : 0.55;
    },
    isMuted: function () { return muted; },
    launch: function (power) {
      noise(0.18 + power * 0.12, 900 + power * 900, 0.25 + power * 0.25);
      tone('triangle', 260, 520 + power * 300, 0.12, 0.12);
    },
    drop: function () { tone('sine', 420, 300, 0.1, 0.12); },
    // Pitch falls as the merged blob gets bigger.
    merge: function (level, combo) {
      var base = 880 * Math.pow(0.9, level);
      tone('sine', base * 1.8, base, 0.16, 0.35);
      tone('triangle', base * 2.4, base * 1.5, 0.1, 0.12, 0.02);
      if (combo > 1) tone('sine', base * 2 * (1 + combo * 0.12), base * 3, 0.12, 0.12, 0.06);
      if (level >= 9) tone('sine', base * 0.5, base * 0.25, 0.5, 0.3);
    },
    bump: function (strength) {
      tone('sine', 140 + strength * 40, 70, 0.08, Math.min(0.12, strength * 0.04));
    },
    warn: function () { tone('square', 520, 500, 0.07, 0.05); },
    over: function () {
      tone('triangle', 440, 220, 0.35, 0.2);
      tone('triangle', 330, 150, 0.5, 0.18, 0.25);
      tone('sine', 220, 90, 0.8, 0.2, 0.5);
    },
    click: function () { tone('sine', 700, 900, 0.05, 0.08); },
    award: function () {
      tone('triangle', 660, 660, 0.12, 0.14);
      tone('triangle', 880, 880, 0.12, 0.14, 0.1);
      tone('triangle', 1320, 1320, 0.25, 0.12, 0.2);
    }
  };
})(window.SB = window.SB || {});
