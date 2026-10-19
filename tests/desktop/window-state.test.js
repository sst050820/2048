// 窗口状态：默认居中、坏数据回退、尺寸/位置钳制、拔显示器归位、状态持久化往返。
// 纯 Node，不启动 Electron。
const fs = require('fs');
const os = require('os');
const path = require('path');
const ws = require('../../desktop/window-state.cjs');

let fails = 0;
function check(name, ok, info) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : ''));
  if (!ok) fails++;
}
const { defaultBounds, isWellFormed, clampBounds, chooseBounds, intersectArea, readState, writeState } = ws;

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND = { x: 1920, y: 0, width: 1920, height: 1040 };
const SMALL = { x: 0, y: 0, width: 800, height: 600 };

// 1. 默认窗口：标准工作区居中，且不超出工作区。
(function () {
  const b = defaultBounds(PRIMARY);
  check('默认尺寸为 1100×800', b.width === 1100 && b.height === 800, JSON.stringify(b));
  check('默认水平居中', Math.abs((b.x + b.width / 2) - PRIMARY.width / 2) <= 1, 'x=' + b.x);
  check('默认垂直居中', Math.abs((b.y + b.height / 2) - PRIMARY.height / 2) <= 1, 'y=' + b.y);
})();

// 2. 小工作区：默认窗口缩到不大于工作区。
(function () {
  const b = defaultBounds(SMALL);
  check('小工作区宽度不超出', b.width <= SMALL.width, 'w=' + b.width);
  check('小工作区高度不超出', b.height <= SMALL.height, 'h=' + b.height);
  check('小工作区完全在屏内', b.x >= 0 && b.y >= 0 && b.x + b.width <= SMALL.width && b.y + b.height <= SMALL.height, JSON.stringify(b));
})();

// 3. 结构校验。
(function () {
  check('完整状态合法', isWellFormed({ x: 10, y: 10, width: 1100, height: 800 }) === true);
  check('null 非法', isWellFormed(null) === false);
  check('缺 width 非法', isWellFormed({ x: 0, y: 0, height: 800 }) === false);
  check('非数字 width 非法', isWellFormed({ x: 0, y: 0, width: 'abc', height: 800 }) === false);
  check('NaN 非法', isWellFormed({ x: 0, y: 0, width: NaN, height: 800 }) === false);
  check('宽度小于最小值非法', isWellFormed({ x: 0, y: 0, width: 100, height: 800 }) === false);
})();

// 4. 尺寸钳制：状态大于工作区时缩回。
(function () {
  const huge = { x: 0, y: 0, width: 5000, height: 5000 };
  const b = clampBounds(huge, PRIMARY);
  check('超大窗口宽度钳到工作区', b.width <= PRIMARY.width, 'w=' + b.width);
  check('超大窗口高度钳到工作区', b.height <= PRIMARY.height, 'h=' + b.height);
})();

// 5. 位置钳制：窗口大部分在屏幕右侧/下侧外时，移回可见区。
(function () {
  const offRight = { x: PRIMARY.width + 500, y: 100, width: 1100, height: 800 };
  const b = clampBounds(offRight, PRIMARY);
  const rect = { x: b.x, y: b.y, width: b.width, height: b.height };
  check('右越界窗口仍露出标题栏区域', intersectArea(rect, PRIMARY) >= 120 * 48, 'area=' + intersectArea(rect, PRIMARY));
  const offTop = { x: 100, y: -3000, width: 1100, height: 800 };
  const b2 = clampBounds(offTop, PRIMARY);
  const rect2 = { x: b2.x, y: b2.y, width: b2.width, height: b2.height };
  check('上越界窗口仍露出标题栏区域', intersectArea(rect2, PRIMARY) >= 120 * 48, 'area=' + intersectArea(rect2, PRIMARY));
})();

// 6. 多显示器：在副屏内的窗口保留在副屏。
(function () {
  const onSecond = { x: 2100, y: 50, width: 1100, height: 800 };
  const b = chooseBounds(onSecond, [PRIMARY, SECOND], PRIMARY);
  check('副屏窗口保留在副屏', b.x >= SECOND.x && b.x + b.width <= SECOND.x + SECOND.width, JSON.stringify(b));
})();

// 7. 拔显示器：窗口原本在副屏、现在只剩主屏 → 回到主屏默认居中。
(function () {
  const onRemoved = { x: 2500, y: 100, width: 1100, height: 800 };
  const b = chooseBounds(onRemoved, [PRIMARY], PRIMARY);
  const expect = defaultBounds(PRIMARY);
  check('拔显示器后回到主屏默认位置', b.x === expect.x && b.y === expect.y && b.width === expect.width && b.height === expect.height,
    JSON.stringify(b) + ' expect=' + JSON.stringify(expect));
})();

// 8. 非法状态在任何显示器集合下回退默认。
(function () {
  const b = chooseBounds(null, [PRIMARY, SECOND], PRIMARY);
  const expect = defaultBounds(PRIMARY);
  check('非法状态回退主屏默认', b.x === expect.x && b.y === expect.y);
  const b2 = chooseBounds({ x: 1, y: 1, width: 10, height: 10 }, [PRIMARY], PRIMARY);
  check('过小尺寸状态回退主屏默认', b2.width === expect.width && b2.height === expect.height);
})();

// 9. 状态持久化：写→读往返、缺失与损坏文件安全返回 null。
(function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ninghe-winstate-'));
  const file = path.join(dir, 'window-state.json');
  try {
    check('不存在的状态读取为 null', readState(file) === null);
    const state = { x: 304, y: 56, width: 1102, height: 800, isMaximized: true, isFullScreen: false };
    check('写入成功', writeState(file, state) === true);
    const back = readState(file);
    check('写读往返一致', back && back.x === 304 && back.width === 1102 && back.isMaximized === true, JSON.stringify(back));
    fs.writeFileSync(file, '{ this is not valid json ', 'utf8');
    check('损坏 JSON 读取为 null', readState(file) === null);
    check('临时文件已清理（原子写）', fs.existsSync(file + '.tmp') === false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

if (fails) process.exit(1);
console.log('window-state ok');
