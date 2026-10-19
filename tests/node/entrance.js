// 入场合并：侧边入场球（部分膜点仍在墙外）与同级球合并后，新球必须继承
// wall/entering：墙外膜点保持 entering、不参与墙碰撞，随入场自然进入，
// 不被墙强行推回（无大跳变、无 fixShape 重置），最终完整入场且不穿墙。
const SB = require('./harness');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

const WALL_X = 196, R = SB.SUBA_R;

// 复刻报告场景：mobile 右侧入场球推进到首次可选，与横线附近同级球合并。
const m = new SB.Classic('mobile');
m._spawn(m.sides[1], false);
let frame = 0;
while (!m.selectable.length && frame++ < 100) { m.world.step(); m._reenable(); }
check('入场球已推进到可选', m.selectable.length === 1, `n=${m.selectable.length}`);

const b = m.world.add(new SB.Sobo(0, 150, m.layout.barY));
m._selectable(b);
m.world.step(); m._reenable();
m._merges();

// 合并后只剩一个球（合并产物），且仍在入场中。
check('两个球合并为一个', m.world.sobos.length === 1, `n=${m.world.sobos.length}`);
const N = m.world.sobos[0];
check('合并产物仍在入场（emerging）', m.emerging.indexOf(N) >= 0);
check('仍有膜点在墙外（entering=1）', N.entering.some(v => v === 1));
check('墙外膜点墙碰撞关闭（wall=0）', N.entering.every((e, i) => !e || N.wall[i] === 0));

// 监控入场过程：包装 fixShape，统计单步最大跳变。
let resets = 0;
const origFix = N.fixShape;
N.fixShape = function () { resets++; return origFix.call(this); };
let maxJump = 0;
for (let f = 0; f < 360; f++) {
  const oldX = Array.from(N.x), oldY = Array.from(N.y);
  m.world.step();
  m._reenable();
  for (let i = 0; i < N.n; i++) {
    maxJump = Math.max(maxJump, Math.hypot(N.x[i] - oldX[i], N.y[i] - oldY[i]));
  }
}

check('入场过程无 fixShape 重置', resets === 0, `resets=${resets}`);
check('单步无大跳变（远小于旧 97）', maxJump < 25, `maxJump=${maxJump.toFixed(2)}`);
check('最终所有膜点进入墙内（entering=0）', N.entering.every(e => e === 0), `entering=${Array.from(N.entering).join('')}`);
check('最终所有膜点恢复墙碰撞（wall=1）', N.wall.every(w => w === 1), `wall=${Array.from(N.wall).join('')}`);
check('最终膜点不穿过右侧墙（x+R ≤ 196）', N.x.every(x => x + R <= WALL_X + 0.5),
  `maxX=${(Math.max(...N.x) + R).toFixed(1)}`);
check('无 NaN', isFinite(N.cx) && isFinite(N.cy));
process.exit(fails ? 1 : 0);
