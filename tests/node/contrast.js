// 对比度静态快审：遍历全部 28 个主题，验证主按钮（special 底）与危险标记
// （danger 底）在默认基色上所选前景（黑/白）达到 WCAG 正常文本 4.5:1。
// 注意：按钮 default/hover/active 全状态、透明背景合成、color-mix 后的“真实
// 应用路径”审计由 tests/e2e/contrast.js 读取浏览器计算样式完成（含 primary hover、
// 普通/quiet 按钮与计数胶囊），本文件只做无需浏览器的基色快速把关。
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function relLum(h) {
  const c = hexRgb(h);
  const v = [c[0] / 255, c[1] / 255, c[2] / 255].map(x =>
    (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(h1, h2) {
  const L1 = relLum(h1), L2 = relLum(h2);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}
const DARK = '#000000', LIGHT = '#ffffff';
// 返回对比更高的前景及其对比度（与 game.js 的 inkFor 同逻辑）。
function inkFor(accent) {
  const cd = contrast(accent, DARK), cl = contrast(accent, LIGHT);
  return cd >= cl ? { c: DARK, r: cd } : { c: LIGHT, r: cl };
}

let bad = [];
for (const s of SB.STYLES) {
  const r = inkFor(s.special);
  if (r.r < 4.5) bad.push(`${s.id} 主按钮=${r.r.toFixed(2)}`);
  const rd = inkFor(s.danger);
  if (rd.r < 4.5) bad.push(`${s.id} 危险标记=${rd.r.toFixed(2)}`);
}
check('全部 28 主题主按钮与危险标记对比度 ≥4.5:1', bad.length === 0, bad.join('  '));

// 报告点名的问题主题：浅青底主按钮原本仅 2.39:1，现在应达 4.5:1。
const problem = SB.STYLES.find(s => s.special.toUpperCase() === '#00B2BF');
check('问题主题 #00B2BF 主按钮对比度达标', !!problem && inkFor(problem.special).r >= 4.5,
  problem ? inkFor(problem.special).r.toFixed(2) : '主题缺失');
check('审计主题数为 28', SB.STYLES.length === 28, `n=${SB.STYLES.length}`);
process.exit(fails ? 1 : 0);
