// 旧静态服务器 tools/serve.js（e2e 使用）健壮性：畸形 URL 必须返回 400 且不崩溃，
// 之后正常资源仍可访问。
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

const PORT = 4311;
const root = path.resolve(__dirname, '..', '..');
const srv = spawn(process.execPath, [path.join(root, 'tools', 'serve.js'), String(PORT)], { cwd: root });
let crashed = false;
srv.on('exit', code => { crashed = true; });

function rawReq(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}
function waitUp() {
  return new Promise(resolve => {
    const t = setInterval(() => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: '/index.html', method: 'HEAD' }, res => { res.resume(); clearInterval(t); resolve(); });
      r.on('error', () => {});
      r.end();
    }, 100);
    setTimeout(() => { clearInterval(t); resolve(); }, 5000);
  });
}
(async () => {
  await waitUp();
  // 正常资源可访问。
  const ok = await rawReq('GET', '/index.html');
  check('正常首页返回 200', ok.status === 200, 'status=' + ok.status);
  // 畸形 URL：返回 400，不抛异常。
  for (const bad of ['/%', '/%E0%A4%A', '/%zz']) {
    let status = null, threw = false;
    try { status = (await rawReq('GET', bad)).status; } catch (e) { threw = true; }
    check('畸形 URL ' + bad + ' 返回 400', !threw && status === 400, 'status=' + status + ' threw=' + threw);
  }
  // 给服务器一点时间，确认进程未因未捕获异常退出。
  await new Promise(r => setTimeout(r, 300));
  check('处理畸形 URL 后服务器仍存活', crashed === false);
  // 存活后正常请求仍 200。
  const after = await rawReq('GET', '/index.html');
  check('崩溃后恢复正常访问', after.status === 200, 'status=' + after.status);
  srv.kill();
  if (fails) process.exit(1);
  console.log('legacy serve ok');
})();
