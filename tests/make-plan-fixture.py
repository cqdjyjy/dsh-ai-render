"""造一张接近真实 CAD 出图的示意平面，用来验证「平面图 → 彩平图」。

比上一版更像真图纸：门窗用制图符号（门扇+开启弧线、窗横跨墙厚的平行细线）、
家具用可辨识的俯视符号（沙发有靠背扶手与坐垫分缝、床有枕头与被面翻折、
餐桌配带靠背的椅子、橱柜有台面出檐与门板分缝）。
"""
import math
import os
import sys

from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "fixtures"
os.makedirs(OUT, exist_ok=True)

W, H = 1000, 720
SCALE = 2  # 超采样再缩小，线条更干净
w, h = W * SCALE, H * SCALE
img = Image.new("RGB", (w, h), "white")
d = ImageDraw.Draw(img)

WALL = 14 * SCALE
THIN = 2 * SCALE
MID = 3 * SCALE


def line(*pts, width=THIN, fill="black"):
    d.line([(x, y) for x, y in pts], fill=fill, width=width)


def rect(box, width=THIN, fill=None):
    d.rectangle(box, outline=None if fill else "black", width=0 if fill else width, fill=fill)


def rounded(box, r=6 * SCALE, width=THIN):
    d.rounded_rectangle(box, radius=r, outline="black", width=width)


def circle(box, width=THIN):
    d.ellipse(box, outline="black", width=width)


def poly(pts, width=THIN):
    d.polygon(pts, outline="black", width=width)


S = SCALE
L, T, R, B = 60 * S, 60 * S, (W - 60) * S, (H - 60) * S

# ---------------------------------------------------------------- 墙体（实心）
d.rectangle([L, T, R, B], outline="black", width=WALL)
# 内部竖墙（中间留门洞 430~560）
d.line([(540 * S, T), (540 * S, 300 * S)], fill="black", width=WALL)
d.line([(540 * S, 420 * S), (540 * S, B)], fill="black", width=WALL)
# 左侧横墙
d.line([(L, 400 * S), (300 * S, 400 * S)], fill="black", width=WALL)
# 入户门洞（下外墙留口）
d.rectangle([(430 * S), B - WALL, (540 * S), B + WALL], fill="white")


