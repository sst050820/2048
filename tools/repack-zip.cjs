'use strict';
/*
 * 把 Forge 目录版产物 out/<应用名>-win32-x64/ 重新打成“含顶层文件夹”的
 * 免安装 ZIP：解压后得到一个名为“凝合”的文件夹，里面才是 凝合.exe 与运行时，
 * 避免玩家直接拖拽解压时文件散落。
 *
 * 用系统自带的 .NET ZipFile（与 Forge 的 cross-zip 同一底层），不引入新依赖。
 * 顶层文件夹名取自 package.json 的 productName。
 *
 * 用法：npm run desktop:package 之后，node tools/repack-zip.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const appName = pkg.productName || pkg.name;
const version = pkg.version;

const winDir = path.join(root, 'out', `${appName}-win32-x64`);
const topName = appName; // ZIP 内顶层文件夹名
const makeDir = path.join(root, 'out', 'make');
const finalZip = path.join(makeDir, `${appName}-${version}-win64.zip`);
const staged = path.join(root, 'out', topName);

if (!fs.existsSync(winDir)) {
  console.error(`[repack] 未找到打包目录：${winDir}\n请先执行 npm run desktop:package。`);
  process.exit(1);
}

fs.mkdirSync(makeDir, { recursive: true });
if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true });
if (fs.existsSync(finalZip)) fs.rmSync(finalZip, { force: true });

// 同盘改名仅改目录项，瞬间完成；压缩后再改回 Forge 约定的目录名。
fs.renameSync(winDir, staged);
let ok = false;
try {
  const script =
    '& { param([string]$s,[string]$z) ' +
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    '[IO.Compression.ZipFile]::CreateFromDirectory($s,$z,[IO.Compression.CompressionLevel]::Optimal,$true) }';
  execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, '-s', staged, '-z', finalZip],
    { stdio: 'inherit' },
  );
  ok = true;
} finally {
  fs.renameSync(staged, winDir);
}

if (ok) {
  const sizeMB = (fs.statSync(finalZip).size / 1024 / 1024).toFixed(2);
  console.log(`[repack] 最终免安装 ZIP：${finalZip}（${sizeMB} MB，顶层文件夹“${topName}”）`);
}
