'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),www=path.join(root,'www');
const files=['physics','mode','styles','render'],source=files.map(n=>fs.readFileSync(path.join(www,'js',n+'.js'),'utf8')).join('\n');
const hash=crypto.createHash('sha256').update(source).digest('hex');
const js=fs.readFileSync(path.join(__dirname,'soboscuba-browser-profile.js'),'utf8');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Soboscuba原生引擎性能</title>
<style>body{background:#17191c;color:#ddd;font:15px/1.5 system-ui;margin:20px}button,select{font:inherit;padding:8px;margin:6px}canvas{width:390px;height:600px;background:#000;float:left;margin-right:20px}pre{white-space:pre-wrap}textarea{width:100%;height:240px}</style>
<h1>Soboscuba原生物理与渲染 · 实际RAF记录</h1><p>直接运行未改动的参考物理、模式、配色、渲染。60Hz、4子步、每帧最多追4tick。无插值；仅停止时导出完整日志。宿主后台节流会单列，不能当作正常前台FPS。</p>
<select id="scene"><option value="pile40">40软体/约493子圆压力</option><option value="pile60">60软体压力</option><option value="shots">固定种子实际模式连射</option></select><button id="start">开始30秒记录</button><span id="status">未开始</span><div><canvas id="canvas"></canvas><pre id="stats">未开始</pre></div><textarea id="raw" hidden readonly></textarea>
<script>${source.replace(/<\/script/gi,'<\\/script')}</script><script>const ENGINE_HASH=${JSON.stringify(hash)};\n${js}</script></html>`;
fs.writeFileSync(path.join(__dirname,'soboscuba-benchmark.html'),html);console.log(JSON.stringify({hash,bytes:Buffer.byteLength(html)}));
