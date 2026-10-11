/**
 * 离线验证「本地层次增强」（tone.js）+ PNG 编解码往返。不联网、不需要显卡。
 *
 * 覆盖：
 *   1. 强度 0 = **一个字节都不改**（这是「纯超分 = 原样放大」的底线）
 *   2. 强度 > 0 确实提升层次（亮度标准差变大），且是确定性的
 *   3. 纯白保持纯白；纯黑会被提亮（这是「打开暗部」的必然代价，写明而不是假装没有）
 *   4. 色相不被带偏：等量增量加在 R/G/B 上，通道差保持不变
 *   5. 局部对比真的增强了（软边变得更快）
 *   6. 溢出（被推到纯黑/纯白）的比例有报告，且不许失控
 *   7. 参数不合法直接抛错（与「解码失败返回 null」是两种约定，别混）
 *   8. readPngPixels / encodePngRgb 往返一致；不支持的格式返回 null
 *   9. pngzip 解码器与 readPngPixels 对同一张图的 min/max 互相印证
 *
 * 用法：node tests/tone.mjs
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodePngRgb, readPngPixels, readPngStats } from '../pngzip.js'
import { TONE_LEVELS, enhanceTone } from '../tone.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')

let failures = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

/** 造一张 w×h 的 RGB 图，颜色由回调给。 */
function makeImage(width, height, pixel) {
  const data = Buffer.allocUnsafe(width * height * 3)
  let at = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      data[at] = r
      data[at + 1] = g
      data[at + 2] = b
      at += 3
    }
  }
  return data
}

// ---------------------------------------------------------- 1. 强度 0 必须原样

console.log('== 1. 强度 0 = 一个字节都不改 ==')
const flat = makeImage(64, 48, (x, y) => [100 + (x % 20), 110 + (y % 15), 120])
const off = enhanceTone({ width: 64, height: 48, data: flat, strength: 0 })
check(off.applied === false, '强度 0 时 applied=false')
check(Buffer.compare(off.data, flat) === 0, '强度 0 时数据与输入逐字节相同')
check(off.clippedRatio === 0, '强度 0 时溢出比例为 0')
check(off.before.std === off.after.std, '强度 0 时层次统计不变')

// ---------------------------------------------------------- 2. 提升层次且确定

console.log('\n== 2. 强度 > 0 提升局部层次，并且是确定性的 ==')
// 用一张「发灰发软」的合成图：中间调的平滑纹理 —— 这正是层次增强的目标场景。
// （CAD 线稿那种高对比图不是目标场景：提亮暗部反而会让全局标准差下降，见第 6 节。）
const softPhoto = makeImage(200, 150, (x, y) => {
  const base = 118 + 34 * Math.sin(x / 9.5) * Math.cos(y / 12.5) + 18 * Math.sin((x + y) / 23)
  const v = Math.max(0, Math.min(255, Math.round(base)))
  return [v, Math.round(v * 0.97), Math.round(v * 0.92)]
})
const softSize = { width: 200, height: 150 }

const mid = enhanceTone({ ...softSize, data: softPhoto, strength: 65 })
check(mid.applied === true, '强度 65 时 applied=true')
check(
  mid.detailEnergy.after > mid.detailEnergy.before,
  `局部层次（细节能量）变大：${mid.detailEnergy.before} → ${mid.detailEnergy.after}`,
)
check(mid.after.std > mid.before.std, `全局对比度也变大：${mid.before.std} → ${mid.after.std}`)
check(mid.blurRadius >= 2 && mid.blurRadius <= 80, `模糊半径在合理区间（${mid.blurRadius}）`)

const midAgain = enhanceTone({ ...softSize, data: softPhoto, strength: 65 })
check(Buffer.compare(mid.data, midAgain.data) === 0, '同样的输入两次结果完全一致（确定性）')

const strong = enhanceTone({ ...softSize, data: softPhoto, strength: 100 })
check(
  strong.detailEnergy.after > mid.detailEnergy.after,
  `强度越大层次越分明：65 → ${mid.detailEnergy.after}，100 → ${strong.detailEnergy.after}`,
)

// 真实 PNG 也要能跑通（不崩、有报告）
const photo = await fsp.readFile(path.join(fixtures, 'cad-elevation.png'))
const photoPixels = readPngPixels(photo)
check(Boolean(photoPixels), `真实 PNG 能解出像素（${photoPixels?.width}×${photoPixels?.height}）`)
const realRun = enhanceTone({
  width: photoPixels.width,
  height: photoPixels.height,
  data: photoPixels.data,
  strength: 65,
})
check(realRun.applied === true, '真实 PNG 上也能正常处理')
check(realRun.clippedRatio < 0.15, `真实 PNG 的溢出有界（${(realRun.clippedRatio * 100).toFixed(2)}%）`)

