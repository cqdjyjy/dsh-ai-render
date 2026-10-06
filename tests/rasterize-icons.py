"""把 dump-icons.mjs 导出的示意图画成一张对照图，便于人眼检查。

只支持本项目用到的几种图元：rect / line / circle / polygon / path(M,L,C)。
不是通用 SVG 渲染器，够用即可。
"""
import json
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "out", "icons.json")
DST = os.path.join(HERE, "out", "icons-sheet.png")

VB = (56.0, 40.0)
CELL = (150, 118)      # 每个示意图的格子
COLS = 7

PALETTE = {
    "currentColor": "#4a5568",
}


def resolve(color, default="#4a5568"):
    if color is None or color == "none" or color == "":
        return None
    if color == "currentColor":
        return default
    return color


def alpha(color, opacity):
    """把不透明度折算成与白底的混色（Pillow 不支持逐图元 alpha 很方便）。"""
    if not color or opacity is None:
        return color
    try:
        o = float(opacity)
    except (TypeError, ValueError):
        return color
    if o >= 1:
        return color
    if not color.startswith("#") or len(color) != 7:
        return color
    r, g, b = (int(color[i : i + 2], 16) for i in (1, 3, 5))
    r = int(r * o + 255 * (1 - o))
    g = int(g * o + 255 * (1 - o))
    b = int(b * o + 255 * (1 - o))
    return f"#{r:02x}{g:02x}{b:02x}"


def sx(v):
    return float(v) * CELL[0] / VB[0]


def sy(v):
    return float(v) * CELL[1] / VB[1]


def bezier(p0, p1, p2, p3, steps=18):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1]
        pts.append((sx(x), sy(y)))
    return pts


def draw_path(draw, d, color, width):
    tokens = re.findall(r"[MLC]|-?\d+(?:\.\d+)?", d)
    i = 0
    cur = None
    start = None
    while i < len(tokens):
        cmd = tokens[i]
        if cmd == "M":
            cur = (float(tokens[i + 1]), float(tokens[i + 2]))
            start = cur
            i += 3
        elif cmd == "L":
            nxt = (float(tokens[i + 1]), float(tokens[i + 2]))
            draw.line([(sx(cur[0]), sy(cur[1])), (sx(nxt[0]), sy(nxt[1]))], fill=color, width=width)
            cur = nxt
            i += 3
        elif cmd == "C":
            p1 = (float(tokens[i + 1]), float(tokens[i + 2]))
            p2 = (float(tokens[i + 3]), float(tokens[i + 4]))
            p3 = (float(tokens[i + 5]), float(tokens[i + 6]))
            draw.line(bezier(cur, p1, p2, p3), fill=color, width=width, joint="curve")
            cur = p3
            i += 7
        else:
            i += 1


def render(shapes):
    img = Image.new("RGB", CELL, "white")
    draw = ImageDraw.Draw(img)
    for s in shapes:
        p = s.get("props") or {}
        t = s.get("type")
        opacity = p.get("opacity")
        if t == "rect":
            box = [sx(p.get("x", 0)), sy(p.get("y", 0)), sx(float(p.get("x", 0)) + float(p.get("width", 0))), sy(float(p.get("y", 0)) + float(p.get("height", 0)))]
            fill = alpha(resolve(p.get("fill")), opacity)
            stroke = resolve(p.get("stroke"))
            r = p.get("rx")
            if r:
                draw.rounded_rectangle(box, radius=max(1, sx(r) / 2), fill=fill, outline=stroke, width=max(1, int(float(p.get("stroke-width", 1)))))
            else:
                draw.rectangle(box, fill=fill, outline=stroke, width=max(1, int(float(p.get("stroke-width", 1)))))
        elif t == "line":
            draw.line(
                [(sx(p.get("x1", 0)), sy(p.get("y1", 0))), (sx(p.get("x2", 0)), sy(p.get("y2", 0)))],
                fill=alpha(resolve(p.get("stroke")), opacity),
                width=max(1, int(round(float(p.get("stroke-width", 1))))),
            )
        elif t == "circle":
            box = [sx(float(p.get("cx", 0)) - float(p.get("r", 0))), sy(float(p.get("cy", 0)) - float(p.get("r", 0))),
                   sx(float(p.get("cx", 0)) + float(p.get("r", 0))), sy(float(p.get("cy", 0)) + float(p.get("r", 0)))]
            dash = p.get("stroke-dasharray")
            if dash:
                # 虚线圆：用多段弧近似
                draw.ellipse(box, outline=alpha(resolve(p.get("stroke")), opacity))
            else:
                draw.ellipse(box, fill=alpha(resolve(p.get("fill")), opacity), outline=resolve(p.get("stroke")))
        elif t == "polygon":
            pts = [float(v) for v in str(p.get("points", "")).replace(",", " ").split()]
            pairs = [(sx(pts[i]), sy(pts[i + 1])) for i in range(0, len(pts) - 1, 2)]
            draw.polygon(pairs, fill=alpha(resolve(p.get("fill")), opacity), outline=resolve(p.get("stroke")))
        elif t == "path":
            draw_path(draw, str(p.get("d", "")), alpha(resolve(p.get("stroke")), opacity), max(1, int(round(float(p.get("stroke-width", 1))))))
    return img


def main():
    groups = json.load(open(SRC, encoding="utf-8"))
    rows = []
    for group in groups:
        rows.append(("GROUP", group["label"]))
        for i in range(0, len(group["items"]), COLS):
            rows.append(("ITEMS", group["items"][i : i + COLS]))

    total_h = 0
    for kind, _ in rows:
        total_h += 24 if kind == "GROUP" else 132
    sheet = Image.new("RGB", (CELL[0] * COLS + 16, total_h + 16), "#fafafa")
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 15)
        small = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 13)
    except OSError:
        font = small = ImageFont.load_default()

    y = 8
    for kind, payload in rows:
        if kind == "GROUP":
            draw.text((8, y), payload, fill="#222222", font=font)
            y += 24
            continue
        x = 8
        for item in payload:
            cell = render(item["shapes"])
            sheet.paste(cell, (x, y))
            draw.rectangle([x, y, x + CELL[0] - 1, y + CELL[1] - 1], outline="#dddddd")
            draw.text((x + 4, y + CELL[1] - 18), item["name"][:12], fill="#333333", font=small)
            x += CELL[0]
        y += 132

    sheet.save(DST)
    print("写出:", DST, sheet.size)


main()
