/**
 * 零依赖的 PNG / ZIP 小工具（只用 node: 内置模块，不引任何 npm 包）。
 *
 * 为什么自己写：
 *   - 本插件是 workspace 链接进来的，解析不到 dsh 自带的打包依赖，也不能加 npm 依赖；
 *   - 判断「模型返回的图是不是一片死黑」「复检产物是否真的变了」只需要几个统计量，
 *     不需要完整的解码器与图像库；
 *   - 下载/解包 Real-ESRGAN 压缩包时也要一个能防目录穿越的极简 unzip。
 *
 * 五个导出：
 *   readPngStats(buffer)          读 PNG 像素统计（RGB 通道），不支持的一律返回 null
 *   readPngPixels(buffer)         解出整幅 RGB 像素（要逐像素改图时用）
 *   encodePngRgb(w, h, rgb)       把 RGB 像素编码成 PNG
 *   unzipEntries(buffer)          内存解 ZIP，返回条目数组
 *   unzipToDir(buffer, destDir)   解 ZIP 到目录，返回写出的绝对路径
 *
 * 设计约定：两个读函数**只返回 null、绝不抛错**（截断/损坏/垃圾数据都算 null）；
 * unzipToDir 只在传入 buffer 整个解不开时抛 Error；encodePngRgb 参数不合法直接抛错
 * （那是调用方的 bug，不是数据问题，静默返回坏数据反而更危险）。
 */
import path from 'node:path'
import { promises as fspP } from 'node:fs'
import zlib from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** ZIP 结构里出现这个值 = 真实大小/偏移在 Zip64 扩展字段里，本模块明确不支持。 */
const ZIP64_MARK = 0xffffffff

/** 超过这个像素数就开始抽样，避免一张巨图把 CPU 拉满。 */
const MAX_EXAMINE = 40_000_000

/** 抽样时最多检查的像素数。 */
const SAMPLE_TARGET = 4_000_000

/** 颜色类型 → 每个像素的字节数（bitDepth 固定 8）。 */
const BPP_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** 颜色类型 → 实际参与统计的通道数（灰度 1，其余按 RGB 3 算）。 */
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 3, 4: 1, 6: 3 }

const round2 = (value) => Math.round(value * 100) / 100

/**
 * 逐行还原 PNG 扫描线过滤（0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth）。
 * 就地改写 data。返回逐行起始偏移。
 * @param {Buffer} data 解压后的原始扫描线（每行前面一个过滤字节）
 * @param {number} width
 * @param {number} height
 * @param {number} bpp 完整像素的字节数
 * @returns {number[]}
 */
function unfilterRows(data, width, height, bpp) {
  const stride = width * bpp
  const offsets = []
  let at = 0
  for (let y = 0; y < height; y += 1) {
    const filter = data[at]
    const row = at + 1
    const prev = row - stride - 1
    if (filter !== 0) {
      for (let x = 0; x < stride; x += 1) {
        const raw = data[row + x]
        const a = x >= bpp ? data[row + x - bpp] : 0
        const b = y > 0 ? data[prev + x] : 0
        const c = x >= bpp && y > 0 ? data[prev + x - bpp] : 0
        let value
        switch (filter) {
          case 1:
            value = raw + a
            break
          case 2:
            value = raw + b
            break
          case 3:
            value = raw + ((a + b) >> 1)
            break
          case 4: {
            // Paeth：取 a/b/c 里与 p 最接近的那个
            const p = a + b - c
            const pa = Math.abs(p - a)
            const pb = Math.abs(p - b)
            const pc = Math.abs(p - c)
            value = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
            break
          }
          default:
            throw new Error(`不支持的 PNG 过滤类型 ${filter}`)
        }
        data[row + x] = value & 0xff
      }
    }
    offsets.push(row)
    at = row + stride
  }
  return offsets
}

/**
 * 解析 PNG 结构并还原出扫描线像素。失败返回 null。
 *
 * 只支持 8 位、非隔行、颜色类型 0/2/3/4/6；其余（1/2/4/16 位、Adam7、损坏、非 PNG）
 * 一律返回 null —— 调用方据此判断「这张图我处理不了」，而不是拿到半张错数据。
 *
 * 抽出来给两个地方共用：`readPngStats`（要统计量）与 `readPngPixels`（要整幅像素）。
 *
 * @returns {null | {width:number, height:number, colorType:number, channels:number, bpp:number,
 *                   raw:Buffer, rowOffsets:number[], palette:Buffer|null, paletteEntries:number}}
 */