// ---------------------------------------------------------- 3. 端点行为

console.log('\n== 3. 纯白保持纯白；纯黑被提亮（打开暗部的必然代价）==')
const extremes = makeImage(16, 16, (x) => (x < 8 ? [255, 255, 255] : [0, 0, 0]))
const extOut = enhanceTone({ width: 16, height: 16, data: extremes, strength: 100 })
const whiteAfter = extOut.data[0]
const blackAt = 8 * 3
const blackAfter = extOut.data[blackAt]
check(whiteAfter === 255, `纯白仍然是 255（实际 ${whiteAfter}）`)
check(blackAfter > 0 && blackAfter < 40, `纯黑被提亮到 ${blackAfter}（打开暗部，代价是黑不再纯黑）`)
check(extOut.data[blackAt + 1] === blackAfter && extOut.data[blackAt + 2] === blackAfter, '灰阶保持中性（三通道一致）')

// ---------------------------------------------------------- 4. 色相不带偏

console.log('\n== 4. 色相不被带偏（等量增量）==')
const colored = makeImage(32, 32, () => [180, 90, 40])
const colorOut = enhanceTone({ width: 32, height: 32, data: colored, strength: 100 })
const before = [colored[0], colored[1], colored[2]]
const after = [colorOut.data[0], colorOut.data[1], colorOut.data[2]]
check(after[0] - after[1] === before[0] - before[1], `R-G 差保持不变（${before[0] - before[1]} → ${after[0] - after[1]}）`)
check(after[1] - after[2] === before[1] - before[2], `G-B 差保持不变（${before[1] - before[2]} → ${after[1] - after[2]}）`)

// ---------------------------------------------------------- 5. 局部对比

console.log('\n== 5. 局部对比真的增强（软边变快）==')
// 左半 80、右半 180 的软过渡（用渐变模拟"发灰发软"）
const soft = makeImage(80, 40, (x) => {
  const t = Math.max(0, Math.min(1, (x - 20) / 40))
  const v = Math.round(80 + 100 * (t * t * (3 - 2 * t)))
  return [v, v, v]
})
const softOut = enhanceTone({ width: 80, height: 40, data: soft, strength: 100 })
/** 中间一行的最大相邻差：过渡被拉陡了就变大。 */
const maxStep = (data, width, y) => {
  let best = 0
  const row = y * width * 3
  for (let x = 1; x < width; x += 1) {
    best = Math.max(best, Math.abs(data[row + x * 3] - data[row + (x - 1) * 3]))
  }
  return best
}
const stepBefore = maxStep(soft, 80, 20)
const stepAfter = maxStep(softOut.data, 80, 20)
check(stepAfter > stepBefore, `过渡被拉陡：最大相邻差 ${stepBefore} → ${stepAfter}`)

// ---------------------------------------------------------- 6. 溢出 + 硬边不留边

console.log('\n== 6. 溢出只算「新增」；硬边不留白边/黑边 ==')
// 溢出：CAD 线稿是大片纯白底 + 黑线。原本就是 255 的像素被边界拦住**不该**算溢出，
// 否则这张图会被报成「17% 溢出」，纯属吓人（这是实测踩到的）。
const cadStrong = enhanceTone({
  width: photoPixels.width,
  height: photoPixels.height,
  data: photoPixels.data,
  strength: 100,
})
check(cadStrong.applied === true, 'CAD 线稿上也能正常处理')
check(
  cadStrong.clippedRatio >= 0 && cadStrong.clippedRatio < 0.15,
  `CAD 图强度 100 的溢出 < 15%（${(cadStrong.clippedRatio * 100).toFixed(2)}%）`,
)
check(cadStrong.clippedRatio > 0, '强度 100 确实报告了溢出（不是 0 的假象）')
check(
  mid.clippedRatio <= strong.clippedRatio,
  `软图的溢出随强度单调：65 → ${(mid.clippedRatio * 100).toFixed(2)}%，100 → ${(strong.clippedRatio * 100).toFixed(2)}%`,
)

