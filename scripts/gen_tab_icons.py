#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成微信小程序 tab bar 图标（清爽风格）
- 81x81 RGBA PNG，4x 抗锯齿
- 正常态：#8e8e93（与 app.json color 一致）
- 选中态：#4a6cf7（与 theme.wxss --primary-color 一致）
风格：填充式、线条简洁、暗黑模式白底 tab bar 下可读
"""
import math
import os
from PIL import Image, ImageDraw

SIZE = 81           # 最终尺寸（微信推荐）
SCALE = 4           # 抗锯齿倍数
BIG = SIZE * SCALE  # 324

GRAY = (142, 142, 147, 255)    # #8e8e93
BLUE = (74, 108, 247, 255)     # #4a6cf7

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'miniprogram', 'images')


def new_canvas():
    return Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))


def finalize(img, path):
    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG')
    print('saved', path, os.path.getsize(path), 'bytes')


def draw_asset(color):
    """资产：三根递增柱状图（清爽、代表增长/资产）"""
    img = new_canvas()
    d = ImageDraw.Draw(img)
    base_y = BIG - 14 * SCALE
    bar_w = 14 * SCALE
    gap = 8 * SCALE
    heights = [18, 26, 38]  # 递增
    heights = [h * SCALE for h in heights]
    total_w = 3 * bar_w + 2 * gap
    start_x = (BIG - total_w) // 2
    for i, h in enumerate(heights):
        x = start_x + i * (bar_w + gap)
        d.rounded_rectangle(
            [x, base_y - h, x + bar_w, base_y],
            radius=4 * SCALE, fill=color
        )
    return img


def draw_ai(color):
    """AI分析：四角星 sparkle（现代 AI 通用符号）+ 右上小星点缀"""
    img = new_canvas()
    d = ImageDraw.Draw(img)
    # 主 sparkle 居中偏左下
    cx = int(BIG * 0.44)
    cy = int(BIG * 0.56)
    r_outer = 26 * SCALE
    r_inner = 8 * SCALE
    pts = []
    for i in range(8):
        ang = math.radians(-90 + i * 45)
        r = r_outer if i % 2 == 0 else r_inner
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    d.polygon(pts, fill=color)
    # 小 sparkle 右上
    scx = int(BIG * 0.78)
    scy = int(BIG * 0.24)
    sr_outer = 11 * SCALE
    sr_inner = 3.5 * SCALE
    spts = []
    for i in range(8):
        ang = math.radians(-90 + i * 45)
        r = sr_outer if i % 2 == 0 else sr_inner
        spts.append((scx + r * math.cos(ang), scy + r * math.sin(ang)))
    d.polygon(spts, fill=color)
    return img


def draw_news(color):
    """资讯：文档+文字行"""
    img = new_canvas()
    d = ImageDraw.Draw(img)
    pad_x = 16 * SCALE
    pad_y = 12 * SCALE
    # 外框圆角矩形
    d.rounded_rectangle(
        [pad_x, pad_y, BIG - pad_x, BIG - pad_y],
        radius=8 * SCALE, outline=color, width=5 * SCALE
    )
    # 文字行
    line_x1 = pad_x + 10 * SCALE
    line_x2 = BIG - pad_x - 10 * SCALE
    line_w = 4 * SCALE
    y = pad_y + 16 * SCALE
    for i in range(3):
        # 第三行短一点，像标题/段落
        x2 = line_x2 if i < 2 else line_x2 - 14 * SCALE
        d.line([line_x1, y, x2, y], fill=color, width=line_w)
        y += 12 * SCALE
    return img


def draw_profile(color):
    """我的：人物剪影（头+肩）"""
    img = new_canvas()
    d = ImageDraw.Draw(img)
    cx = BIG // 2
    # 头
    head_r = 13 * SCALE
    head_cy = 24 * SCALE
    d.ellipse(
        [cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r],
        fill=color
    )
    # 肩（椭圆上半部分 = chord 180-360）
    sh_w = 26 * SCALE
    sh_top = 46 * SCALE
    d.chord(
        [cx - sh_w, sh_top, cx + sh_w, sh_top + 2 * sh_w],
        start=180, end=360, fill=color
    )
    return img


ICON_BUILDERS = [
    ('tab_asset', draw_asset),
    ('tab_ai', draw_ai),
    ('tab_news', draw_news),
    ('tab_profile', draw_profile),
]


def main():
    for name, builder in ICON_BUILDERS:
        normal = builder(GRAY)
        active = builder(BLUE)
        finalize(normal, os.path.join(OUT_DIR, name + '.png'))
        finalize(active, os.path.join(OUT_DIR, name + '_active.png'))
    print('done.')


if __name__ == '__main__':
    main()
