// 开发服务器路由回归：首页指向凝合.html、源文件 PWA 资源可访问、方法与状态码正确。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

const PORT = 4299;
const root = path.resolve(__dirname, '..', '..');
const srv = spawn(process.execPath, [path.join(root, 'tools', 'serve.cjs'), String(PORT)], { cwd: root });

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}
function waitUp() {
  return new Promise(resolve => {
    const t = setInterval(() => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: '/', method: 'HEAD' }, res => { res.resume(); clearInterval(t); resolve(); });
      r.on('error', () => {});
      r.end();
    }, 100);
    setTimeout(() => { clearInterval(t); resolve(); }, 5000);
  });
}
(async () => {
  await waitUp();
  const standalone = fs.readFileSync(path.join(root, '凝合.html'));
  for (const p of ['/', '/index.html', '/standalone.html']) {
    const g = await req('GET', p);
    check('GET ' + p + ' 200 且内容=凝合.html', g.status === 200 && g.body.equals(standalone), 'status=' + g.status);
  }
  const h = await req('HEAD', '/');
  check('HEAD 返回 200 且无正文', h.status === 200 && h.body.length === 0);
  const sw = fs.readFileSync(path.join(root, 'www', 'sw.js'));
  const gsw = await req('GET', '/source/sw.js');
  check('GET /source/sw.js 200 且内容=www/sw.js', gsw.status === 200 && gsw.body.equals(sw), 'status=' + gsw.status + ' ct=' + gsw.headers['content-type']);
  const gman = await req('GET', '/source/manifest.webmanifest');
  check('GET /source/manifest.webmanifest 200', gman.status === 200 && /manifest\+json/.test(gman.headers['content-type']), 'status=' + gman.status + ' ct=' + gman.headers['content-type']);
  const nf = await req('GET', '/nope.html');
  check('不存在资源返回 404', nf.status === 404);
  const esc = await req('GET', '/source/..%2f..%2fpackage.json');
  check('路径越界被拦返回 404', esc.status === 404, 'status=' + esc.status);
  const post = await req('POST', '/');
  check('POST 返回 405', post.status === 405);
  srv.kill();
  if (fails) process.exit(1);
  console.log('serve routes ok');
})();