// 硬边：朴素的 unsharp mask 会在硬边两侧留下白边/黑边（亮侧更亮、暗侧更暗）。
// CAD 立面图全是硬边，一放大就成描边 —— 所以这里必须**按幅度加权**，
// 到 EDGE_GUARD 就完全不碰。用一条纯色台阶来量化「有没有留边」。
const stepW = 96
const stepH = 48
const stepImage = makeImage(stepW, stepH, (x) => (x < stepW / 2 ? [30, 30, 30] : [220, 220, 220]))
const stepOut = enhanceTone({ width: stepW, height: stepH, data: stepImage, strength: 100 })
const lumaAt = (data, index) => data[index * 3]
const darkRef = lumaAt(stepOut.data, 8)
const lightRef = lumaAt(stepOut.data, stepW - 8)
let maxHalo = 0
for (let y = 0; y < stepH; y += 1) {
  for (let x = 0; x < stepW; x += 1) {
    const value = lumaAt(stepOut.data, y * stepW + x)
    const reference = x < stepW / 2 ? darkRef : lightRef
    maxHalo = Math.max(maxHalo, Math.abs(value - reference))
  }
}
check(maxHalo <= 6, `硬边两侧最大偏差 ≤ 6/255（实际 ${maxHalo}）—— 没有明显白边/黑边`)
check(darkRef > 30, `暗部被打开（30 → ${darkRef}），这是「层次」的一部分`)
check(lightRef > 220, `亮部也略有提升（220 → ${lightRef}）`)

// 高对比线稿上提亮暗部会让「全局标准差」下降 —— 这不是 bug，是「打开暗部」的定义。
// 所以判断层次要看**局部细节能量**，不能只看 std。
// 反过来说，CAD 线稿也不是这个功能的目标场景（目标是发灰发软的效果图）。
console.log(
  `  note CAD 线稿：全局 std ${cadStrong.before.std} → ${cadStrong.after.std}（提亮暗部必然如此），` +
    `局部细节能量 ${cadStrong.detailEnergy.before} → ${cadStrong.detailEnergy.after}`,
)

// ---------------------------------------------------------- 7. 参数不合法要抛错

console.log('\n== 7. 参数不合法直接抛错（与解码的 null 约定不同）==')
const throws = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}
check(throws(() => enhanceTone({ width: 0, height: 10, data: Buffer.alloc(30), strength: 50 })), '宽度 0 抛错')
check(throws(() => enhanceTone({ width: 10, height: 10, data: Buffer.alloc(10), strength: 50 })), '像素数据不足抛错')
check(throws(() => encodePngRgb(0, 10, Buffer.alloc(30))), 'encodePngRgb 尺寸不合法抛错')
check(throws(() => encodePngRgb(4, 4, Buffer.alloc(10))), 'encodePngRgb 数据不足抛错')

// ---------------------------------------------------------- 8. 编解码往返

console.log('\n== 8. readPngPixels / encodePngRgb 往返一致 ==')
const round = readPngPixels(encodePngRgb(photoPixels.width, photoPixels.height, photoPixels.data))
check(Boolean(round), '自己编的 PNG 自己能解开')
check(
  round.width === photoPixels.width && round.height === photoPixels.height,
  `往返尺寸一致（${round?.width}×${round?.height}）`,
)
check(Buffer.compare(round.data, photoPixels.data) === 0, '往返像素逐字节一致')

// ---------------------------------------------------------- 9. 与解码器互相印证

console.log('\n== 9. readPngPixels 与 readPngStats 互相印证 ==')
for (const name of ['cad-elevation.png', 'pngzip-gradient.png', 'pngzip-rgba.png', 'pngzip-palette.png', 'blank-black.png']) {
  const buf = await fsp.readFile(path.join(fixtures, name))
  const stats = readPngStats(buf)
  const pixels = readPngPixels(buf)
  if (!stats || !pixels) {
    check(false, `${name}: 两个解码入口都应成功（stats=${Boolean(stats)} pixels=${Boolean(pixels)}）`)
    continue
  }
  let min = 255
  let max = 0
  for (let i = 0; i < pixels.data.length; i += 1) {
    const v = pixels.data[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  check(
    min === stats.min && max === stats.max && pixels.width === stats.width && pixels.height === stats.height,
    `${name}: 宽高与 min/max 一致（${pixels.width}×${pixels.height}，${min}~${max}）`,
  )
}

const unsupported = [Buffer.alloc(0), Buffer.from('not a png at all'), photo.subarray(0, 40)]
for (const [index, buf] of unsupported.entries()) {
  check(readPngPixels(buf) === null, `不支持的输入 #${index + 1} 返回 null 且不抛错`)
}
check(readPngPixels(await fsp.readFile(path.join(fixtures, 'user-ref-wood.jpg'))) === null, 'JPEG 返回 null')

// ---------------------------------------------------------- 10. 档位表

console.log('\n== 10. 档位表 ==')
check(TONE_LEVELS.length === 4, `4 个档位（实际 ${TONE_LEVELS.length}）`)
check(TONE_LEVELS[0].id === '0' && TONE_LEVELS[0].label === '关闭', '第一档是「关闭」')
check(TONE_LEVELS.every((item) => item.hint), '每一档都有说明文案（面板要显示）')

console.log('')
if (failures) {
  console.log(`TONE TEST FAILED (${failures})`)
  process.exit(1)
}
console.log('TONE TEST PASSED')
process.exit(0)
