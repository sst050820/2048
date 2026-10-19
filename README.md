# 凝合 · 液态 2048

用鼠标或触屏发射柔软的数字球，让相同数字碰撞合成。球体会挤压、变形、回弹；当球堆同时顶满两侧保险杠并完成倒计时，一局结束。

本仓库保存当前游戏源码、可直接打开的独立 HTML、资源、测试和构建工具。详细玩法、物理实现和模块说明见 [游戏说明与代码架构](游戏说明与代码架构.md)。

## 直接游玩

下载仓库并解压，双击根目录的 **`凝合.html`** 或 **`index.html`**，即可在浏览器中游玩。两个文件内容相同，已内嵌脚本、样式和字体，无需安装开发依赖。

- 按住顶部待发球，朝希望发射的方向拖动，松开发射；拖动越远，力度越大。
- 相同数字合成更大的球；已经落入球堆的球不能重新发射。
- `P` / `Esc`：暂停；`M`：静音；`K`：切换已解锁主题；`L`：切换深浅模式。
- 进度保存在当前浏览器本地；更换浏览器、网址或清除站点数据后，不会自动同步。

## 本地开发

开发依赖要求 **Node.js 22 或更新版本**。

```sh
git clone https://github.com/sst050820/2048.git
cd 2048
npm ci
npm start
```

打开以下地址：

| 地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:4281/` | 根目录独立 HTML 成品 |
| `http://127.0.0.1:4281/source/` | `www/` 源文件版，修改源码后在这里调试 |

默认服务器只监听本机。更换端口可以使用 `npm start -- 4300`。

源文件版包含 Web App Manifest 和 Service Worker。PWA 安装和离线缓存需要通过 HTTPS 或 localhost 打开，首次打开并完成资源缓存后才能离线使用；双击独立 HTML 不会注册 PWA。若发布源文件版，应保留 `www/` 内全部资源及相对目录，并在修改缓存资源时更新 `www/sw.js` 的版本号。

## 构建与测试

```sh
# 将 www/ 打包，更新根目录两个独立 HTML
npm run build:single

# 规则、物理、存档、布局及本地服务器等 Node 测试
npm test

# 浏览器测试需要另外安装 Chromium
npx playwright install chromium
npm run test:e2e

# 一次运行 Node 和浏览器测试
node tests/run.js
```

`npm test` 仅执行 Node 测试，不包含浏览器测试。浏览器测试截图默认写入 `out/e2e/`，不纳入版本控制。请先修改 `www/` 源码，再构建 HTML，避免只修改成品导致下次构建覆盖改动。

## 目录

```text
www/
  index.html          源文件版入口
  js/                 物理、规则、渲染、声音、主题、成就与界面
  css/                样式
  fonts/              随游戏分发的字体及已有来源说明
  icons/              PWA / 应用图标
  manifest.webmanifest
  sw.js               离线缓存
tests/node/           Node 回归测试
tests/e2e/            Playwright 浏览器测试
tools/                本地服务器、构建、资源处理与性能工具
index.html            独立成品入口
凝合.html             同内容的中文文件名入口
capacitor.config.json iOS 封装配置
游戏说明与代码架构.md   详细玩法与架构
```

## 可选工具

- `npm run styles`：用 Python 3 校验并规范化主题数据；Windows 也可运行 `py tools/gen-styles.py`。
- `npm run icons`：用 Python 3 和 Pillow 重新生成图标。先运行 `python -m pip install Pillow`；Windows 可用 `py tools/make_icons.py`。
- `npm run build:upstream`：保留的打包入口，默认输出 `dist/soboscuba.html`；通常使用 `build:single` 即可。
- `node tools/build-soboscuba-benchmark.cjs`：生成性能采集页面，运行本地服务器后打开 `/benchmark.html`。工具名称沿用参考项目，实际打包的是本仓库当前源码。
- `node tools/soboscuba-verify.cjs <参考项目的www目录> <本项目的www目录> --report out/comparison.json`：与另行准备的参考源码对照；普通运行和构建不需要参考项目。

iOS 原生封装需要 macOS 和 Xcode。在相应环境安装依赖后，依次运行 `npm run ios:add`、`npm run ios:sync`、`npm run ios:open`。本仓库保留现有 Capacitor 配置，未包含生成的 Xcode 项目；正式发布前需设置自己的 App ID 与签名。

## 来源说明

游戏在用户提供的 Soboscuba 参考代码基础上持续修改；参考项目的 README 将其描述为对 [sobosuba](https://store.steampowered.com/app/1946560/sobosuba/) 的重现。本次整理保留了现有实现、资源和来源说明，未对整个项目新增统一开源许可证。

`souba_score.ttf` 和 `souba_text.otf` 的作者与 CC0 说明见 [SOUBA-FONTS.txt](www/fonts/SOUBA-FONTS.txt)。其他字体及第三方依赖保留各自的权利和许可；npm 依赖版本记录于 `package-lock.json`。
