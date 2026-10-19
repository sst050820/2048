'use strict';
/*
 * 窗口状态持久化与“拔显示器后归位”保护。
 *
 * 纯计算函数（defaultBounds / intersect / clampBounds / chooseBounds / 校验）不依赖
 * electron，便于 tests/desktop 在纯 Node 下断言；只有 initialBounds / track 在函数内
 * require electron，读取真实显示器与 userData 目录。
 *
 * 存储内容：x、y、width、height、isMaximized、isFullScreen。
 * 任何字段缺失、被外部改成非法值、或窗口位于已断开的显示器上，都安全回退到默认居中。
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 800;
const MIN_WIDTH = 420;
const MIN_HEIGHT = 560;
// 窗口必须至少有这么大一块（标题栏区域）留在某个屏幕内，否则视为“被移出可见范围”。
const VISIBLE_W = 120;
const VISIBLE_H = 48;

const STATE_KEYS = ['x', 'y', 'width', 'height'];
const NUM_FIELDS = ['x', 'y', 'width', 'height'];

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 相对工作区计算默认尺寸并居中（不超过工作区）。 */
function defaultBounds(workArea) {
  const width = Math.min(DEFAULT_WIDTH, workArea.width);
  const height = Math.min(DEFAULT_HEIGHT, workArea.height);
  return {
    width: Math.round(width),
    height: Math.round(height),
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

/** 两个矩形的交集面积（无交集返回 0）。 */
function intersectArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 判断状态对象是否结构完整（四个坐标都是有限数）。 */
function isWellFormed(state) {
  if (!state || typeof state !== 'object') return false;
  if (!isFiniteNum(state.width) || !isFiniteNum(state.height)) return false;
  if (state.width < MIN_WIDTH || state.height < MIN_HEIGHT) return false;
  return true;
}

/**
 * 把一个结构完整的窗口状态钳制进指定工作区：
 * 尺寸不超出工作区，位置保证至少有 VISIBLE_W × VISIBLE_H 区域可见。
 */
function clampBounds(state, workArea) {
  const width = Math.round(Math.min(Math.max(state.width, MIN_WIDTH), workArea.width));
  const height = Math.round(Math.min(Math.max(state.height, MIN_HEIGHT), workArea.height));

  let x = isFiniteNum(state.x) ? state.x : workArea.x + (workArea.width - width) / 2;
  let y = isFiniteNum(state.y) ? state.y : workArea.y + (workArea.height - height) / 2;

  // 保证窗口在右侧 / 下侧仍至少露出标题栏的一块。
  x = Math.min(x, workArea.x + workArea.width - VISIBLE_W);
  x = Math.max(x, workArea.x + VISIBLE_W - width);
  y = Math.min(y, workArea.y + workArea.height - VISIBLE_H);
  y = Math.max(y, workArea.y + VISIBLE_H - height);

  return { width, height, x: Math.round(x), y: Math.round(y) };
}

/**
 * 依据所有显示器工作区，选择最终窗口位置。
 * - 状态结构非法 → 主工作区默认居中；
 * - 与任意工作区交集足够大 → 钳制到交集最大的那块；
 * - 否则（窗口在已拔掉的屏幕上）→ 主工作区默认居中。
 */
function chooseBounds(state, workAreas, primary) {
  if (!isWellFormed(state)) return defaultBounds(primary);
  const rect = { x: state.x, y: state.y, width: state.width, height: state.height };
  let best = null;
  for (const wa of workAreas) {
    const area = intersectArea(rect, wa);
    if (!best || area > best.area) best = { area, wa };
  }
  if (!best || best.area < VISIBLE_W * VISIBLE_H) return defaultBounds(primary);
  return clampBounds(state, best.wa);
}

/** 读取持久化状态；文件缺失或内容损坏一律返回 null（不抛异常）。 */
function readState(file, fsImpl) {
  const f = fsImpl || fs;
  try {
    const raw = f.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null;
  }
}

/** 原子写状态（先写临时文件再 rename，避免写一半损坏）。 */
function writeState(file, state, fsImpl) {
  const f = fsImpl || fs;
  try {
    const tmp = file + '.tmp';
    f.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    f.renameSync(tmp, file);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 启动时计算初始窗口位置（electron 环境）。
 * 非 electron 环境（纯 Node 测试）不应调用本函数。
 */
function initialBounds() {
  const electron = require('electron');
  const { app, screen } = electron;
  const file = path.join(app.getPath('userData'), 'window-state.json');
  const state = readState(file);
  const displays = screen.getAllDisplays();
  const workAreas = displays.map(d => d.workArea);
  const primary = screen.getPrimaryDisplay().workArea;
  const bounds = chooseBounds(state, workAreas, primary);
  return {
    ...bounds,
    isMaximized: !!(state && state.isMaximized),
    isFullScreen: false,
    stateFile: file,
  };
}

/**
 * 绑定窗口：在移动/缩放/最大化、关闭时持久化状态；显示器变化时重新归位。
 * 返回一个 save() 便于主动保存。
 */
function track(win, stateFile) {
  const electron = require('electron');
  const { screen } = electron;

  const save = () => {
    if (!win || win.isDestroyed()) return;
    const isMaximized = win.isMaximized();
    const isFullScreen = win.isFullScreen();
    // 最大化/全屏时不把“铺满”的坐标当作正常尺寸存盘，仍记录恢复前的正常框。
    const bounds = isMaximized || isFullScreen ? win.getNormalBounds() : win.getBounds();
    writeState(stateFile, { ...bounds, isMaximized, isFullScreen });
  };

  // 延迟合并保存，避免拖动时高频写盘。
  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 300);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', save);

  // 显示器布局变化（拔插/分辨率变化）后若窗口跑到不可见区域，移回主屏幕。
  screen.on('display-removed', () => {
    if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
    const primary = screen.getPrimaryDisplay().workArea;
    const next = clampBounds(win.getBounds(), primary);
    win.setBounds(next);
  });

  return { save };
}

module.exports = {
  MIN_WIDTH,
  MIN_HEIGHT,
  defaultBounds,
  intersectArea,
  isWellFormed,
  clampBounds,
  chooseBounds,
  readState,
  writeState,
  initialBounds,
  track,
};