def window(x0, x1, y):
    """窗：在墙厚范围内画 3 条平行细线。"""
    d.rectangle([x0, y - WALL // 2, x1, y + WALL // 2], fill="white")
    for offset in (-WALL // 3, 0, WALL // 3):
        line((x0, y + offset), (x1, y + offset))


def door_swing(hx, hy, length, start_deg, end_deg, leaf_deg):
    """平开门：门扇线 + 90° 开启弧线。hx,hy 是合页位置。"""
    rad = math.radians
    # 弧线
    d.arc(
        [hx - length, hy - length, hx + length, hy + length],
        start=start_deg,
        end=end_deg,
        fill="black",
        width=THIN,
    )
    # 门扇
    line((hx, hy), (hx + length * math.cos(rad(leaf_deg)), hy + length * math.sin(rad(leaf_deg))))

# 窗（上外墙两处）
window(170 * S, 350 * S, T)
window(660 * S, 880 * S, T)
# 中间竖墙的门洞：一扇平开门
door_swing(540 * S, 300 * S, 120 * S, 0, 90, 0)

# ---------------------------------------------------------------- 厨房（左上）
rounded([(80 * S), (80 * S), (490 * S), (150 * S)])          # 下排橱柜
rounded([(80 * S), (80 * S), (150 * S), (360 * S)])          # 侧排橱柜
for x in range(150, 490, 92):                                 # 门板分缝
    line((x * S, 84 * S), (x * S, 146 * S))
line((80 * S, 152 * S), (490 * S, 152 * S), width=MID)        # 台面出檐
circle([(180 * S), (92 * S), (280 * S), (140 * S)])          # 水槽
rounded([(330 * S), (92 * S), (450 * S), (140 * S)])         # 灶台
for i in range(4):                                            # 灶眼
    cx = (355 + i % 2 * 60) * S
    cy = (105 + i // 2 * 22) * S
    circle([cx - 16 * S, cy - 16 * S, cx + 16 * S, cy + 16 * S])

# ---------------------------------------------------------------- 餐厅（左下）
cx, cy, r = 190 * S, 500 * S, 78 * S
circle([cx - r, cy - r, cx + r, cy + r])
circle([cx - r + 12 * S, cy - r + 12 * S, cx + r - 12 * S, cy + r - 12 * S])
for angle in (0, 90, 180, 270):
    a = math.radians(angle)
    px, py = cx + math.cos(a) * (r + 46 * S), cy + math.sin(a) * (r + 46 * S)
    box = [px - 30 * S, py - 30 * S, px + 30 * S, py + 30 * S]
    rounded(box, r=4 * S)
    # 椅背：朝外的一条加粗短线
    bx0, by0 = cx + math.cos(a) * (r + 74 * S), cy + math.sin(a) * (r + 74 * S)
    bx1, by1 = px, py
    line((bx0, by0), (bx1, by1), width=MID)

# ---------------------------------------------------------------- 客厅（右下）
sw = [600 * S, 330 * S, 930 * S, 400 * S]
rounded(sw, r=10 * S)                                        # 沙发主体
line((604 * S, 346 * S), (926 * S, 346 * S), width=MID)      # 靠背带
rounded([600 * S, 330 * S, 622 * S, 400 * S], r=5 * S)       # 左扶手
rounded([908 * S, 330 * S, 930 * S, 400 * S], r=5 * S)       # 右扶手
for x in (708, 816):                                         # 坐垫分缝
    line((x * S, 350 * S), (x * S, 396 * S))
rounded([620 * S, 420 * S, 900 * S, 520 * S], r=4 * S)       # 地毯
rounded([690 * S, 440 * S, 830 * S, 500 * S], r=8 * S)       # 茶几
rounded([600 * S, 590 * S, 930 * S, 640 * S], r=4 * S)       # 电视柜
line((770 * S, 594 * S), (770 * S, 636 * S))                 # 柜门分缝

# ---------------------------------------------------------------- 卧室（右上）
bed = [580 * S, 90 * S, 880 * S, 290 * S]
rounded(bed, r=10 * S)
line((584 * S, 150 * S), (876 * S, 150 * S), width=MID)      # 被面翻折线
rounded([600 * S, 100 * S, 700 * S, 140 * S], r=8 * S)       # 枕头 1
rounded([720 * S, 100 * S, 820 * S, 140 * S], r=8 * S)       # 枕头 2
rounded([890 * S, 100 * S, 940 * S, 145 * S], r=4 * S)       # 床头柜
rounded([890 * S, 175 * S, 940 * S, 220 * S], r=4 * S)       # 床头柜

# ---------------------------------------------------------------- 卫生间（左中）
rounded([90 * S, 430 * S, 150 * S, 520 * S], r=6 * S)        # 马桶水箱
circle([(90 * S), (500 * S), (150 * S), (560 * S)])          # 马桶
rounded([200 * S, 430 * S, 300 * S, 490 * S], r=6 * S)       # 台盆
circle([(220 * S), (445 * S), (280 * S), (478 * S)])

# 绿植点缀
for px, py, rr in ((560, 380, 18), (150, 620, 20), (960, 300, 16)):
    pts = []
    for i in range(16):
        a = math.radians(i * 22.5)
        rad_ = rr * S * (0.62 if i % 2 else 1.0)
        pts.append((px * S + math.cos(a) * rad_, py * S + math.sin(a) * rad_))
    poly(pts)

img = img.resize((W, H), Image.LANCZOS)
img.save(os.path.join(OUT, "plan-demo.png"))
print("写出:", os.path.join(OUT, "plan-demo.png"), img.size)
