"""生成测试用的假图：一张带尺寸标注的柜体 CAD 立面图 + 一张木纹参考图。

用法：python make-fixtures.py <输出目录>
"""
import os
import sys

from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(OUT, exist_ok=True)

W, H = 1600, 1000


def make_cad(path: str) -> None:
    image = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(image)

    left, top, right, bottom = 320, 140, 1320, 880
    draw.rectangle([left, top, right, bottom], outline="black", width=4)

    # 中竖分格 + 门板缝
    mid = (left + right) // 2
    draw.line([(mid, top), (mid, bottom)], fill="black", width=3)
    # 顶部吊柜与下方地柜分界
    split = top + 300
    draw.line([(left, split), (right, split)], fill="black", width=3)
    # 地柜门缝
    for x in (left + int((mid - left) / 2), mid + int((right - mid) / 2)):
        draw.line([(x, split), (x, bottom)], fill="black", width=2)
    # 开放格层板
    for i in range(1, 3):
        y = top + i * 100
        draw.line([(left, y), (mid, y)], fill="black", width=2)
    # 拉手
    draw.line([(mid - 40, split + 60), (mid - 40, split + 140)], fill="black", width=6)
    draw.line([(mid + 40, split + 60), (mid + 40, split + 140)], fill="black", width=6)

    # 尺寸线（专业施工图味道）
    def dim_h(y: int, x1: int, x2: int) -> None:
        draw.line([(x1, y), (x2, y)], fill="black", width=1)
        for x in (x1, x2):
            draw.line([(x, y - 8), (x, y + 8)], fill="black", width=1)
            draw.line([(x, y - 6), (x + 12, y), (x, y + 6)], fill="black", width=1)
        draw.text(((x1 + x2) // 2 - 18, y - 22), str(x2 - x1), fill="black")

    def dim_v(x: int, y1: int, y2: int) -> None:
        draw.line([(x, y1), (x, y2)], fill="black", width=1)
        for y in (y1, y2):
            draw.line([(x - 8, y), (x + 8, y)], fill="black", width=1)
        draw.text((x + 10, (y1 + y2) // 2 - 6), str(y2 - y1), fill="black")

    dim_h(top - 60, left, right)
    dim_h(bottom + 60, left, mid)
    dim_h(bottom + 60, mid, right)
    dim_v(left - 70, top, split)
    dim_v(left - 70, split, bottom)

    draw.text((left, 60), "CABINET ELEVATION  2400x2000", fill="black")
    draw.text((left, 80), "DO NOT SCALE  |  SECTION A-A  |  WOODWORK SHOP DRAWING", fill="black")
    image.save(path)


def make_reference(path: str) -> None:
    image = Image.new("RGB", (1200, 800), (238, 232, 220))
    draw = ImageDraw.Draw(image)
    # 木纹色块
    for i in range(0, 800, 6):
        shade = 120 + (i % 60)
        draw.line([(0, i), (1200, i)], fill=(shade + 40, shade, shade - 30))
    for i in range(0, 1200, 40):
        draw.line([(i, 0), (i + 6, 800)], fill=(96, 70, 48), width=2)
    # 哑光白面板
    draw.rectangle([80, 80, 520, 380], fill=(246, 244, 240), outline=(210, 206, 200), width=3)
    # 岩板台面
    draw.rectangle([80, 430, 1120, 560], fill=(72, 74, 78))
    # 黑色金属拉手
    for x in range(620, 1120, 220):
        draw.rectangle([x, 200, x + 16, 300], fill=(28, 28, 30))
    draw.text((92, 600), "REFERENCE: light oak veneer + matte white + dark stone top", fill=(50, 40, 30))
    image.save(path)


make_cad(os.path.join(OUT, "cad-elevation.png"))
make_reference(os.path.join(OUT, "reference.png"))
print("wrote:", os.path.join(OUT, "cad-elevation.png"))
print("wrote:", os.path.join(OUT, "reference.png"))
