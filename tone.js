/**
 * 本地「层次增强」—— **非 AI 的色调后处理**，零依赖、纯函数、完全确定性。
 *
 * ## 先把话说清楚：这不是重新打光
 *
 * 它做的是**色调映射**，不是打光：
 *   - ✅ 局部对比（detail / clarity）：把被压缩掉的中间频率层次拉回来，让发灰发软的图"站起来"
 *   - ✅ S 曲线：拉开暗部 / 中间调 / 亮部的距离（这才是"层次"二字的本意）
 *   - ✅ 阴影提亮：把糊成一片的暗部打开，保留细节
 *   - ❌ **不会新增光源**、不会改光照方向、不会改色温、不会造阴影
 *
 * 真正的"换日光 / 换黄昏"必须由**生成式模型**重画（本插件里走云 AI 的
 * 一键操作）。Real-ESRGAN 是纯超分网络，它压根不认识「光源」这个输入 ——
 * 那是模型能力的物理边界，不是这里少写了一个开关。
 *
 * ## 为什么单独一个文件
 *
 * `esrgan.js` 管「怎么把引擎跑起来」，这里管「拿到像素之后怎么调」。
 * 两件事的失败模式完全不同（一个会崩驱动，一个只会算错颜色），分开更好测。
 *
 * ## 只动亮度，不动色相
 *
 * 所有调整都算在**亮度**上，再以**等量增量**加到 R/G/B 三个通道。
 * 这样色相与饱和度不会被带偏（对通道各调各的会直接把颜色改掉）。
 *
 * @module @local/dsh-ai-render/tone
 */

/** 强度档位：面板上的「关闭 / 轻 / 中 / 强」直接映射到这几个值。 */
export const TONE_LEVELS = [
  { id: '0', label: '关闭', hint: '原样放大：超分只提分辨率，不动任何像素' },
  { id: '35', label: '轻', hint: '轻微提层次：暗部打开一点、中间调清楚一点' },
  { id: '65', label: '中', hint: '明显的层次提升：发灰发软的图会"站起来"，但会改像素' },
  { id: '100', label: '强', hint: '最激进：对比与暗部提升都拉满，容易过头，先用「中」比较' },
]

/** 各强度下要动的量。都是 s（0~1）的线性系数，方便一眼看出上限。 */
const EFFECT = {
  /** 局部对比（clarity）强度。 */
  detail: 0.55,
  /** S 曲线强度（绕 0.5 提高对比，端点 0/1 不动）。 */
  contrast: 0.35,
  /** 阴影提亮：越黑抬得越多，纯白不动。 */
  shadow: 0.07,
}

/**
 * 「只放大中间频率」的护栏：|局部差| 超过这个值就逐步不再放大。
 *
 * 为什么必须有：朴素的 unsharp mask 在**真正的硬边**两侧会留下白边/黑边
 * （亮侧更亮、暗侧更暗）。CAD 立面图上全是硬边，一放大就成了一圈描边。
 * 真实细节（被压缩掉的中间频率）幅度都不大，所以按幅度加权，
 * 到 EDGE_GUARD 就完全不碰 —— 硬边保持原样，软掉的细节被提回来。
 */
const EDGE_GUARD = 40

/** 局部对比的模糊半径按图幅取（比例），有上下限，避免小图糊、大图没效果。 */
const BLUR_RATIO = 0.02
const BLUR_MIN = 2
const BLUR_MAX = 80

const clamp255 = (value) => (value < 0 ? 0 : value > 255 ? 255 : value)

/**
 * 可分离盒式模糊（两次一维滑动窗口，O(w×h)，与半径无关）。
 *
 * 边缘用「夹取」而不是补零：补零会在画面四周造成一圈假的高对比，
 * 而这张图马上要被当"原图"减掉。
 */
function boxBlur(src, width, height, radius) {
  const window = radius * 2 + 1
  const tmp = new Float32Array(width * height)
  const out = new Float32Array(width * height)

  // 横向
  for (let y = 0; y < height; y += 1) {
    const base = y * width
    let sum = 0
    for (let i = -radius; i <= radius; i += 1) {
      const x = i < 0 ? 0 : i >= width ? width - 1 : i
      sum += src[base + x]
    }
    for (let x = 0; x < width; x += 1) {
      tmp[base + x] = sum / window
      const dropX = x - radius < 0 ? 0 : x - radius
      const addX = x + radius + 1 >= width ? width - 1 : x + radius + 1
      sum -= src[base + dropX]
      sum += src[base + addX]
    }
  }

  // 纵向
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let i = -radius; i <= radius; i += 1) {
      const y = i < 0 ? 0 : i >= height ? height - 1 : i
      sum += tmp[y * width + x]
    }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / window
      const dropY = y - radius < 0 ? 0 : y - radius
      const addY = y + radius + 1 >= height ? height - 1 : y + radius + 1
      sum -= tmp[dropY * width + x]
      sum += tmp[addY * width + x]
    }
  }

  return out
}

