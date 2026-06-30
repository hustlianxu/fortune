#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 10 个 LLM Provider 的官方风格图标（正常 + active = 20 张 PNG）
- 96x96 RGBA
- 正常态：品牌色填充圆角方块 + 白色粗体字母
- 激活态：品牌色填充 + 白色描边环 + 白色字母（表示选中）
字体使用 DejaVu Sans Bold（系统自带，无中文字体故用英文字母）
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'miniprogram', 'images', 'providers')
SIZE = 96                  # 画布尺寸
RADIUS = 22                # 圆角半径
FONT_SIZE = 52             # 字母字号
RING_WIDTH = 4             # 激活态外环宽度

# 尝试加载粗体字体
def load_font(size):
    candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

FONT = load_font(FONT_SIZE)

# Provider 官方品牌色 + 字母标识
PROVIDERS = [
    # key, brand_color, letter
    ('deepseek', '#4D6BFE', 'D'),   # DeepSeek 蓝
    ('qwen',     '#615CED', 'Q'),   # 通义千问 紫
    ('glm',      '#3859F5', 'Z'),   # 智谱 GLM 蓝
    ('kimi',     '#1A1A1A', 'K'),   # 月之暗面 Kimi 黑
    ('chatgpt',  '#10A37F', 'G'),   # OpenAI 绿
    ('claude',   '#D97757', 'C'),   # Anthropic Claude 橙棕
    ('bailian',  '#FF6A00', 'B'),   # 阿里百炼 橙
    ('mimo',     '#FF6900', 'M'),   # 小米 MiMo 橙
    ('minimax',  '#5B5BD6', 'X'),   # MiniMax 紫蓝
    ('custom',   '#6B7280', '+'),   # 自定义 灰
]

def hex_to_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def rounded_rectangle(draw, box, radius, fill):
    """兼容老版本 Pillow 的圆角矩形绘制"""
    try:
        draw.rounded_rectangle(box, radius=radius, fill=fill)
    except AttributeError:
        x0, y0, x1, y1 = box
        r = radius
        draw.rectangle([x0+r, y0, x1-r, y1], fill=fill)
        draw.rectangle([x0, y0+r, x1, y1-r], fill=fill)
        draw.pieslice([x0, y0, x0+2*r, y0+2*r], 180, 270, fill=fill)
        draw.pieslice([x1-2*r, y0, x1, y0+2*r], 270, 360, fill=fill)
        draw.pieslice([x0, y1-2*r, x0+2*r, y1], 90, 180, fill=fill)
        draw.pieslice([x1-2*r, y1-2*r, x1, y1], 0, 90, fill=fill)

def draw_centered_text(img, text, font, color):
    """在图片中心绘制文本"""
    draw = ImageDraw.Draw(img)
    # 使用 textbbox 获取精确尺寸（兼容性回退）
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        tx = (SIZE - tw) / 2 - bbox[0]
        ty = (SIZE - th) / 2 - bbox[1]
    except AttributeError:
        tw, th = draw.textsize(text, font=font)
        tx = (SIZE - tw) / 2
        ty = (SIZE - th) / 2
    draw.text((tx, ty), text, font=font, fill=color)

def make_normal(brand_hex, letter):
    """正常态：品牌色圆角方块 + 白色字母"""
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    brand = hex_to_rgb(brand_hex)
    rounded_rectangle(draw, (0, 0, SIZE-1, SIZE-1), RADIUS, fill=brand + (255,))
    draw_centered_text(img, letter, FONT, (255, 255, 255, 255))
    return img

def make_active(brand_hex, letter):
    """激活态：品牌色圆角方块 + 白色描边环 + 白色字母（表示选中）"""
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    brand = hex_to_rgb(brand_hex)
    # 外层白色光晕（略大）
    pad = RING_WIDTH
    rounded_rectangle(draw, (-pad, -pad, SIZE-1+pad, SIZE-1+pad), RADIUS + pad, fill=(255, 255, 255, 255))
    # 内层品牌色
    rounded_rectangle(draw, (0, 0, SIZE-1, SIZE-1), RADIUS, fill=brand + (255,))
    draw_centered_text(img, letter, FONT, (255, 255, 255, 255))
    return img

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for key, color, letter in PROVIDERS:
        normal = make_normal(color, letter)
        active = make_active(color, letter)
        normal_path = os.path.join(OUT_DIR, f'provider_{key}.png')
        active_path = os.path.join(OUT_DIR, f'provider_{key}_active.png')
        normal.save(normal_path, 'PNG')
        active.save(active_path, 'PNG')
        print(f'  ✓ {key}: {os.path.basename(normal_path)}, {os.path.basename(active_path)}')
    print(f'\n完成：{len(PROVIDERS)} 个 provider，共 {len(PROVIDERS)*2} 张图标')

if __name__ == '__main__':
    main()
