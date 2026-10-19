#!/usr/bin/env node
// 从 www/icons/icon-1024.png 生成多尺寸 Windows 图标 desktop/assets/icon.ico。
// jimp 负责高质量缩放，png-to-ico 负责把多个 PNG 打包成一个 ICO（Vista 及以上支持 PNG 压缩）。
// 用法：node tools/make-icon.cjs
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');

const SRC = path.join(__dirname, '..', 'www', 'icons', 'icon-1024.png');
const OUT_DIR = path.join(__dirname, '..', 'desktop', 'assets');
const OUT = path.join(OUT_DIR, 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  const src = await Jimp.read(SRC);
  const pngs = [];
  for (const size of SIZES) {
    const img = src.clone().resize({ w: size, h: size });
    pngs.push(await img.getBuffer('image/png'));
  }
  // png-to-ico 是 ESM 包，在 CommonJS 里用动态 import。
  const mod = await import('png-to-ico');
  const pngToIco = typeof mod.default === 'function' ? mod.default : mod;
  const ico = await pngToIco(pngs);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, ico);
  console.log('已生成 ' + OUT + '，尺寸 ' + SIZES.join('/') + '，共 ' + ico.length + ' 字节');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