/** 提取亮度（Rec.601，和大部分图像工具的 luma 口径一致）。 */
function toLuma(data, count) {
  const luma = new Float32Array(count)
  for (let i = 0, at = 0; i < count; i += 1, at += 3) {
    luma[i] = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2]
  }
  return luma
}

/** 亮度统计（给调用方一个"到底改了多少"的客观数字，不靠感觉）。 */
function lumaStats(luma, count) {
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < count; i += 1) {
    sum += luma[i]
    sumSq += luma[i] * luma[i]
  }
  const mean = sum / count
  const variance = Math.max(0, sumSq / count - mean * mean)
  return { mean: Math.round(mean * 100) / 100, std: Math.round(Math.sqrt(variance) * 100) / 100 }
}

/**
 * 局部层次（细节能量）= 相邻像素亮度差的平均值。
 *
 * **别用全局标准差来代表「层次」**：在一张黑线白底的 CAD 图上，把暗部提亮
 * 会让全局标准差**下降**（黑不再那么黑），但画面的层次其实是变清楚的。
 * 全局 std 测的是「最亮和最暗差多远」，相邻差测的才是「中间调分不分得开」。
 *
 * 为什么不用「亮度 − 模糊亮度」那个更讲究的口径：那要给**输出**再模糊一整张图，
 * 在一张 2500 万像素的图上等于多出两个约 100MB 的 Float32Array。
 * 宿主是单进程事件循环，这种同步内存峰值会把整个 DSH 拖住（甚至搞崩）。
 * 相邻差 O(n)、零额外数组，方向性一样准。
 */
function gradientEnergy(luma, width, height) {
  let sum = 0
  let count = 0
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 1; x < width; x += 1) {
      sum += Math.abs(luma[row + x] - luma[row + x - 1])
      count += 1
    }
  }
  return count ? Math.round((sum / count) * 100) / 100 : 0
}

/**
 * 层次增强的像素上限。
 *
 * 超过就**明确跳过并说明原因**，而不是硬算 —— 一张 6000×4000（2400 万像素）
 * 的图要几个各约 96MB 的 Float32Array 加输出缓冲，同步跑完会把宿主卡住很久。
 * 「跳过」也必须报出来（宿主会当告警显示），不能悄悄不生效。
 */
export const TONE_MAX_PIXELS = 30_000_000

/**
 * 对 RGB 像素做层次增强。
 *
 * @param {object} options
 * @param {number} options.width
 * @param {number} options.height
 * @param {Buffer} options.data width×height×3 的 RGB 像素
 * @param {number} options.strength 0~100，0 = 原样返回
 * @returns {{data:Buffer, applied:boolean, strength:number, blurRadius:number,
 *            before:{mean:number,std:number}, after:{mean:number,std:number},
 *            detailEnergy:null|{before:number,after:number}, clippedRatio:number}}
 */
