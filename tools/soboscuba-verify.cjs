#!/usr/bin/env node
'use strict';

// Compare untouched Soboscuba runtimes in isolated VM contexts. No browser,
// packages, files outside --report, or physics-parameter changes are involved.
// Usage: node soboscuba-verify.cjs <reference www> <candidate www> [--report file]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const FILES = ['physics.js', 'mode.js', 'achievements.js', 'styles.js'];

// Run directly in a fresh Node global, like tests/node/harness.js. The VM
// comparisons below intentionally isolate RNG/state; their timing is separate.
if (process.argv[2] === '--benchmark-worker') {
  const root = path.resolve(process.argv[3]);
  const seed = Number(process.argv[4]);
  let randomState = seed;
  Math.random = () => (randomState = (randomState * 16807) % 2147483647) / 2147483647;
  global.window = global;
  for (const file of FILES) (0, eval)(fs.readFileSync(path.join(root, 'js', file), 'utf8'));
  const world = worldFor(global.SB), R = Math.random;
  for (let k = 0; k < 40; k++) {
    world.add(new global.SB.Sobo(Math.floor(R() * 5), -150 + R() * 300, -250 + (k % 8) * 60))
      .setVelocity((R() - 0.5) * 400, 0);
  }
  const elapsed = [];
  let peakRecoveries = 0;
  for (let step = 0; step < 1200; step++) {
    const begin = performance.now();
    world.step();
    elapsed.push(performance.now() - begin);
    peakRecoveries = Math.max(peakRecoveries, world.recoveries.length);
  }
  ensureFinite(world, `native benchmark ${seed} final`);
  console.log(JSON.stringify({ ...timings(elapsed), seed, sobos: world.sobos.length, subas: world.count, peakRecoveries, warmupTicks: 0 }));
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.length < 2 || args.includes('--help')) {
  console.log('Usage: node soboscuba-verify.cjs <reference www> <candidate www> [--report file]');
  process.exit(args.includes('--help') ? 0 : 2);
}
const reference = path.resolve(args[0]);
const candidate = path.resolve(args[1]);
const reportIndex = args.indexOf('--report');
const reportFile = reportIndex >= 0 ? path.resolve(args[reportIndex + 1] || '') : null;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

function loadRuntime(root, seed) {
  let state = seed;
  const math = Object.create(Math);
  math.random = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const sandbox = { Math: math };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) {
    const filename = path.join(root, 'js', f);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  }
  return { SB: sandbox.SB, random: math.random, randomState: () => state };
}

// Preserve every own field, typed-array element, Map entry, object reference,
// +/-Infinity and signed zero. capture() rounds to tenths, so it is unsuitable
// as a numerical-identity snapshot. This does not round or apply a tolerance.
function snapshot(root) {
  const seen = new Map();
  let numericValues = 0;
  function encode(value) {
    if (typeof value === 'number') {
      numericValues++;
      if (!Number.isFinite(value)) return { $number: String(value) };
      if (Object.is(value, -0)) return { $number: '-0' };
      return value;
    }
    if (value === undefined) return { $undefined: true };
    if (typeof value === 'function') return { $function: true };
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return { $ref: seen.get(value) };
    const id = seen.size;
    seen.set(value, id);
    if (ArrayBuffer.isView(value)) return { $id: id, $typed: value.constructor.name, data: Array.from(value, encode) };
    if (Object.prototype.toString.call(value) === '[object Map]') {
      return { $id: id, $map: Array.from(value, ([k, v]) => [encode(k), encode(v)]) };
    }
    if (Array.isArray(value)) return { $id: id, $array: value.map(encode) };
    const result = { $id: id };
    for (const key of Object.keys(value).sort()) result[key] = encode(value[key]);
    return result;
  }
  return { text: JSON.stringify(encode(root)), numericValues };
}

function worldFor(SB, layout = 'mobile') {
  const L = SB.LAYOUTS[layout];
  const world = new SB.World();
  world.setField(L.field);
  world.addBumper(L.sides[0].bumperX, -112, -1);
  world.addBumper(L.sides[1].bumperX, -112, 1);
  return world;
}

function ensureFinite(world, label) {
  for (const s of world.sobos) {
    for (const key of ['cx', 'cy', 'avx', 'avy', 'bx', 'by', 'bvx', 'bvy', 'area']) {
      if (!Number.isFinite(s[key])) throw new Error(`${label}: sobo ${s.id}.${key} is non-finite`);
    }
    for (const key of ['x', 'y', 'vx', 'vy', 'px', 'py', 'nx', 'ny', 'ax', 'ay']) {
      for (let i = 0; i < s[key].length; i++) {
        if (!Number.isFinite(s[key][i])) throw new Error(`${label}: sobo ${s.id}.${key}[${i}] is non-finite`);
      }
    }
  }
}

