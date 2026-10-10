/**
 * 测试用的**假引擎**：模仿 realesrgan-ncnn-vulkan 的命令行接口与各种失败姿态。
 *
 * 为什么需要它：真引擎要一块能跑 Vulkan 的显卡，CI 或别的机器上根本没有；
 * 而恰恰是**失败姿态**最需要被回归测试钉死 —— 本机实测过一次真事故：
 *
 *   引擎退出码 0、进度条跑满、打印 done，却吐出一张纯黑 PNG。
 *   stderr 上是 `vkWaitForFences failed -4`（VK_ERROR_DEVICE_LOST）。
 *
 * 也就是说「进程说自己成功了」根本不能信。这个假引擎就是要把那个姿态
 * 原样复现出来，让 tests/superres.mjs 能离线断言「插件不会把纯黑图当成功
 * 交给用户」。真引擎在别的机器上唯一不同的只是像素内容。
 *
 * 行为由环境变量 FAKE_MODE 决定（见下面 MODES）。参数原样记到 FAKE_LOG，
 * 用来断言 `-m` 是不是绝对路径、`-f` 是不是 png 这些细节。
 *
 * 用法（由 tests/superres.mjs 驱动，不单独运行）：
 *   node tests/fake-engine.mjs -i in.png -o out.png -f png -v -m <dir> -n <model> -s 4 -t 128
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { readPngStats } from '../pngzip.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- 最小 PNG 编码器
// 只给测试用：8 位 RGB、无隔行、filter 0，够 pngzip 解回来即可。
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 生成一张 width×height 的 PNG。pixel(x,y) 返回 [r,g,b]（0~255）。 */
function encodePng(width, height, pixel) {
  const rowBytes = width * 3
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const base = y * (rowBytes + 1)
    raw[base] = 0 // filter: None
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      const at = base + 1 + x * 3
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colorType: RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- 参数解析
const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? String(argv[index + 1] ?? '') : ''
}

/** 假引擎能演的失败姿态。 */
const MODES = {
  ok: '正常产出（有内容的图）',
  black: '**退出码 0，但产出一张纯黑图**（本机 K4200 上的真实事故）',
  'no-file': '退出码 0，但一个文件都没写',
  'wrong-size': '产出的尺寸不是输入 × 倍数',
  crash: '退出码 1，没有产出',
  'device-lost': '打印 Vulkan 设备丢失 + 产出纯黑图',
  oom: '打印显存不足 + 产出纯黑图',
  'device-lost-retry': 'tile>=128 时设备丢失；tile<128 时正常（验自动降 tile 重试）',
  'bad-model': '打印模型文件读不到',
}

const mode = process.env.FAKE_MODE || 'ok'

if (process.env.FAKE_LOG) {
  await fsp.appendFile(
    process.env.FAKE_LOG,
    `${JSON.stringify({ argv, cwd: process.cwd(), mode })}\n`,
    'utf8',
  )
}

/** 打印设备行 —— probeEsrgan 就是靠这个判断「认不认得到显卡」。 */
function announceDevice() {
  if (process.env.FAKE_NO_DEVICE === '1') return
  // 与真引擎的输出格式保持一致（`[0 名字] key=value ...`）
  console.error('[0 Fake Vulkan GPU]  queueC=0[16]  queueG=0[16]  queueT=1[2]')
  console.error('[0 Fake Vulkan GPU]  fp16-p/s/a=1/1/0  int8-p/s/a=1/1/1')
  console.error('[0 Fake Vulkan GPU]  subgroup=32  basic=1  vote=1  ballot=1  shuffle=1')
}

// 不带参数运行 = 打印用法与设备列表（真引擎就是这样，退出码非 0）
if (argv.length === 0) {
  console.log('Usage: realesrgan-ncnn-vulkan -i infile -o outfile [options]...')
  console.log('  -s scale   -t tile-size   -n model-name   -g gpu-id   -x   -f format')
  announceDevice()
  process.exit(-1)
}

announceDevice()

const input = flag('-i')
const output = flag('-o')
const scale = Number(flag('-s')) || 4
const tile = Number(flag('-t')) || 0

const deviceLost = mode === 'device-lost' || (mode === 'device-lost-retry' && tile >= 128)

if (deviceLost) {
  console.error('vkWaitForFences failed -4')
  console.error('vkQueueSubmit failed -4')
}
if (mode === 'oom') console.error('vkAllocateMemory failed -2')
if (mode === 'bad-model') console.error('findFile failed : models/realesrgan-x4plus.param')

if (mode === 'crash') {
  console.error('fatal: unimplemented')
  process.exit(1)
}
if (mode === 'no-file') {
  console.log('0.00%')
  console.log('done')
  process.exit(0)
}
if (mode === 'bad-model') {
  // 模型读不到时真引擎什么都不会产出，所以这里也不写文件。
  console.log('0.00%')
  process.exit(1)
}

// 量输入尺寸：真引擎的放大倍数是精确的整数倍，这里必须一样，
// 否则「尺寸对不对」这条校验就没意义了。
let inputWidth = 0
let inputHeight = 0
try {
  const stats = readPngStats(await fsp.readFile(input))
  if (stats) {
    inputWidth = stats.width
    inputHeight = stats.height
  }
} catch {
  console.error('failed to load input')
  process.exit(1)
}

let outWidth = inputWidth * scale
let outHeight = inputHeight * scale
if (mode === 'wrong-size') {
  outWidth = Math.max(1, outWidth - 7)
  outHeight = Math.max(1, outHeight - 3)
}

const blank = mode === 'black' || deviceLost || mode === 'oom'
const png = encodePng(outWidth, outHeight, (x, y) => {
  if (blank) return [0, 0, 0]
  // 有内容的图：梯度 + 一点花纹，保证 max-min 远大于 2
  return [(x * 7 + y * 3) % 256, (x * 3) % 256, (y * 5 + 40) % 256]
})

for (const percent of [0, 25, 50, 75, 100]) console.log(`${percent.toFixed(2)}%`)
await fsp.writeFile(output, png)
console.log(`${input} -> ${output} done`)
process.exit(0)
