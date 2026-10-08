#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Civitas-AI 应用图标生成脚本（可重复运行）

设计口径（与 assets/README.md 的主题一致：城邦 / 智能体 / 社会协作）：
  - 深色底 #11111b（圆角方块，透明角）上绘制紫色 #8b5cf6 的几何图形；
  - 主体是 3x3 的"街区网格"（抽象城邦），中心是一颗亮点（抽象智能体节点）；
  - 不使用任何文字/字体，避免字体依赖，并保证 16x16 下仍可辨认。

实现要点：
  - 每个目标尺寸都按 4 倍超采样绘制后再 LANCZOS 缩小，避免小尺寸糊成一团；
  - 小于 32px 时自动简化（去掉角落街区，只保留十字街区 + 中心亮点），
    这是图标设计的常规做法：小尺寸优先"可辨认"而不是"细节全都要"。

用法：
    python Scripts/genIcons.py                 # 生成 assets/icon.ico + assets/icon.png + 预览图
    python Scripts/genIcons.py --preview-only  # 只生成预览图
    python Scripts/genIcons.py --out-dir Foo   # 自定义输出目录

产出：
    assets/icon.ico   多尺寸 Windows 图标（16/24/32/48/64/128/256）
    assets/icon.png   512x512 通用图标（透明角）
    .tmp/icon-preview.png  人工检查用的预览拼图（已被 .gitignore 忽略）
"""

from __future__ import annotations

import argparse
import os
import sys

# Windows 中文环境的控制台默认编码是 GBK，直接打印 emoji 会抛 UnicodeEncodeError。
# 这里统一把标准输出切到 UTF-8（errors="replace" 兜底），保证脚本在任何终端都不因编码失败。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):  # pragma: no cover - 老版本 Python / 被重定向
        pass

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover - 环境缺失时给出可操作提示
    sys.stderr.write(
        "❌ 缺少 Pillow。请先安装：python -m pip install Pillow\n"
    )
    sys.exit(1)

# ===== 主题色（与 Client 端设计变量保持同一族） =====
BG = (17, 17, 27, 255)          # #11111b 深色底
BG_EDGE = (43, 35, 64, 255)     # #2b2340 描边（大尺寸下才可见）
PURPLE = (139, 92, 246, 255)    # #8b5cf6 主紫
PURPLE_DIM = (124, 79, 224, 255)  # 角落街区略暗，制造层次
GLOW = (167, 139, 250, 160)     # #a78bfa 半透明光晕
BRIGHT = (245, 243, 255, 255)   # #f5f3ff 亮点（近似白，小尺寸下对比最高）

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
PNG_SIZE = 512
SUPERSAMPLE = 4  # 超采样倍数


def _rounded_square(
    draw: ImageDraw.ImageDraw,
    box: tuple[float, float, float, float],
    radius: float,
    fill: tuple[int, int, int, int],
    outline: tuple[int, int, int, int] | None = None,
    width: int = 1,
) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def render_icon(size: int) -> Image.Image:
    """绘制单个尺寸的图标（内部超采样后缩小）。"""
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # ---- 1. 深色圆角底 ----
    pad = s * 0.015
    _rounded_square(
        d,
        (pad, pad, s - pad, s - pad),
        radius=s * 0.215,
        fill=BG,
        outline=BG_EDGE,
        width=max(1, int(s * 0.008)),
    )

    # ---- 2. 3x3 街区网格 ----
    grid0 = s * 0.195
    grid1 = s * 0.805
    gap = s * 0.058
    cell = (grid1 - grid0 - 2 * gap) / 3.0
    radius = cell * 0.24
    simple = size < 32  # 小尺寸简化：只留十字街区

    for row in range(3):
        for col in range(3):
            if row == 1 and col == 1:
                continue  # 中心留给亮点
            # 小尺寸下只保留上/下/左/右四块，避免糊成一团
            if simple and row != 1 and col != 1:
                continue
            x0 = grid0 + col * (cell + gap)
            y0 = grid0 + row * (cell + gap)
            is_corner = row != 1 and col != 1
            fill = PURPLE_DIM if is_corner else PURPLE
            _rounded_square(d, (x0, y0, x0 + cell, y0 + cell), radius=radius, fill=fill)

    # ---- 3. 中心亮点（智能体节点）：光晕 + 实心核 ----
    cx = cy = s / 2.0
    glow_r = cell * 0.62
    d.ellipse((cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r), fill=GLOW)
    core_r = cell * (0.34 if not simple else 0.40)
    d.ellipse((cx - core_r, cy - core_r, cx + core_r, cy + core_r), fill=BRIGHT)

    return img.resize((size, size), Image.Resampling.LANCZOS)


def build_ico(out_path: str) -> None:
    """生成多尺寸 ICO；每个尺寸都用原生渲染结果，避免 Pillow 内部缩放损失。"""
    base = render_icon(256)
    frames = [render_icon(n) for n in ICO_SIZES if n != 256]
    base.save(
        out_path,
        format="ICO",
        sizes=[(n, n) for n in ICO_SIZES],
        append_images=frames,
    )


def build_png(out_path: str) -> None:
    render_icon(PNG_SIZE).save(out_path, format="PNG", optimize=True)


def build_preview(out_path: str, sizes: tuple[int, ...] = ICO_SIZES) -> None:
    """拼一张预览图：上排白底 / 下排深底，全部按真实像素渲染，右侧是 256 放大 2 倍。"""
    margin, gap = 16, 14
    row_h = max(sizes) + 2 * margin
    strip_w = sum(sizes) + gap * (len(sizes) + 1)
    zoom_size = 256 * 2
    width = strip_w + zoom_size + gap * 3
    height = row_h * 2 + gap * 3

    canvas = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    d = ImageDraw.Draw(canvas)
    # 下排深色底，检验深色主题下的对比
    d.rectangle((0, row_h + gap * 2, width, height), fill=(24, 24, 32, 255))

    for row in range(2):
        x = gap
        y = margin + row * (row_h + gap * 2)
        for n in sizes:
            icon = render_icon(n)
            canvas.alpha_composite(icon, (x, y + (max(sizes) - n) // 2))
            x += n + gap
        # 右侧放大图（仅第一排画一次即可，这里两排都画，便于对比底色）
        zoom = render_icon(256).resize((zoom_size, zoom_size), Image.Resampling.NEAREST)
        canvas.alpha_composite(zoom, (strip_w + gap * 2, y))

    canvas.convert("RGB").save(out_path, format="PNG", optimize=True)


def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    parser = argparse.ArgumentParser(description="生成 Civitas-AI 应用图标")
    parser.add_argument("--out-dir", default=os.path.join(root, "assets"), help="图标输出目录")
    parser.add_argument("--preview-only", action="store_true", help="只生成预览图")
    args = parser.parse_args()

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    ico_path = os.path.join(out_dir, "icon.ico")
    png_path = os.path.join(out_dir, "icon.png")

    preview_dir = os.path.join(root, ".tmp")
    os.makedirs(preview_dir, exist_ok=True)
    preview_path = os.path.join(preview_dir, "icon-preview.png")

    if not args.preview_only:
        build_ico(ico_path)
        build_png(png_path)
        print(f"✅ 已生成 {ico_path}（{os.path.getsize(ico_path)} 字节，尺寸 {list(ICO_SIZES)}）")
        print(f"✅ 已生成 {png_path}（{os.path.getsize(png_path)} 字节，{PNG_SIZE}x{PNG_SIZE}）")

    build_preview(preview_path)
    print(f"✅ 已生成预览图 {preview_path}（用图片查看器人工确认观感）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
