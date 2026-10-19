#!/usr/bin/env node
// 运行测试，任一失败则以非零退出。
//   node tests/run.js            全部测试（node + e2e）
//   node tests/run.js node       仅无头规则与物理测试
//   node tests/run.js e2e        仅浏览器测试
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const which = process.argv[2];
const valid = ['node', 'e2e'];

// 未知参数：打印用法并以非零退出，绝不静默报告“全部通过”。
if (which && !valid.includes(which)) {
  console.error(`未知参数: "${which}"\n用法: node tests/run.js [node|e2e]`);
  process.exit(2);
}

const groups = valid.filter(g => !which || g === which);
const SKIP = ['harness.js', 'lib.js', 'pw.js'];
const failed = [];
let ran = 0;

for (const g of groups) {
  const dir = path.join(__dirname, g);
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !SKIP.includes(f)).sort();
  for (const f of files) {
    console.log(`\n# ${g}/${f}`);
    ran++;
    const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
    // 非零退出、被信号终止（status 为 null）或进程启动失败，都算失败。
    if (r.error || r.status !== 0) failed.push(`${g}/${f}`);
  }
}

// 零测试不能报告成功（例如所选组为空 / 被过滤干净）。
if (ran === 0) {
  console.error(`\n没有可运行的测试（${which || '全部'}），按失败处理。`);
  process.exit(1);
}

console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : `\nAll tests passed (${ran} files).`);
process.exit(failed.length ? 1 : 0);