function parsePngRaster(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null
  if (!buffer.subarray(0, 8).equals(PNG_SIG)) return null

  let offset = 8
  let ihdr = null
  let palette = null
  const idat = []

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    // 长度字段本身不可信，越界 = 截断
    if (length > buffer.length || end + 4 > buffer.length) return null
    if (type === 'IHDR') {
      if (length < 13 || ihdr) return null
      ihdr = {
        width: buffer.readUInt32BE(start),
        height: buffer.readUInt32BE(start + 4),
        bitDepth: buffer[start + 8],
        colorType: buffer[start + 9],
        interlace: buffer[start + 12],
      }
    } else if (type === 'PLTE') {
      palette = buffer.subarray(start, end)
    } else if (type === 'IDAT') {
      // IDAT 可能有多个，必须全部按顺序拼起来再解压
      idat.push(buffer.subarray(start, end))
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }

  if (!ihdr) return null
  const { width, height, bitDepth, colorType, interlace } = ihdr
  if (!width || !height) return null
  // 只支持 8 位、非隔行；1/2/4/16 位与 Adam7 直接判为不支持
  if (bitDepth !== 8) return null
  if (interlace !== 0) return null
  const bpp = BPP_BY_COLOR_TYPE[colorType]
  const channels = CHANNELS_BY_COLOR_TYPE[colorType]
  if (!bpp || !channels) return null
  if (idat.length === 0) return null
  if (!Number.isSafeInteger(width * height)) return null

  // 调色板：必须真的有色板，且索引能落在色板里
  let paletteEntries = 0
  if (colorType === 3) {
    if (!palette || palette.length < 3) return null
    paletteEntries = Math.floor(palette.length / 3)
  }

  const raw = zlib.inflateSync(Buffer.concat(idat, idat.reduce((sum, chunk) => sum + chunk.length, 0)))
  const stride = width * bpp
  const need = (stride + 1) * height
  // 少一个字节就是截断的图，不能拿残缺数据算统计
  if (raw.length < need) return null

  return {
    width,
    height,
    colorType,
    channels,
    bpp,
    raw,
    rowOffsets: unfilterRows(raw, width, height, bpp),
    palette,
    paletteEntries,
  }
}

/** 取第 (x,y) 个像素的 RGB（灰度铺成三通道，Alpha 直接丢掉）。 */
function pixelAt(raster, row, x, out) {
  const { colorType, raw, palette, paletteEntries } = raster
  if (colorType === 0 || colorType === 4) {
    const value = raw[row + (colorType === 0 ? x : x * 2)]
    out[0] = value
    out[1] = value
    out[2] = value
    return true
  }
  if (colorType === 2) {
    const at = row + x * 3
    out[0] = raw[at]
    out[1] = raw[at + 1]
    out[2] = raw[at + 2]
    return true
  }
  if (colorType === 3) {
    const index = raw[row + x]
    if (index >= paletteEntries) return false
    out[0] = palette[index * 3]
    out[1] = palette[index * 3 + 1]
    out[2] = palette[index * 3 + 2]
    return true
  }
  const at = row + x * 4
  out[0] = raw[at]
  out[1] = raw[at + 1]
  out[2] = raw[at + 2]
  return true
}

/**
 * 读 PNG 的像素统计。解不出来（不支持的位深/颜色类型/隔行、截断、损坏、非 PNG）返回 null，绝不抛错。
 *
 * 统计口径：只统计 RGB 通道（灰度取那一个通道；灰度+Alpha 与 RGBA 忽略 Alpha；调色板从 PLTE 取 RGB）。
 * 像素数超过 4000 万时按行列抽样，`sampled` 是真正统计到的像素数。
 *
 * @param {Buffer} buffer
 * @returns {null | {width:number, height:number, channels:number, colorType:number, bitDepth:number,
 *                   min:number, max:number, mean:number, sampled:number}}
 */