const SCENARIOS = [];
function scenario(name, seed, steps, setup, advance) {
  SCENARIOS.push({ name, seed, steps, setup, advance });
}
for (const tier of [0, 3, 9]) {
  scenario(`settle-tier-${tier}`, 1, tier ? 900 : 600, rt => {
    const world = worldFor(rt.SB);
    world.add(new rt.SB.Sobo(tier, 0, 0));
    return { world };
  }, state => state.world.step());
}
for (const seed of [1, 42, 20261019]) {
  scenario(`crowded-40-seed-${seed}`, seed, 1200, rt => {
    const world = worldFor(rt.SB), R = rt.random;
    for (let k = 0; k < 40; k++) {
      world.add(new rt.SB.Sobo(Math.floor(R() * 5), -150 + R() * 300, -250 + (k % 8) * 60))
        .setVelocity((R() - 0.5) * 400, 0);
    }
    return { world };
  }, state => state.world.step());
}
for (const layout of ['mobile', 'desktop']) {
  scenario(`merge-shock-${layout}`, 7, 480, rt => {
    const world = worldFor(rt.SB, layout);
    world.add(new rt.SB.Sobo(2, -60, 200)).setVelocity(200, 0);
    world.add(new rt.SB.Sobo(2, 60, 200)).setVelocity(-200, 0);
    return { world, merges: 0 };
  }, (state, rt) => {
    state.world.step();
    if (!state.merges && state.world.pairs.length) {
      const p = state.world.pairs[0];
      const x = (p.a.x[p.ia] + p.b.x[p.ib]) / 2;
      const y = (p.a.y[p.ia] + p.b.y[p.ib]) / 2;
      state.world.merge(p.a, p.b, p.ia, p.ib);
      state.world.shock(x, y, p.a.data.outerArea / 20000);
      state.merges++;
    }
  });
  for (const seed of [2, 20261019]) {
    scenario(`classic-input-save-${layout}-seed-${seed}`, seed, 1500, rt => {
      const events = [];
      const hooks = {};
      for (const name of ['spawn', 'merge', 'gain', 'launch', 'select', 'cancel', 'barJoin', 'barLeave', 'holdStart', 'holdEnd', 'preGameOver', 'gameOver', 'safetySpawn']) {
        hooks[name] = (...values) => events.push([name, ...values.map(v => v && typeof v === 'object' && 'id' in v ? { soboId: v.id } : v)]);
      }
      const mode = new rt.SB.Classic(layout, hooks);
      return { mode, world: mode.world, events, restoreAccepted: null, selections: 0, launches: 0 };
    }, (state, rt, step) => {
      const m = state.mode;
      if (step % 60 === 20 && m.selectable.length) {
        const s = m.selectable[(Math.floor(step / 60)) % m.selectable.length];
        const device = Math.floor(step / 60) % 2 ? 'mouse' : 'touch';
        if (m.pointerDown(s.cx, s.cy, device)) state.selections++;
        m.pointerMove(s.cx + ((Math.floor(step / 60) % 3) - 1) * 75, s.cy + 160, device);
      }
      if (step % 60 === 23 && m.aim) { m.pointerUp(); state.launches++; }
      if (step % 180 === 80 && m.selectable.length) {
        const s = m.selectable[0];
        m.pointerDown(s.cx, s.cy, 'touch');
        m.pointerMove(s.cx - 100, s.cy + 100, 'touch');
        m.cancelAim();
      }
      if (step === 750) {
        const save = JSON.parse(JSON.stringify(m.capture()));
        const restored = new rt.SB.Classic(layout, m.hooks);
        state.restoreAccepted = restored.restore(save);
        if (!state.restoreAccepted) throw new Error('Save restore was rejected');
        state.mode = restored;
        state.world = restored.world;
      }
      state.mode.tick();
      state.mode.frame(1 / 60);
    });
  }
  scenario(`gameover-freeze-${layout}`, 3, 240, rt => {
    const events = [];
    const mode = new rt.SB.Classic(layout, {
      preGameOver: () => events.push('pre'), gameOver: () => events.push('over')
    });
    return { mode, world: mode.world, events };
  }, (state, rt, step) => {
    if (step === 10) {
      state.mode.sides.forEach(side => {
        side.bumper.x = side.bumper.restX + side.bumper.dir * rt.SB.PHYS.bumperTravel;
        side.bumper.vx = 0;
      });
    }
    state.mode.tick();
    state.mode.frame(1 / 60);
  });
}

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { offset: i, reference: a.slice(Math.max(0, i - 90), i + 160), candidate: b.slice(Math.max(0, i - 90), i + 160) };
}
function quantile(sorted, p) { return sorted[Math.ceil(sorted.length * p) - 1]; }
function timings(values) {
  const ordered = values.slice().sort((a, b) => a - b);
  return {
    samples: values.length,
    meanMs: values.reduce((a, b) => a + b, 0) / values.length,
    p50Ms: quantile(ordered, .5), p95Ms: quantile(ordered, .95), p99Ms: quantile(ordered, .99),
    maxMs: ordered[ordered.length - 1], over16_667Ms: values.filter(v => v > 1000 / 60).length
  };
}

