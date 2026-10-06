"""把 icon.svg 渲染成 PNG，便于人眼检查插件图标。

只支持这个图标用到的图元：rect / path(M,L,Z 绝对命令)。
不是通用 SVG 渲染器，够用即可。
"""
import os
import re
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "icon.svg")
DST = os.path.join(HERE, "out", "plugin-icon.png")
SCALE = 16  # 32px 的图标放大 16 倍来看清细节


def parse_attrs(tag):
    return {k: v for k, v in re.findall(r'([\w-]+)="([^"]*)"', tag)}


def color_of(value, default=None):
    if value in (None, "none", ""):
        return default
    return value


def main():
    svg = open(SRC, encoding="utf-8").read()
    size = 32
    px = size * SCALE
    img = Image.new("RGB", (px, px), "white")
    draw = ImageDraw.Draw(img)

    def s(v):
        return float(v) * SCALE

    # --- rect ---
    for tag in re.findall(r"<rect\b[^>]*>", svg):
        a = parse_attrs(tag)
        box = [s(a.get("x", 0)), s(a.get("y", 0)), s(float(a.get("x", 0)) + float(a.get("width", 0))), s(float(a.get("y", 0)) + float(a.get("height", 0)))]
        stroke = color_of(a.get("stroke"))
        fill = color_of(a.get("fill"))
        radius = s(a.get("rx", 0))
        if radius:
            draw.rounded_rectangle(box, radius=radius, outline=stroke, fill=fill, width=max(1, int(s(a.get("stroke-width", 1)))))
        else:
            draw.rectangle(box, outline=stroke, fill=fill, width=max(1, int(s(a.get("stroke-width", 1)))))

    # --- path ---
    for tag in re.findall(r"<path\b[^>]*>", svg):
        a = parse_attrs(tag)
        d = a.get("d", "")
        tokens = re.findall(r"[MLZmlz]|-?\d+(?:\.\d+)?", d)
        stroke = color_of(a.get("stroke"), "#C8A15A" if color_of(a.get("fill")) else None)
        fill = color_of(a.get("fill"))
        width = max(1, int(s(a.get("stroke-width", 1))))
        pts = []
        closed = False
        i = 0
        while i < len(tokens):
            t = tokens[i]
            if t in "Mm":
                pts.append((s(tokens[i + 1]), s(tokens[i + 2])))
                i += 3
            elif t in "Ll":
                pts.append((s(tokens[i + 1]), s(tokens[i + 2])))
                i += 3
            elif t in "Zz":
                closed = True
                i += 1
            else:
                i += 1
        if len(pts) >= 2:
            if closed and fill:
                draw.polygon(pts, fill=fill)
            if stroke:
                draw.line(pts + ([pts[0]] if closed else []), fill=stroke, width=width, joint="curve")

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    img.save(DST)
    print("写出:", DST, img.size)


main()