export function enhanceTone({ width, height, data, strength = 0, maxPixels = TONE_MAX_PIXELS } = {}) {
  const w = Math.round(Number(width))
  const h = Math.round(Number(height))
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`enhanceTone: 尺寸不合法（${width}×${height}）`)
  }
  const count = w * h
  if (!Buffer.isBuffer(data) || data.length < count * 3) {
    throw new Error(`enhanceTone: 像素数据不足（需要 ${count * 3} 字节，实际 ${data?.length ?? 0}）`)
  }

  const s = Math.max(0, Math.min(100, Number(strength) || 0)) / 100

  // 先看强度：0 = 完全不动（连亮度数组都不用建，直接原样把数据还回去）
  if (s <= 0) {
    const flat = lumaStats(toLuma(data, count), count)
    return {
      data,
      applied: false,
      strength: 0,
      blurRadius: 0,
      before: flat,
      after: flat,
      detailEnergy: null,
      clippedRatio: 0,
    }
  }

  // 太大就别硬算：同步跑完会长时间占住宿主的单线程，也吃一大片内存。
  // 「跳过」必须带原因返回，让宿主如实告警，而不是悄悄不生效。
  if (count > maxPixels) {
    return {
      data,
      applied: false,
      strength: Math.round(s * 100),
      blurRadius: 0,
      before: lumaStats(toLuma(data, count), count),
      after: null,
      detailEnergy: null,
      clippedRatio: 0,
      reason:
        `图有 ${count} 像素，超过层次增强的上限 ${maxPixels}，已跳过以免占满内存。` +
        '把放大倍数调小（例如 ×2）再试，或关掉层次增强。',
    }
  }

  const luma = toLuma(data, count)
  const before = lumaStats(luma, count)
  const blurRadius = Math.max(BLUR_MIN, Math.min(BLUR_MAX, Math.round(Math.min(w, h) * BLUR_RATIO)))
  const blurred = boxBlur(luma, w, h, blurRadius)
  const beforeDetail = gradientEnergy(luma, w, h)

  const detailGain = EFFECT.detail * s
  const contrast = EFFECT.contrast * s
  const shadow = EFFECT.shadow * s

  const out = Buffer.allocUnsafe(count * 3)
  let clipped = 0
  // 输出的亮度统计与「相邻差」都在主循环里**滚动累加**，不再为结果另建一张大数组：
  // 2500 万像素时那等于省下约 200MB（一张 afterLuma + 一次全图模糊）。
  let outSum = 0
  let outSumSq = 0
  let outGradient = 0
  let outGradientCount = 0
  let lastOutLuma = 0

  for (let i = 0, at = 0; i < count; i += 1, at += 3) {
    const base = luma[i]
    // 局部对比：原亮度与模糊版的差就是"被抹掉的中间频率层次"。
    // 按幅度加权 → 小细节全量放大，真硬边（|detail| >= EDGE_GUARD）一点都不碰，
    // 这样不会在边缘留下白边/黑边。
    const detail = base - blurred[i]
    const magnitude = detail < 0 ? -detail : detail
    const t = magnitude / EDGE_GUARD
    const edgeWeight = t < 1 ? 1 - t * t : 0
    // S 曲线：v=0/0.5/1 处分别保持 0/0.5/1 的走向，端点不动
    const v = base / 255
    const curved = v + contrast * v * (1 - v) * (2 * v - 1)
    // 阴影提亮：越暗抬得越多，(1-v)^3 保证纯白完全不受影响
    const lifted = curved + shadow * (1 - curved) * (1 - curved) * (1 - curved)
    const target = Math.max(0, Math.min(1, lifted)) * 255
    // 亮度增量等量加到三个通道 → 色相与饱和度不被带偏
    const delta = target - base + detailGain * detail * edgeWeight

    const r = data[at] + delta
    const g = data[at + 1] + delta
    const b = data[at + 2] + delta
    const rc = clamp255(r)
    const gc = clamp255(g)
    const bc = clamp255(b)
    // 只统计**新增**的溢出：原本就是纯黑/纯白的像素被边界拦住不算「细节被压死」，
    // 否则一张大片纯白底的 CAD 图会被报成「17% 溢出」，纯属吓人（踩过）。
    if (
      (rc === 0 && data[at] > 0) || (rc === 255 && data[at] < 255) ||
      (gc === 0 && data[at + 1] > 0) || (gc === 255 && data[at + 1] < 255) ||
      (bc === 0 && data[at + 2] > 0) || (bc === 255 && data[at + 2] < 255)
    ) {
      clipped += 1
    }
    out[at] = rc
    out[at + 1] = gc
    out[at + 2] = bc

    const outLuma = 0.299 * rc + 0.587 * gc + 0.114 * bc
    outSum += outLuma
    outSumSq += outLuma * outLuma
    if (i % w !== 0) {
      outGradient += Math.abs(outLuma - lastOutLuma)
      outGradientCount += 1
    }
    lastOutLuma = outLuma
  }

  const outMean = outSum / count
  const after = {
    mean: Math.round(outMean * 100) / 100,
    std: Math.round(Math.sqrt(Math.max(0, outSumSq / count - outMean * outMean)) * 100) / 100,
  }

  return {
    data: out,
    applied: true,
    strength: Math.round(s * 100),
    blurRadius,
    before,
    after,
    detailEnergy: {
      before: beforeDetail,
      after: outGradientCount ? Math.round((outGradient / outGradientCount) * 100) / 100 : 0,
    },
    // 溢出比例：告诉用户"有没有把亮部/暗部压死"，这比一句"已增强"有用得多
    clippedRatio: Math.round((clipped / count) * 10000) / 10000,
  }
}
