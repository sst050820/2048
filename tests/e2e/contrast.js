// 按钮全状态对比度（真实应用路径）：对 28 个主题逐个 setStyle，读取暂停卡片中
// 主按钮 / 普通按钮 / quiet 按钮在默认与 hover 态下“浏览器真实计算”的前景与背景，
// 透明背景按卡片底色合成后，按 WCAG 计算对比度，普通文字要求 ≥4.5:1。
const { run, check, watch } = require('./lib');
const ALL = require('../node/harness').STYLES.map(s => s.id);
const IDS = process.env.THEME ? ALL.filter(x => process.env.THEME.split(',').includes(x)) : ALL;

function parseColor(str) {
  str = str.trim();
  if (str[0] === '#') {
    const n = parseInt(str.slice(1), 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], a: 1 };
  }
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map(s => parseFloat(s.trim()));
  return { rgb: [parts[0], parts[1], parts[2]], a: parts[3] === undefined ? 1 : parts[3] };
}
// fg（含 alpha）叠在不透明 bg 上。
function over(fg, bg) {
  if (!fg) return bg;
  const a = fg.a;
  return fg.rgb.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
}
function relLum(c) {
  const v = c.map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(c1, c2) {
  const L1 = relLum(c1), L2 = relLum(c2);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

run(async ({ browser, url }) => {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = watch(p);
  await p.addInitScript(ids => { localStorage.setItem('soboscuba.styleUnlocks', JSON.stringify(ids)); }, IDS);
  await p.goto(url); await p.waitForTimeout(500);
  // 禁用过渡/动画，确保 setStyle 后读到的是稳态颜色（WCAG 衡量稳态），
  // 而不是 background 0.15s 过渡途中的中间色（否则前景已切换、背景仍旧，会假性失败）。
  await p.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  await p.click('#btn-play'); await p.waitForTimeout(1500);
  await p.evaluate(() => SB.game.pause()); // 打开暂停卡片，三类按钮都在
  await p.waitForTimeout(200);

  const fails = [];
  for (const id of IDS) {
    const applied = await p.evaluate(id => SB.game.setStyle(id) && SB.game.style === id, id);
    if (!applied) { fails.push(`${id}: 主题未应用`); continue; }
    await p.waitForTimeout(40);
    const d = await p.evaluate(() => {
      const q = s => document.querySelector(s);
      const cs = s => getComputedStyle(q(s));
      const grab = s => ({ color: cs(s).color, bg: cs(s).backgroundColor });
      return {
        card: cs('#pause .card').backgroundColor,
        primary: grab('#btn-resume'),
        normal: grab('#btn-restart'),
        quiet: grab('#btn-home')
      };
    });
    // 真实 hover 后读背景（触发 :hover 的 color-mix / 变量）。
    await p.hover('#btn-resume');
    d.primaryHover = (await p.evaluate(() => getComputedStyle(document.querySelector('#btn-resume')).backgroundColor));
    await p.hover('#btn-restart');
    d.normalHover = (await p.evaluate(() => getComputedStyle(document.querySelector('#btn-restart')).backgroundColor));
    await p.hover('#btn-home');
    d.quietHover = (await p.evaluate(() => getComputedStyle(document.querySelector('#btn-home')).backgroundColor));
    await p.mouse.move(8, 8);

    const states = [
      ['primary-default', d.primary.color, d.primary.bg],
      ['primary-hover', d.primary.color, d.primaryHover],
      ['normal-default', d.normal.color, d.card],
      ['normal-hover', d.normal.color, d.normalHover, d.card],
      ['quiet-default', d.quiet.color, d.card],
      ['quiet-hover', d.quiet.color, d.quietHover, d.card]
    ];
    for (const [name, fgStr, bgStr, composeStr] of states) {
      const fg = parseColor(fgStr).rgb;
      const bg = composeStr ? over(parseColor(bgStr), parseColor(composeStr).rgb) : parseColor(bgStr).rgb;
      const r = contrast(fg, bg);
      if (r < 4.5) fails.push(`${id} ${name}=${r.toFixed(2)} [fg=${fgStr} bg=${bgStr}${composeStr ? ' over ' + composeStr : ''}]`);
    }
  }
  check('28 主题三类按钮 default/hover 文字对比度均 ≥4.5:1', fails.length === 0,
    fails.length ? fails.slice(0, 24).join('  ') : '28 主题全部达标');
  check('对比度审计覆盖主题数为 28', IDS.length === 28, `${IDS.length}`);
  check('无页面错误', errors.length === 0, errors.join(' | '));
});
