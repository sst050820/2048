// 桌面外壳 ninghe://app 协议安全与资源解析测试（纯 Node，不启动 Electron）。
// 覆盖：正常资源、根路径、中文/空格文件名、编码错误、路径越界、错误主机/协议、
// 未知扩展名、缺失文件、GET/HEAD 与非法方法。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const proto = require('../../desktop/protocol.cjs');
const wwwRoot = path.resolve(__dirname, '..', '..', 'www');

let fails = 0;
function check(name, ok, info) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : ''));
  if (!ok) fails++;
}
async function expect(method, url, root) {
  return proto.handle({ method, url, root: root || wwwRoot });
}

(async () => {
  // --- 1. 正常资源 ---
  const index = await expect('GET', 'ninghe://app/index.html');
  check('首页返回 200', index.status === 200, 'status=' + index.status);
  check('首页 Content-Type 为 html', /text\/html/.test(index.headers['content-type'] || ''), index.headers['content-type']);
  check('首页内容确实是游戏', Buffer.isBuffer(index.body) && index.body.includes('凝合'), 'body bytes=' + (index.body ? index.body.length : 0));

  const js = await expect('GET', 'ninghe://app/js/physics.js');
  check('脚本返回 200 且为 javascript', js.status === 200 && /javascript/.test(js.headers['content-type']), js.status + ' ' + js.headers['content-type']);
  const woff = await expect('GET', 'ninghe://app/fonts/nunito-latin.woff2');
  check('字体返回 font/woff2', woff.status === 200 && /font\/woff2/.test(woff.headers['content-type']), woff.status + ' ' + woff.headers['content-type']);
  const png = await expect('GET', 'ninghe://app/icons/icon-192.png');
  check('图标返回 image/png', png.status === 200 && /image\/png/.test(png.headers['content-type']), png.status);
  const manifest = await expect('GET', 'ninghe://app/manifest.webmanifest');
  check('manifest 返回正确媒体类型', manifest.status === 200 && /manifest\+json/.test(manifest.headers['content-type']), manifest.status + ' ' + manifest.headers['content-type']);

  // --- 2. 根路径映射到 index.html ---
  const root = await expect('GET', 'ninghe://app/');
  check('根路径返回首页', root.status === 200 && root.body.includes('凝合'), 'status=' + root.status);

  // --- 3. 中文与空格文件名（临时 fixture） ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ninghe-proto-'));
  fs.mkdirSync(path.join(tmp, '子目录'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '子目录', '测试 文件.txt'), '中文与空格');
  fs.writeFileSync(path.join(tmp, 'index.html'), '<meta charset="utf-8">首页');
  try {
    const cn = await expect('GET', 'ninghe://app/' + encodeURIComponent('子目录') + '/' + encodeURIComponent('测试 文件.txt'), tmp);
    check('中文+空格路径返回 200 且内容正确', cn.status === 200 && cn.body.toString('utf8') === '中文与空格', 'status=' + cn.status + ' body=' + (cn.body ? cn.body.toString() : ''));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // --- 4. 编码错误（不完整/非法百分号）---
  for (const bad of ['ninghe://app/%', 'ninghe://app/%E0%A4%A', 'ninghe://app/a%zz']) {
    const r = await expect('GET', bad);
    check('畸形 URL 拒绝（400）：' + bad, r.status === 400, 'status=' + r.status);
  }

  // --- 5. 路径越界：绝不返回 www 根目录之外的真实文件 ---
  // 用“真实存在于 www 之外、若防护失效就会泄露”的项目根 package.json 作为越界目标。
  const rootPkg = fs.readFileSync(path.join(wwwRoot, '..', 'package.json'), 'utf8');
  const marker = '@electron-forge/cli';
  check('前置：泄露标记仅存在于项目根 package.json（www 内没有）', rootPkg.includes(marker) && !fs.readFileSync(path.join(wwwRoot, 'index.html'), 'utf8').includes(marker));

  // A. 正斜杠的 ..（含 %2e%2e）在 WHATWG URL 解析阶段就被规范化到 host 根内，
  //    无法越过 www；正确表现是落到 www 根内寻找（文件不存在 → 404），且不泄露项目根文件。
  for (const evil of [
    'ninghe://app/../package.json',
    'ninghe://app/%2e%2e/package.json',
    'ninghe://app/css/../../package.json',
  ]) {
    const r = await expect('GET', evil);
    const leaked = r.body && r.body.toString('utf8').includes(marker);
    check('正斜杠越界不泄露 www 外文件：' + evil, r.status === 404 && !leaked, 'status=' + r.status + ' leaked=' + leaked);
  }
  // B. 文件系统分隔符绕过（编码反斜杠 %5c、编码斜杠 %2f）URL 标准化不识别，
  //    decode 后在 Windows 文件系统层形成真实穿越，必须由根目录包含校验拒绝（403）。
  for (const evil of [
    'ninghe://app/..%5c..%5cpackage.json',
    'ninghe://app/%2e%2e%2fpackage.json',
    'ninghe://app/css%2f..%2f..%2fpackage.json',
  ]) {
    const r = await expect('GET', evil);
    const leaked = r.body && r.body.toString('utf8').includes(marker);
    check('文件系统分隔符越界拒绝（403）：' + evil, r.status === 403 && !leaked, 'status=' + r.status + ' leaked=' + leaked);
  }

  // --- 6. 错误主机 / 错误协议 ---
  for (const bad of [
    ['GET', 'ninghe://evil/index.html'],
    ['GET', 'ninghe://other/index.html'],
    ['GET', 'http://app/index.html'],
    ['GET', 'file:///C:/Windows/win.ini'],
  ]) {
    const r = await expect(bad[0], bad[1]);
    check('错误主机/协议拒绝：' + bad[1], r.status === 400 || r.status === 403, 'status=' + r.status);
  }

  // --- 7. 未知扩展名 / 缺失文件 ---
  const exe = await expect('GET', 'ninghe://app/x.exe');
  check('可执行扩展名拒绝（404）', exe.status === 404, 'status=' + exe.status);
  const missing = await expect('GET', 'ninghe://app/does-not-exist.html');
  check('缺失文件返回 404', missing.status === 404, 'status=' + missing.status);
  // sw.js 是真实存在的 .js，应能取到（桌面不注册它，但资源本身不拦截）
  const sw = await expect('GET', 'ninghe://app/sw.js');
  check('sw.js 资源本身可取（不影响协议白名单）', sw.status === 200, 'status=' + sw.status);

  // --- 8. 方法：HEAD 返回头无 body，其余方法 405 ---
  const head = await expect('HEAD', 'ninghe://app/index.html');
  check('HEAD 返回 200 且无响应体', head.status === 200 && (!head.body || head.body.length === 0), 'status=' + head.status + ' body=' + (head.body ? head.body.length : 0));
  for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const r = await expect(m, 'ninghe://app/index.html');
    check(m + ' 返回 405', r.status === 405, 'status=' + r.status);
  }

  // --- 9. 导出的 scheme / host 常量 ---
  check('协议常量为 ninghe/app', proto.SCHEME === 'ninghe' && proto.HOST === 'app', proto.SCHEME + '://' + proto.HOST);

  if (fails) process.exit(1);
  console.log('protocol ok');
})().catch(e => { console.error(e); process.exit(1); });
