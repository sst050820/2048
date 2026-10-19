// Service Worker 缓存回归：成功响应才缓存；错误响应（503）与断网都回退健康缓存。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); if (!ok) fails++; }

class MockResponse {
  constructor(body, init) { this.body = body; init = init || {}; this.status = init.status || 200; this.type = init.type || 'basic'; this.ok = this.status >= 200 && this.status < 300; }
  clone() { return new MockResponse(this.body, { status: this.status, type: this.type }); }
}
class MockRequest {
  constructor(url, init) { this.url = url; init = init || {}; this.method = init.method || 'GET'; }
}

const store = new Map();
let fetchHandler = null;
const network = [];
const sandbox = {
  console,
  Promise,
  setTimeout,
  clearTimeout,
  Response: MockResponse,
  Request: MockRequest,
  fetch: function () {
    const next = network.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
  caches: {
    open: function () {
      return Promise.resolve({
        put: function (req, res) { store.set(req.url, res); return Promise.resolve(); }
      });
    },
    match: function (req) { return Promise.resolve(store.get(req.url)); },
    keys: function () { return Promise.resolve([...store.keys()]); },
    delete: function () { return Promise.resolve(); }
  },
  self: {
    addEventListener: function (ev, fn) { if (ev === 'fetch') fetchHandler = fn; },
    skipWaiting: function () {},
    clients: { claim: function () {} }
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'www', 'sw.js'), 'utf8'), sandbox);

function dispatch(req) {
  const waited = [];
  const p = new Promise((resolve, reject) => {
    fetchHandler({ request: req, respondWith: x => x.then(resolve, reject), waitUntil: x => waited.push(x) });
  });
  return Promise.all([p, ...waited]).then(a => a[0]);
}

(async () => {
  const req = new MockRequest('index.html');
  network.push(new MockResponse('OK-200', { status: 200 }));
  const r1 = await dispatch(req);
  check('首次 200：返回并缓存健康内容', r1.status === 200 && r1.body === 'OK-200' && store.get('index.html').body === 'OK-200');

  network.push(new MockResponse('ERR-503', { status: 503 }));
  const r2 = await dispatch(req);
  check('收到 503：回退健康缓存且不污染', r2.status === 200 && r2.body === 'OK-200' && store.get('index.html').body === 'OK-200', 'got=' + r2.status + ':' + r2.body);

  network.push(new Error('offline'));
  const r3 = await dispatch(req);
  check('断网：仍取得健康缓存', r3.status === 200 && r3.body === 'OK-200', 'got=' + r3.status + ':' + r3.body);

  // 后续重新连上、拿到新的 200，缓存应正常更新。
  network.push(new MockResponse('OK-200-v2', { status: 200 }));
  const r4 = await dispatch(req);
  check('恢复后新 200：正常更新缓存', r4.body === 'OK-200-v2' && store.get('index.html').body === 'OK-200-v2');

  if (fails) process.exit(1);
  console.log('sw cache ok');
})();
