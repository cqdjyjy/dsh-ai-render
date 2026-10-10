# -*- coding: utf-8 -*-
"""一次性生成 pngzip.mjs 所需的 PNG fixture（生成后已入库，测试本身不依赖 Python）。

用法：
  python tests/make-pngzip-fixtures.py
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, 'fixtures')
OUT = os.path.join(HERE, 'out')
os.makedirs(FIX, exist_ok=True)

# 1. 全黑 PNG：直接复制真实产物，保持逐像素 RGB(0,0,0)
src = r'D:\Documents\deepseek-harness\default-workspace\tools\test\out_small_x4.png'
im = Image.open(src)
print('source out_small_x4.png:', im.size, im.mode)
px = im.convert('RGB').getdata()
lo = min(min(p) for p in px)
hi = max(max(p) for p in px)
print('  通道范围:', lo, hi)
assert im.size == (1600, 1068), im.size
assert lo == 0 and hi == 0, (lo, hi)
im.save(os.path.join(FIX, 'blank-black.png'))

# 2. 渐变：宽 256、高 96，R 随列 0..255，G/B 随行 0..255
#    三个通道均值都约 127.5，整图均值也约 127.5，便于断言
g = Image.new('RGB', (256, 96))
gp = g.load()
for y in range(96):
    for x in range(256):
        gp[x, y] = (x, y * 255 // 95, y * 255 // 95)
g.save(os.path.join(FIX, 'pngzip-gradient.png'))

# 3. RGBA：16x16，alpha 渐变，RGB 覆盖 0/255
rgba = Image.new('RGBA', (16, 16))
rp = rgba.load()
for y in range(16):
    for x in range(16):
        rp[x, y] = (x * 17, y * 17, 128, 255 - x * 8)
rgba.save(os.path.join(FIX, 'pngzip-rgba.png'))

# 4. 调色板：32x32，整幅填充索引 1 → RGB(128,128,128)
#    色板只给两个颜色（0 黑、1 中灰），这样 Pillow 不会把色板重排成「实际用到的颜色」
#    bits=8 必须显式指定：只有两个颜色时 Pillow 默认存成 1 位，本模块只支持 8 位
pal = Image.new('P', (32, 32), 1)
pal.putpalette([0, 0, 0, 128, 128, 128])
pal.save(os.path.join(FIX, 'pngzip-palette.png'), bits=8)

# 5. 顺手打印 out/ 里的真实渲染图尺寸，供手工核对
for name in sorted(os.listdir(OUT)):
    if not name.lower().endswith('.png'):
        continue
    p = os.path.join(OUT, name)
    if os.path.getsize(p) < 1000:
        continue
    with Image.open(p) as im2:
        print('  out/%s' % name, im2.size, im2.mode)

print('done ->', FIX)
