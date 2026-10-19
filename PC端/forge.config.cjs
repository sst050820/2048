'use strict';
/*
 * Electron Forge 打包配置（Windows 免安装 ZIP）。
 *
 * 目标：npm run desktop:make 后，在源码外的 2048-构建产物/PC端/make/ 产出 ZIP，
 * 解压即可双击 凝合.exe 离线运行，不依赖 Node.js 或任何开发环境。
 *
 * 桌面运行时零第三方 npm 依赖：主进程只 require Node/Electron 内置模块与
 * desktop/*.cjs，游戏是 www/ 下的纯静态资源，因此打包白名单只保留
 * desktop、www 与清单文件，node_modules 全部排除。
 */
const path = require('path');
const { MakerZIP } = require('@electron-forge/maker-zip');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// 打包白名单：只保留桌面外壳、游戏静态资源与清单；其余（tests/tools/docs/
// out/node_modules/移动端配置/网页版单文件等）一律不进运行目录。
function includeOnlyGame(p) {
  if (p === '') return false;
  if (p === '/package.json' || p === '/package-lock.json') return false;
  if (p === '/desktop' || p.startsWith('/desktop/')) return false;
  if (p === '/www' || p.startsWith('/www/')) return false;
  return true; // 其他全部排除
}

module.exports = {
  // 构建产物放在源码目录外，保持两个版本目录只存源码。
  outDir: path.resolve(__dirname, '..', '..', '2048-构建产物', 'PC端'),
  packagerConfig: {
    name: '凝合',
    productName: '凝合',
    executableName: '凝合',
    asar: true,
    icon: path.resolve(__dirname, 'desktop', 'assets', 'icon.ico'),
    ignore: includeOnlyGame,
    win32metadata: {
      ProductName: '凝合',
      FileDescription: '凝合 · 果冻软球合成游戏',
      CompanyName: 'Ninghe',
      OriginalFilename: '凝合.exe',
      InternalName: '凝合',
      Language: '0x0804', // 简体中文
    },
  },
  rebuildConfig: {},
  makers: [
    // 仅生成免安装 ZIP（Windows x64），不做安装器。
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    // 关闭调试/Node 注入等通道，收紧可执行文件的攻击面。
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};
