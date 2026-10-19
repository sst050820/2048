// 跨平台 Playwright 加载器：优先项目本地依赖，其次环境变量指定路径 / 全局安装；
// 找不到时给出明确安装指引，而不是引用某个 Linux 专属目录（/opt/...）导致直接崩溃。
const path = require('path');

function loadPlaywright() {
  // 1) 项目本地安装（npm install playwright）。
  try { return require('playwright'); } catch (_) {}
  // 2) 通过环境变量显式指定 playwright 模块目录。
  if (process.env.PLAYWRIGHT_PATH) {
    return require(path.resolve(process.env.PLAYWRIGHT_PATH));
  }
  // 3) 全局安装（npm root -g 下的 playwright）。
  try {
    const { execSync } = require('child_process');
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (globalRoot) return require(path.join(globalRoot, 'playwright'));
  } catch (_) {}
  throw new Error(
    '未找到 Playwright，无法运行端到端测试。请先安装：\n' +
    '  npm install playwright\n' +
    '  npx playwright install chromium\n' +
    '或用 CHROMIUM_PATH 指定 Chromium 二进制、PLAYWRIGHT_PATH 指定 playwright 模块目录。'
  );
}

const pw = loadPlaywright();
const launch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = (opts = {}) => {
  // CHROMIUM_PATH 指定浏览器二进制；不指定时交给 Playwright 按当前平台解析。
  const finalOpts = Object.assign({}, opts);
  if (process.env.CHROMIUM_PATH) finalOpts.executablePath = process.env.CHROMIUM_PATH;
  return launch(finalOpts);
};
module.exports = pw;
