'use strict';
/*
 * 桌面应用的自定义资源协议：ninghe://app/...
 *
 * 设计目标（见 docs/Windows-EXE制作方案与执行计划.md）：
 *   - 只返回随包携带的 www 静态资源，不连任何远程地址，不使用开发服务器；
 *   - 白名单：主机只能是 app、方法只能是 GET/HEAD、扩展名必须在 MIME 表内；
 *   - 路径解析做越界防护（正确处理中文/空格、非法百分号编码、../、反斜杠、双重编码）；
 *   - 桌面协议下不启用 Service Worker（离线能力直接来自本地资源）。
 *
 * 纯解析 / 处理函数（resolveResource、handle）不依赖 electron，便于 tests/desktop
 * 在纯 Node 下直接断言；register() 才在 Electron 主进程内调用，且在函数体内 require
 * electron，避免 Node 测试加载 GUI 运行时。
 */

const path = require('path');
const fs = require('fs');

const SCHEME = 'ninghe';
const HOST = 'app';
const ALLOWED_METHODS = ['GET', 'HEAD'];

// 只提供游戏真正需要的资源类型；任何未列出的扩展名（.exe/.dll/.json 任意文件等）一律不返回。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// 对 HTML 文档施加的内容安全策略。游戏只有同源本地资源，没有远程请求；
// 内联脚本仅用于 index.html 末尾的 Service Worker 注册（桌面协议下不会注册）。
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' data:",
  "manifest-src 'self'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * 解析 ninghe://app/<path> 到受保护根目录内的绝对路径。
 * 不做任何磁盘 IO，便于纯单元测试。
 * @returns {{ok:true, absPath:string, ext:string} | {ok:false, status:number, reason:string}}
 */
function resolveResource(urlStr, root) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return { ok: false, status: 400, reason: 'malformed-url' };
  }
  if (u.protocol !== SCHEME + ':') return { ok: false, status: 400, reason: 'bad-scheme' };
  if (u.hostname !== HOST) return { ok: false, status: 403, reason: 'bad-host' };

  // URL.pathname 仍是百分号编码；中文 / 空格文件名要先 decode，非法转义在此被拒。
  let decoded;
  try {
    decoded = decodeURIComponent(u.pathname);
  } catch (e) {
    return { ok: false, status: 400, reason: 'malformed-encoding' };
  }

  // 去掉开头的斜杠；统一正反斜杠（Windows 上 \ 也是分隔符）。
  let rel = decoded.replace(/^\/+/, '').replace(/\\/g, '/');
  // 空路径 / 根路径返回首页。
  if (rel === '') rel = 'index.html';

  const rootNorm = path.resolve(root);
  const abs = path.resolve(rootNorm, rel);

  // 越界防护：规范化后的绝对路径必须仍在根目录内，否则一律拒绝。
  if (abs !== rootNorm && !abs.startsWith(rootNorm + path.sep)) {
    return { ok: false, status: 403, reason: 'path-traversal' };
  }

  return { ok: true, absPath: abs, ext: path.extname(abs).toLowerCase() };
}

/**
 * 处理一个资源请求。
 * @param {{method?:string, url:string, root:string, fsImpl?:typeof fs}} opts
 * @returns {Promise<{status:number, headers:Object, body:Buffer}>}
 */
async function handle({ method, url, root, fsImpl }) {
  const m = String(method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.includes(m)) {
    return { status: 405, headers: { allow: 'GET, HEAD' }, body: Buffer.alloc(0) };
  }

  const r = resolveResource(url, root);
  if (!r.ok) {
    return {
      status: r.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from(r.reason, 'utf8'),
    };
  }

  const mime = MIME[r.ext];
  if (!mime) {
    return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('unsupported-type', 'utf8') };
  }

  const fsp = (fsImpl || fs).promises;
  let st;
  try {
    st = await fsp.stat(r.absPath);
  } catch (e) {
    return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('not-found', 'utf8') };
  }
  if (!st.isFile()) {
    return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('not-found', 'utf8') };
  }

  const securityHeaders = {
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  };
  if (r.ext === '.html') securityHeaders['content-security-policy'] = CSP;

  if (m === 'HEAD') {
    return {
      status: 200,
      headers: { 'content-type': mime, 'content-length': String(st.size), ...securityHeaders },
      body: Buffer.alloc(0),
    };
  }

  let data;
  try {
    data = await fsp.readFile(r.absPath);
  } catch (e) {
    return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('not-found', 'utf8') };
  }
  return {
    status: 200,
    headers: { 'content-type': mime, 'content-length': String(data.length), ...securityHeaders },
    body: data,
  };
}

// 注册 scheme 的特权属性（必须在 app.ready 之前调用）。
// secure + standard 让它被视为安全标准源（同源、可承载 fetch/字体）；显式关闭 service worker。
function privileges() {
  return [{
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      allowServiceWorkers: false,
    },
  }];
}

/**
 * 在 Electron 主进程注册协议处理器。electron 在此函数内才被 require，
 * 使纯 Node 测试加载本模块时不会触碰 GUI 运行时。
 * @param {import('electron').Protocol} protocol Electron 的 protocol 模块
 * @param {string} root www 资源根目录绝对路径
 */
function register({ protocol, root }) {
  protocol.handle(SCHEME, async (request) => {
    try {
      const res = await handle({ method: request.method, url: request.url, root });
      return new Response(res.body && res.body.length ? res.body : null, {
        status: res.status,
        headers: res.headers,
      });
    } catch (e) {
      return new Response('internal-error', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
  });
}

const APP_URL = `${SCHEME}://${HOST}/index.html`;

module.exports = {
  SCHEME,
  HOST,
  APP_URL,
  CSP,
  MIME,
  resolveResource,
  handle,
  privileges,
  register,
};