export function readPngStats(buffer) {
  try {
    const raster = parsePngRaster(buffer)
    if (!raster) return null
    const { width, height, colorType, channels, raw, rowOffsets } = raster

    // 抽样步长：像素太多时按行列等距取样
    const total = width * height
    const step = total > MAX_EXAMINE ? Math.max(1, Math.ceil(Math.sqrt(total / SAMPLE_TARGET))) : 1

    let min = 255
    let max = 0
    let sum = 0
    let count = 0
    const rgb = [0, 0, 0]

    for (let y = 0; y < height; y += step) {
      const row = rowOffsets[y]
      for (let x = 0; x < width; x += step) {
        if (!pixelAt(raster, row, x, rgb)) return null
        const [r, g, b] = rgb
        if (channels === 1) {
          if (r < min) min = r
          if (r > max) max = r
          sum += r
          count += 1
        } else {
          if (r < min) min = r
          if (r > max) max = r
          if (g < min) min = g
          if (g > max) max = g
          if (b < min) min = b
          if (b > max) max = b
          sum += r + g + b
          count += 1
        }
      }
    }

    if (count === 0) return null
    const divisor = channels === 1 ? count : count * 3
    return {
      width,
      height,
      channels,
      colorType,
      bitDepth: 8,
      min,
      max,
      mean: round2(sum / divisor),
      sampled: count,
    }
  } catch {
    return null
  }
}

/**
 * 把 PNG 解成**整幅 RGB 像素**（用于本地层次增强那种要逐像素改的场景）。
 *
 * 与 readPngStats 同一套解析，区别是这里不抽样、返回完整数据。
 * 解不出来返回 null（绝不抛错），调用方据此**放弃这一步并如实说明**，
 * 而不是拿一张没处理的图冒充处理过。
 *
 * 内存：width × height × 3 字节。3072×2048 约 19MB —— 调用方自己判断要不要用。
 *
 * @param {Buffer} buffer
 * @returns {null | {width:number, height:number, data:Buffer}} data 是 RGB 连续排列
 */
