'use strict';
// 开发服务器：提供独立成品（凝合.html）与 www 源文件版（/source/，含 PWA）。
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..'),www=path.join(root,'www'),port=Number(process.argv[2]||4281);
const mime={
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8',
  '.png':'image/png',
  '.woff2':'font/woff2',
  '.ttf':'font/ttf',
  '.otf':'font/otf',
  '.txt':'text/plain; charset=utf-8'
};
const standalone=path.join(root,'凝合.html');
http.createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
  let url;try{url=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch(e){res.writeHead(400);res.end();return;}
  let file;
  if(url==='/'||url==='/index.html'||url==='/standalone.html'){
    file=standalone;
  }else if(url==='/benchmark.html'){
    file=path.join(__dirname,'soboscuba-benchmark.html');
  }else if(url.startsWith('/source/')){
    const relative=url.slice('/source/'.length)||'index.html';
    const candidate=path.resolve(www,relative);
    // 仅允许 www 目录内、且 MIME 白名单中的资源；路径越界一律拒绝。
    if(!candidate.startsWith(www+path.sep)||!mime[path.extname(candidate)]){res.writeHead(404);res.end();return;}
    file=candidate;
  }else{
    res.writeHead(404);res.end();return;
  }
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:data);
  });
}).listen(port,'127.0.0.1',()=>console.log('凝合: http://127.0.0.1:'+port+'   源文件版: http://127.0.0.1:'+port+'/source/'));
