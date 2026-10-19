// 横竖屏布局回归：物理布局（layoutName）固定，屏幕尺寸/方向变化时，
// 场地（view.play）必须完整落在屏幕内，不左右超出、不裁掉 HUD。
// 通过 mock canvas 在 Node 中加载真实 Renderer，遍历多种尺寸。
global.window = global;
const SB = require('./harness');
const fs = require('fs'), path = require('path');

// 最小 mock：canvas + ctx（resize 只写 canvas.width/height，不调用 ctx）。
const ctxMock = new Proxy({}, { get: () => () => {}, set: () => true });
const canvasMock = { width: 0, height: 0, style: {}, getContext: () => ctxMock };
(0, eval)(fs.readFileSync(path.join(__dirname, '..', '..', 'www', 'js', 'render.js'), 'utf8'));

let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

function fits(layoutName, w, h, label) {
  const r = new SB.Renderer(canvasMock);
  r.resize(w, h, 1, [0, 0, 0, 0], layoutName);
  const p = r.view.play;
  const inside = p.x >= -0.5 && p.y >= -0.5 && p.x + p.w <= w + 0.5 && p.y + p.h <= h + 0.5;
  check(`${label} 场地完整不超出 (${layoutName} ${w}x${h})`, inside,
    `play x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} w=${p.w.toFixed(0)} h=${p.h.toFixed(0)}`);
  return p;
}

// wide 显示标志：desktop 宽屏用侧栏，窄屏（含 desktop 局）用顶部面板。
{
  const r = new SB.Renderer(canvasMock);
  r.resize(1280, 720, 1, [0, 0, 0, 0], 'desktop');
  check('desktop 宽屏 wide=true（侧栏）', r.view.wide === true);
  r.resize(390, 844, 1, [0, 0, 0, 0], 'desktop');
  check('desktop 局窄屏 wide=false（顶部面板，HUD 不被裁）', r.view.wide === false);
  r.resize(390, 844, 1, [0, 0, 0, 0], 'mobile');
  check('mobile 竖屏 wide=false', r.view.wide === false);
}

// 报告点名场景：desktop 局在桌面横屏正常，旋转到窄竖屏 390x844 后不超出。
fits('desktop', 1280, 720, '桌面横屏');
fits('desktop', 390, 844, '旋转到窄竖屏');
// 其它常见横屏。
for (const [w, h] of [[1920, 1080], [1024, 768], [1366, 768]]) fits('desktop', w, h, '横屏');
// mobile 竖屏与横屏。
for (const [w, h] of [[390, 844], [375, 667], [414, 896], [360, 740]]) fits('mobile', w, h, '竖屏');
fits('mobile', 844, 390, '横屏');
// 平板与正方形。
fits('desktop', 768, 1024, '平板竖屏');
fits('mobile', 800, 800, '正方形');

// 进一步：desktop 局窄竖屏时，场地世界内容（按 fitZoom 反算）不应被裁，
// 即 fitZoom*世界宽 <= 场地宽（fit 始终保持比例，天然成立）。
{
  const r = new SB.Renderer(canvasMock);
  r.resize(390, 844, 1, [0, 0, 0, 0], 'desktop');
  const m = { layout: SB.LAYOUTS.desktop };
  r.fit(m);
  const worldW = SB.LAYOUTS.desktop.play.x1 - SB.LAYOUTS.desktop.play.x0;
  const drawnW = worldW * r.fitZoom;
  check('窄竖屏 desktop 场地按比例完整（不拉伸不裁切）', Math.abs(drawnW - r.view.play.w) < 1 && drawnW <= 390.5,
    `drawnW=${drawnW.toFixed(0)} playW=${r.view.play.w.toFixed(0)}`);
}
process.exit(fails ? 1 : 0);