export function readPngPixels(buffer) {
  try {
    const raster = parsePngRaster(buffer)
    if (!raster) return null
    const { width, height, rowOffsets } = raster
    const total = width * height
    if (!Number.isSafeInteger(total * 3)) return null
    const data = Buffer.allocUnsafe(total * 3)
    const rgb = [0, 0, 0]
    let at = 0
    for (let y = 0; y < height; y += 1) {
      const row = rowOffsets[y]
      for (let x = 0; x < width; x += 1) {
        if (!pixelAt(raster, row, x, rgb)) return null
        data[at] = rgb[0]
        data[at + 1] = rgb[1]
        data[at + 2] = rgb[2]
        at += 3
      }
    }
    return { width, height, data }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- PNG 编码

const PNG_CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function pngCrc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = PNG_CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(pngCrc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * 把 RGB 像素编码成 PNG（8 位、filter 0、无隔行、无压缩优化）。
 *
 * 与解码端配套：本地处理的产物必须能写回一张**别人也打得开**的 PNG。
 * 参数不合法直接抛错（那是调用方的 bug，不是数据问题），不像解码那样静默返回 null。
 *
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgb width×height×3
 * @returns {Buffer}
 */
export function encodePngRgb(width, height, rgb) {
  const w = Math.round(Number(width))
  const h = Math.round(Number(height))
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`encodePngRgb: 尺寸不合法（${width}×${height}）`)
  }
  const need = w * h * 3
  if (!Buffer.isBuffer(rgb) || rgb.length < need) {
    throw new Error(`encodePngRgb: 像素数据不足（需要 ${need} 字节，实际 ${rgb?.length ?? 0}）`)
  }
  const rowBytes = w * 3
  const raw = Buffer.alloc((rowBytes + 1) * h)
  for (let y = 0; y < h; y += 1) {
    // filter 字节留 0（None）
    rgb.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bitDepth
  ihdr[9] = 2 // colorType: RGB
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 解 ZIP（内存中）。
 *
 * 支持：stored(0) / deflate(8)，多个条目、目录条目（跳过）、本地头与中央目录长度不一致。
 * 不支持（一律返回 null，不抛错）：Zip64、bit3 数据描述符（流式 zip）、加密、其它压缩方法、
 * 多卷（分卷）压缩包。
 *
 * @param {Buffer} buffer
 * @returns {null | Array<{name:string, data:Buffer}>}
 */
export function unzipEntries(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null
    const view = buffer

    // 1. 从尾部倒着找 EOCD（后面可能跟着注释）
    let eocd = -1
    const earliest = Math.max(0, view.length - 65557)
    for (let at = view.length - 22; at >= earliest; at -= 1) {
      if (view.readUInt32LE(at) === 0x06054b50) {
        eocd = at
        break
      }
    }
    if (eocd < 0) return null

    const diskNo = view.readUInt16LE(eocd + 4)
    const cdDisk = view.readUInt16LE(eocd + 6)
    const onDisk = view.readUInt16LE(eocd + 8)
    const total = view.readUInt16LE(eocd + 10)
    const cdSize = view.readUInt32LE(eocd + 12)
    const cdOffset = view.readUInt32LE(eocd + 16)
    // 分卷压缩包（多张盘）不支持
    if (diskNo !== 0 || cdDisk !== 0 || onDisk !== total) return null
    if (cdOffset === ZIP64_MARK || cdSize === ZIP64_MARK) return null
    if (total === 0) return []
    if (cdOffset + cdSize > view.length) return null

    // 2. 遍历中央目录
    const records = []
    let at = cdOffset
    for (let i = 0; i < total; i += 1) {
      if (at + 46 > view.length) return null
      if (view.readUInt32LE(at) !== 0x02014b50) return null
      const flags = view.readUInt16LE(at + 8)
      const method = view.readUInt16LE(at + 10)
      const compressedSize = view.readUInt32LE(at + 20)
      const uncompressedSize = view.readUInt32LE(at + 24)
      const nameLength = view.readUInt16LE(at + 28)
      const extraLength = view.readUInt16LE(at + 30)
      const commentLength = view.readUInt16LE(at + 32)
      const localOffset = view.readUInt32LE(at + 42)
      const nameStart = at + 46
      if (nameStart + nameLength + extraLength + commentLength > view.length) return null
      // Zip64 / 大小未知（bit3 数据描述符）都不支持，见函数注释
      if (compressedSize === ZIP64_MARK || uncompressedSize === ZIP64_MARK || localOffset === ZIP64_MARK) return null
      if (flags & 0x0008) return null
      records.push({
        name: view.toString(flags & 0x0800 ? 'utf8' : 'latin1', nameStart, nameStart + nameLength),
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
      })
      at = nameStart + nameLength + extraLength + commentLength
    }

    // 3. 逐个条目：本地头里的 name/extra 长度可能与中央目录不同，必须重读
    const entries = []
    for (const record of records) {
      // 目录条目（以 / 结尾）直接跳过
      if (record.name.endsWith('/')) continue
      if (record.localOffset + 30 > view.length) return null
      if (view.readUInt32LE(record.localOffset) !== 0x04034b50) return null
      const localNameLength = view.readUInt16LE(record.localOffset + 26)
      const localExtraLength = view.readUInt16LE(record.localOffset + 28)
      const dataStart = record.localOffset + 30 + localNameLength + localExtraLength
      const dataEnd = dataStart + record.compressedSize
      if (dataEnd > view.length) return null
      const source = view.subarray(dataStart, dataEnd)
      let data
      if (record.method === 0) {
        // stored：原样拷贝
        data = Buffer.from(source)
      } else if (record.method === 8) {
        data = zlib.inflateRawSync(source)
      } else {
        return null
      }
      entries.push({ name: record.name.replaceAll('\\', '/'), data })
    }
    return entries
  } catch {
    return null
  }
}

/**
 * 判断子路径是否确实落在根目录里（防目录穿越）。
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function insideRoot(root, target) {
  if (target === root) return true
  return target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
}

/**
 * 把 ZIP 解到目录（会创建父目录、防目录穿越）。
 *
 * 目录穿越的处理：条目名以 `/` 或 `\` 开头（绝对路径）、或解析后仍然跑出 destDir 的，
 * 一律**跳过并在返回列表里不出现**，其余条目照常写出（恶意/怪异条目不该让整包失败）。
 *
 * @param {Buffer} buffer
 * @param {string} destDir
 * @returns {Promise<string[]>} 写出的绝对路径列表
 */
export async function unzipToDir(buffer, destDir) {
  const entries = unzipEntries(buffer)
  if (!entries) throw new Error('ZIP 结构无法解析')
  const root = path.resolve(destDir)
  const written = []
  for (const entry of entries) {
    const name = String(entry.name).replaceAll('\\', '/')
    // 绝对路径与上跳路径直接跳过，不做任何拼接尝试
    if (!name || name.startsWith('/') || name.split('/').includes('..')) continue
    const target = path.resolve(root, name)
    if (!insideRoot(root, target)) continue
    // 压缩包里不一定有 models/ 这种目录条目，父目录一律 mkdir -p
    await fspP.mkdir(path.dirname(target), { recursive: true })
    await fspP.writeFile(target, entry.data)
    written.push(target)
  }
  return written
}
