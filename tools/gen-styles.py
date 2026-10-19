#!/usr/bin/env python3
"""校验并规范化主题数据文件 www/js/styles.js。

styles.js 本身是权威数据源（含中文主题名、28 个主题、UI_KEYS）。
本脚本不再依赖已删除的 docs/original-spec.md，也不会用英文 ID 重建主题名：
  1. 读取 styles.js，解析 SB.STYLES 与 SB.UI_KEYS；
  2. 校验主题数量、字段完整性、id 唯一、颜色格式、配色/UI 数组；
  3. 以规范格式重新写回 styles.js（保留中文 name 与所有字段）；
  4. 幂等检查：重新生成后再解析，深比较必须与原数据一致。
"""
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
target = root / 'www' / 'js' / 'styles.js'

HEADER = (
    '/* 主题数据（权威文件，可手工维护）。tools/gen-styles.py 会校验本文件的\n'
    '   28 个主题与字段完整性，并以规范格式重新写回；重复运行结果保持一致。 */\n'
)

REQUIRED = ['id', 'name', 'free', 'light', 'bg', 'structure', 'oob', 'recess',
            'fill', 'special', 'danger', 'marker', 'label', 'palette', 'ui']
COLOR_FIELDS = ['bg', 'structure', 'oob', 'recess', 'fill', 'special',
                'danger', 'marker', 'label']
HEX = re.compile(r'#[0-9A-Fa-f]{6}')


def extract(text, marker):
    """从 marker 之后提取第一个平衡的 [..] 或 {..}，返回 (jsonValue, endIndex)。"""
    i = text.index(marker) + len(marker)
    while text[i] not in '[{':
        i += 1
    open_c = text[i]
    close_c = ']' if open_c == '[' else '}'
    depth = 0
    j = i
    in_str = False
    esc = False
    while j < len(text):
        ch = text[j]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == open_c:
                depth += 1
            elif ch == close_c:
                depth -= 1
                if depth == 0:
                    break
        j += 1
    return json.loads(text[i:j + 1]), j


def validate(styles, ui_keys):
    problems = []
    if not isinstance(ui_keys, list) or len(ui_keys) != 9:
        problems.append('UI_KEYS 必须是长度 9 的数组')
    if not isinstance(styles, list) or len(styles) != 28:
        problems.append(f'主题数必须为 28，实际 {len(styles) if isinstance(styles, list) else "非数组"}')
        if problems:
            return problems
    ids = [s.get('id') for s in styles]
    if len(set(ids)) != len(ids):
        problems.append('主题 id 存在重复')
    if ids[0] != 'dark_mode':
        problems.append('第一个主题必须是 dark_mode（默认）')
    for s in styles:
        sid = s.get('id', '<unknown>')
        for f in REQUIRED:
            if f not in s:
                problems.append(f'{sid} 缺少字段 {f}')
        if not isinstance(s.get('name'), str) or not s['name'].strip():
            problems.append(f'{sid} 的中文 name 缺失')
        if not isinstance(s.get('free'), bool) or not isinstance(s.get('light'), bool):
            problems.append(f'{sid} 的 free/light 必须为布尔值')
        for f in COLOR_FIELDS:
            if f in s and not HEX.fullmatch(str(s[f])):
                problems.append(f'{sid} 的 {f} 颜色非法: {s[f]}')
        pal = s.get('palette')
        if not isinstance(pal, list) or not pal:
            problems.append(f'{sid} 的 palette 必须是非空数组')
        else:
            for c in pal:
                if not HEX.fullmatch(str(c)):
                    problems.append(f'{sid} palette 颜色非法: {c}')
        ui = s.get('ui')
        if not isinstance(ui, list) or len(ui) != 9:
            problems.append(f'{sid} 的 ui 必须是长度 9 的数组')
        else:
            for c in ui:
                if not HEX.fullmatch(str(c)):
                    problems.append(f'{sid} ui 颜色非法: {c}')
    return problems


def render(styles, ui_keys):
    return (
        HEADER
        + '(function (SB) {\n'
        + "  'use strict';\n"
        + '  SB.STYLES = ' + json.dumps(styles, indent=1, ensure_ascii=False) + ';\n'
        + '  SB.UI_KEYS = ' + json.dumps(ui_keys, ensure_ascii=False) + ';\n'
        + '})(window.SB = window.SB || {});\n'
    )


def main():
    text = target.read_text(encoding='utf-8')
    styles, _ = extract(text, 'SB.STYLES')
    ui_keys, _ = extract(text, 'SB.UI_KEYS')

    problems = validate(styles, ui_keys)
    if problems:
        print('styles.js 校验失败：', file=sys.stderr)
        for p in problems:
            print('  - ' + p, file=sys.stderr)
        return 1

    new_text = render(styles, ui_keys)
    # 幂等：重新生成的内容再解析，必须与原数据深相等。
    styles2, _ = extract(new_text, 'SB.STYLES')
    keys2, _ = extract(new_text, 'SB.UI_KEYS')
    if styles2 != styles or keys2 != ui_keys:
        print('生成结果非幂等，已中止，未写回文件。', file=sys.stderr)
        return 1

    target.write_text(new_text, encoding='utf-8')
    print(f'{len(styles)} 个主题校验通过，styles.js 已规范化（幂等）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