const report = {
  createdAt: new Date().toISOString(), node: process.version,
  platform: `${process.platform} ${os.release()} ${process.arch}`, cpu: os.cpus()[0]?.model,
  reference, candidate, exactComparison: true, rounding: false, tolerance: 0,
  timingScope: 'advance() only: input/rules/physics/frame work; excludes state serialization, equality checks, finite validation and hashing; Node VM is not browser rendering',
  files: FILES.map(file => {
    const a = fs.readFileSync(path.join(reference, 'js', file));
    const b = fs.readFileSync(path.join(candidate, 'js', file));
    return { file, referenceSha256: sha256(a), candidateSha256: sha256(b), bytesIdentical: a.equals(b) };
  }), scenarios: [], pass: false
};
let allNumeric = 0, allCheckpoints = 0;
try {
  for (const spec of SCENARIOS) {
    const a = loadRuntime(reference, spec.seed), b = loadRuntime(candidate, spec.seed);
    const x = spec.setup(a), y = spec.setup(b);
    const hash = crypto.createHash('sha256');
    let values = 0, peakSobos = 0, peakSubas = 0, peakRecoveries = 0;
    const elapsedA = [], elapsedB = [];
    for (let step = -1; step < spec.steps; step++) {
      if (step >= 0) {
        let t = performance.now(); spec.advance(x, a, step); elapsedA.push(performance.now() - t);
        t = performance.now(); spec.advance(y, b, step); elapsedB.push(performance.now() - t);
        ensureFinite(x.world, `${spec.name} reference step ${step}`);
        ensureFinite(y.world, `${spec.name} candidate step ${step}`);
      }
      const sx = snapshot({ state: x, randomState: a.randomState() });
      const sy = snapshot({ state: y, randomState: b.randomState() });
      if (sx.text !== sy.text) {
        const error = new Error(`${spec.name}: exact state mismatch at step ${step}`);
        error.details = firstDifference(sx.text, sy.text);
        throw error;
      }
      hash.update(sx.text).update('\n');
      values += sx.numericValues;
      peakSobos = Math.max(peakSobos, x.world.sobos.length);
      peakSubas = Math.max(peakSubas, x.world.sobos.reduce((sum, s) => sum + s.n, 0));
      peakRecoveries = Math.max(peakRecoveries, x.world.recoveries.length);
    }
    if (spec.name.startsWith('merge-shock') && x.merges !== 1) throw new Error(`${spec.name}: fixture did not merge`);
    if (spec.name.startsWith('classic-input-save') && (!x.selections || !x.launches || !x.restoreAccepted)) throw new Error(`${spec.name}: input/save path was not exercised`);
    if (spec.name.startsWith('gameover-freeze') && x.mode.state !== 'gameover') throw new Error(`${spec.name}: gameover path was not exercised`);
    const result = {
      name: spec.name, seed: spec.seed, ticks: spec.steps, checkpoints: spec.steps + 1,
      exactNumericValuesCompared: values, trajectorySha256: hash.digest('hex'),
      peakSobos, peakSubas, peakRecoveries,
      finalScore: x.mode?.score, finalState: x.mode?.state,
      inputSelections: x.selections, launches: x.launches, restoreAccepted: x.restoreAccepted,
      referenceTiming: timings(elapsedA), candidateTiming: timings(elapsedB), pass: true
    };
    allNumeric += values;
    allCheckpoints += spec.steps + 1;
    report.scenarios.push(result);
    console.log(`PASS ${result.name}: ${result.checkpoints} identical checkpoints, candidate mean/p95/p99/max ${result.candidateTiming.meanMs.toFixed(3)}/${result.candidateTiming.p95Ms.toFixed(3)}/${result.candidateTiming.p99Ms.toFixed(3)}/${result.candidateTiming.maxMs.toFixed(3)} ms`);
  }
  report.exactNumericValuesCompared = allNumeric;
  report.checkpoints = allCheckpoints;
  report.nativeBenchmarks = [];
  for (const seed of [1, 42, 20261019]) {
    const result = { seed, timingScope: 'Fresh non-VM Node process; world.step() only; no warmup; 40 sobos, 1200 ticks; finite validation after measured run' };
    for (const [label, root] of [['reference', reference], ['candidate', candidate]]) {
      const child = spawnSync(process.execPath, [__filename, '--benchmark-worker', root, String(seed)], { encoding: 'utf8' });
      if (child.status !== 0) throw new Error(`Native benchmark ${label} seed ${seed}: ${child.stderr || child.error || child.status}`);
      result[label] = JSON.parse(child.stdout);
    }
    report.nativeBenchmarks.push(result);
    console.log(`NATIVE crowded-40-seed-${seed}: candidate mean/p95/p99/max ${result.candidate.meanMs.toFixed(3)}/${result.candidate.p95Ms.toFixed(3)}/${result.candidate.p99Ms.toFixed(3)}/${result.candidate.maxMs.toFixed(3)} ms`);
  }
  report.pass = true;
  console.log(`PASS ${SCENARIOS.length} scenarios, ${allCheckpoints} exact checkpoints, ${allNumeric} numeric values.`);
} catch (error) {
  report.error = { message: error.message, details: error.details };
  console.error('FAIL', error.message, error.details || '');
  process.exitCode = 1;
} finally {
  if (reportFile) {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(`Report: ${reportFile}`);
  }
}
