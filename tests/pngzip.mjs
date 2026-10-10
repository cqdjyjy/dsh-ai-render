/**
 * pngzip.js 的离线测试：不需要网络、不需要 Key。
 *
 * 覆盖：
 *   1. 全黑 PNG（真实产物 fixture）→ min/max 都是 0
 *   2. 真实照片类 PNG → 宽高正确且 max > 200
 *   3. 渐变 PNG → min/mean/max 落在应有区间，且 R 通道随列单调
 *   4. RGBA 与调色板（colorType 3）→ 宽高、通道数、已知颜色都读对
 *   5. 截断 / 垃圾数据 → 返回 null 且不抛错
 *   6. 真实 Real-ESRGAN 压缩包（**可选**，见下）→ 条目名、大小、exe 的 MZ 头
 *   7. 随机字节当 ZIP → null 且不抛错
 *   8. 自己写的极小 ZIP 写入器 → 往返一致，且 unzipToDir 落盘字节正确
 *   8.5 自造的「够真」引擎包（多文件 / deflate / MB 级 / MZ）→ 等效覆盖，恒定运行
 *   9. unzipToDir → 落盘字节与尺寸正确，临时目录用完清掉
 *
 * **为什么不依赖真实压缩包**：那个 43MB 的 realesrgan 官方包是开发机上的临时
 * 文件，不在仓库里，fresh clone 根本没有。所以第 6 节改成「有就跑、没有就 skip」，
 * 真正必须有覆盖的性质（多文件 / deflate / 大文件 / MZ）在第 8.5 节用自造的包跑。
 *
 * 用法：node tests/pngzip.mjs
 */
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { readPngStats, unzipEntries, unzipToDir } from '../pngzip.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const workspace = path.resolve(here, '..', '..')
const realZip = path.join(workspace, 'tools', 'realesrgan-ncnn-vulkan-windows.zip')

let failures = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

/** 样本间最大差。 */
const spread = (values) => Math.max(...values) - Math.min(...values)
/** 求和。 */
const total = (values) => values.reduce((sum, value) => sum + value, 0)

// ---------------------------------------------------------- 1. 全黑

console.log('== 1. 全黑 PNG（真实产物）==')
const black = await fsp.readFile(path.join(fixtures, 'blank-black.png'))
const blackStats = readPngStats(black)
check(blackStats !== null, '能解出统计')
check(blackStats?.width === 1600 && blackStats?.height === 1068, `宽高 1600x1068（实际 ${blackStats?.width}x${blackStats?.height}）`)
check(blackStats?.channels === 3, 'channels 为 3（RGB）')
check(blackStats?.min === 0 && blackStats?.max === 0, 'min 与 max 都是 0')
check(blackStats?.mean === 0, 'mean 为 0')
check(blackStats?.sampled === 1600 * 1068, `全量扫描，sampled = 宽×高（实际 ${blackStats?.sampled}）`)

// ---------------------------------------------------------- 2. 真实照片

console.log('\n== 2. 真实照片类 PNG ==')
const photo = await fsp.readFile(path.join(fixtures, 'cad-elevation.png'))
const photoStats = readPngStats(photo)
check(photoStats !== null, '能解出统计')
check(photoStats?.width === 1600 && photoStats?.height === 1000, `宽高 1600x1000（实际 ${photoStats?.width}x${photoStats?.height}）`)
check((photoStats?.max ?? 0) > 200, `max > 200（实际 ${photoStats?.max}）`)
check(photoStats?.min === 0, `min 为 0（实际 ${photoStats?.min}）`)
check((photoStats?.mean ?? 0) > 0 && (photoStats?.mean ?? 0) < 255, 'mean 落在 0..255 之间')

// ---------------------------------------------------------- 3. 渐变

console.log('\n== 3. 渐变 PNG ==')
const grad = readPngStats(await fsp.readFile(path.join(fixtures, 'pngzip-gradient.png')))
check(grad !== null, '能解出统计')
check(grad?.width === 256 && grad?.height === 96, `宽高 256x96（实际 ${grad?.width}x${grad?.height}）`)
check(grad?.colorType === 2 && grad?.channels === 3, 'colorType 2 / channels 3')
check(grad?.min === 0, `min 为 0（实际 ${grad?.min}）`)
check(grad?.max === 255, `max 为 255（实际 ${grad?.max}）`)
// 渐变图的真实均值：三个通道各自均值都约 127.5
check((grad?.mean ?? 0) > 125 && (grad?.mean ?? 0) < 130, `mean 约 127.5（实际 ${grad?.mean}）`)
check(grad?.sampled === 256 * 96, `sampled = 宽×高（实际 ${grad?.sampled}）`)

// ---------------------------------------------------------- 4. RGBA 与调色板

console.log('\n== 4. RGBA 与调色板 ==')
const rgba = readPngStats(await fsp.readFile(path.join(fixtures, 'pngzip-rgba.png')))
check(rgba?.colorType === 6 && rgba?.channels === 3, 'RGBA 的 channels 记 3（忽略 Alpha）')
check(rgba?.width === 16 && rgba?.height === 16, `RGBA 宽高 16x16（实际 ${rgba?.width}x${rgba?.height}）`)
check(rgba?.min === 0 && rgba?.max === 255, `RGBA 覆盖 min 0 / max 255（实际 ${rgba?.min}/${rgba?.max}）`)
check(rgba?.sampled === 256, 'RGBA sampled 256')

const pal = readPngStats(await fsp.readFile(path.join(fixtures, 'pngzip-palette.png')))
check(pal?.colorType === 3, '调色板的 colorType 是 3')
check(pal?.channels === 3, '调色板按 RGB 统计，channels 记 3')
check(pal?.width === 32 && pal?.height === 32, `调色板宽高 32x32（实际 ${pal?.width}x${pal?.height}）`)
check(pal?.min === 128 && pal?.max === 128 && pal?.mean === 128, `整幅中灰 128 被读出来（${pal?.min}/${pal?.mean}/${pal?.max}）`)
check(pal?.sampled === 1024, '调色板 sampled 1024')

// ---------------------------------------------------------- 5. 坏数据

console.log('\n== 5. 截断 / 垃圾数据不抛错 ==')
const small = await fsp.readFile(path.join(fixtures, 'pngzip-gradient.png'))
let threw = false
let cutStats = 'none'
try {
  cutStats = readPngStats(small.subarray(0, Math.floor(small.length / 2)))
} catch (error) {
  threw = true
}
check(!threw, '砍掉一半的 PNG 不抛错')
check(cutStats === null, '砍掉一半的 PNG 返回 null')

threw = false
let headStats = 'none'
try {
  headStats = readPngStats(small.subarray(0, 20))
} catch (error) {
  threw = true
}
check(!threw && headStats === null, '只留文件头的 PNG 返回 null 且不抛错')

const junk = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55])
check(readPngStats(junk) === null, '6 字节垃圾返回 null')
check(readPngStats(Buffer.alloc(0)) === null, '空 buffer 返回 null')
check(readPngStats(null) === null, '非 Buffer 返回 null')
check(readPngStats(await fsp.readFile(path.join(fixtures, 'user-ref-wood.jpg'))) === null, 'JPEG 返回 null（不是 PNG）')

// ---------------------------------------------------------- 6. 真实压缩包（可选）

console.log('\n== 6. 真实压缩包 unzipEntries ==')
// 那个真实的 43MB 包**不在仓库里**（是开发机上的临时文件），所以这里必须容错：
// 「跑不了」就明确 skip，而不是崩掉或假装通过。
// 真正必须有覆盖的「多文件 + deflate + 大文件」部分放在第 8.5 节，用自造的包跑。
let zipBuffer = null
try {
  zipBuffer = await fsp.readFile(realZip)
} catch {
  zipBuffer = null
}
if (!zipBuffer) {
  console.log(`  skip 没找到真实压缩包（${realZip}）—— 第 6 / 9 节的真实包断言跳过`)
  console.log('  skip 自造的等价覆盖见第 8.5 节（多文件 / deflate / MZ / 尺寸）')
} else {
  const entries = unzipEntries(zipBuffer)
  check(Array.isArray(entries), '返回数组而不是 null')
  const byName = new Map((entries ?? []).map((entry) => [entry.name, entry]))
  check(entries !== null && entries.length >= 10, `条目数 >= 10（实际 ${entries?.length}）`)

  const exe = byName.get('realesrgan-ncnn-vulkan.exe')
  check(Boolean(exe), '含 realesrgan-ncnn-vulkan.exe')
  check((exe?.data.length ?? 0) > 5_000_000, `exe 解出 > 5MB（实际 ${exe?.data.length}）`)
  check(exe?.data.subarray(0, 2).toString('latin1') === 'MZ', 'exe 以 MZ 开头')

  const model = byName.get('models/realesrgan-x4plus.bin')
  check(Boolean(model), '含 models/realesrgan-x4plus.bin')
  check((model?.data.length ?? 0) > 30_000_000, `模型解出 > 30MB（实际 ${model?.data.length}）`)
  check(
    (entries ?? []).every((entry) => !entry.name.endsWith('/')),
    '目录条目没有被当成文件返回',
  )
}

// ---------------------------------------------------------- 7. 随机字节

console.log('\n== 7. 随机字节当 ZIP ==')
const noise = Buffer.alloc(4096)
for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 37 + 11) & 0xff
let zipThrew = false
let noiseEntries = 'none'
try {
  noiseEntries = unzipEntries(noise)
} catch (error) {
  zipThrew = true
}
check(!zipThrew, '随机字节不抛错')
check(noiseEntries === null, '随机字节返回 null')
check(unzipEntries(Buffer.alloc(0)) === null, '空 buffer 返回 null')
if (zipBuffer) {
  check(unzipEntries(zipBuffer.subarray(0, 1000)) === null, '砍掉一半的真压缩包返回 null')
} else {
  console.log('  skip 没有真实压缩包，跳过「砍一半」这条')
}

// ---------------------------------------------------------- 8. 自制 ZIP 往返

console.log('\n== 8. 自制 ZIP 往返 + 目录穿越 ==')
/** 最小 ZIP 写入器（只为测试服务）。 */
const writeZip = (files) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? '', 'utf8')
    const stored = Boolean(file.stored)
    const payload = stored ? raw : zlib.deflateRawSync(raw)
    const method = stored ? 0 : 8
    const crc = zlib.crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + payload.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const body = 'ai-render 自制 ZIP 往返测试\n第二行 with ASCII\n'
const roundZip = writeZip([
  { name: 'dir/' },
  { name: 'dir/hello.txt', data: body },
  { name: 'stored.bin', data: Buffer.from([0, 1, 2, 250, 251, 252]), stored: true },
  { name: '../escape.txt', data: '不该被写出去' },
])
const roundEntries = unzipEntries(roundZip)
check(Array.isArray(roundEntries), '自制 ZIP 能解开')
check(roundEntries?.length === 3, `目录条目被跳过，剩 3 条（实际 ${roundEntries?.length}）`)
const roundByName = new Map((roundEntries ?? []).map((entry) => [entry.name, entry]))
check(roundByName.get('dir/hello.txt')?.data.toString('utf8') === body, 'deflate 条目内容往返一致（含中文）')
check(
  roundByName.get('stored.bin')?.data.equals(Buffer.from([0, 1, 2, 250, 251, 252])),
  'stored 条目内容往返一致',
)

const roundDir = path.join(os.tmpdir(), `pngzip-round-${process.pid}`)
await fsp.rm(roundDir, { recursive: true, force: true })
const roundWritten = await unzipToDir(roundZip, roundDir)
// 目录条目（dir/）被跳过，穿越条目（../escape.txt）被拒绝，只剩 2 个真文件
check(roundWritten.length === 2, `只写出 2 个文件（实际 ${roundWritten.length}）`)
check(
  (await fsp.readFile(path.join(roundDir, 'dir', 'hello.txt'), 'utf8')) === body,
  '落盘内容一致（utf8）',
)
check(
  (await fsp.readFile(path.join(roundDir, 'stored.bin'))).equals(Buffer.from([0, 1, 2, 250, 251, 252])),
  '落盘的二进制一致',
)
const walked = []
const walk = async (dir) => {
  for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) await walk(full)
    else walked.push(path.relative(roundDir, full).replaceAll('\\', '/'))
  }
}
await walk(roundDir)
check(!walked.some((name) => name.startsWith('..')), '穿越条目没有写出目录之外')
check(walked.sort().join(',') === 'dir/hello.txt,stored.bin', `目录内容正确（${walked.join(',')}）`)

let dirThrew = false
try {
  await unzipToDir(noise, path.join(roundDir, 'noise'))
} catch (error) {
  dirThrew = true
}
check(dirThrew, 'unzipToDir 遇到解不开的数据会抛错')
await fsp.rm(roundDir, { recursive: true, force: true })

// ---------------------------------------------------------- 8.5 自造的「够真」压缩包

console.log('\n== 8.5 自造的多文件 deflate 包（等效于真实引擎包）==')
// 真实引擎包的形状：一个几 MB 的 exe（MZ 开头）+ 一堆模型 + 说明文件，
// 全部 deflate 压缩。用自造的包覆盖这些性质，测试就不再依赖开发机上的临时文件。
const fakeExe = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(1_500_000, 0x41)])
const fakeModel = Buffer.alloc(3_000_000, 0x5a)
const engineZip = writeZip([
  { name: 'realesrgan-ncnn-vulkan.exe', data: fakeExe },
  { name: 'models/realesrgan-x4plus.bin', data: fakeModel },
  { name: 'models/realesrgan-x4plus.param', data: 'param-content' },
  { name: 'README_windows.md', data: '# readme' },
  { name: 'models/' },
])
const engineEntries = unzipEntries(engineZip)
check(Array.isArray(engineEntries), '引擎包能解开')
check(engineEntries?.length === 4, `目录条目被跳过，剩 4 条（实际 ${engineEntries?.length}）`)
const engineByName = new Map((engineEntries ?? []).map((entry) => [entry.name, entry]))
check(engineByName.get('realesrgan-ncnn-vulkan.exe')?.data.equals(fakeExe), 'deflate 的 exe 往返一致')
check(engineByName.get('realesrgan-ncnn-vulkan.exe')?.data.subarray(0, 2).toString('latin1') === 'MZ', 'exe 以 MZ 开头')
check((engineByName.get('models/realesrgan-x4plus.bin')?.data.length ?? 0) === fakeModel.length, '3MB 模型解出尺寸正确')
check(engineZip.length < fakeExe.length + fakeModel.length, `deflate 真的压缩了（${engineZip.length} < ${fakeExe.length + fakeModel.length}）`)

// ---------------------------------------------------------- 9. 落盘

console.log('\n== 9. unzipToDir 落盘 ==')
const realDir = path.join(os.tmpdir(), `pngzip-real-${process.pid}`)
await fsp.rm(realDir, { recursive: true, force: true })
const realWritten = await unzipToDir(engineZip, realDir)
check(realWritten.length === 4, `写出文件数 4（实际 ${realWritten.length}）`)
check(realWritten.every((item) => path.isAbsolute(item)), '返回的都是绝对路径')
const exePath = path.join(realDir, 'realesrgan-ncnn-vulkan.exe')
const exeStat = await fsp.stat(exePath).catch(() => null)
check(Boolean(exeStat), 'exe 真的落盘了')
check((exeStat?.size ?? 0) === fakeExe.length, `落盘 exe 尺寸正确（实际 ${exeStat?.size}）`)
const exeHead = Buffer.alloc(2)
const exeHandle = exeStat ? await fsp.open(exePath, 'r') : null
if (exeHandle) {
  await exeHandle.read(exeHead, 0, 2, 0)
  await exeHandle.close()
}
check(exeHead.toString('latin1') === 'MZ', '落盘 exe 以 MZ 开头')
check((await fsp.stat(path.join(realDir, 'models', 'realesrgan-x4plus.bin')).catch(() => null))?.size === fakeModel.length, '子目录里的模型也落盘了')
await fsp.rm(realDir, { recursive: true, force: true })
check(!(await fsp.stat(realDir).catch(() => null)), '临时目录已清理')

if (zipBuffer) {
  console.log('\n== 9.5 真实压缩包落盘（可选）==')
  const trueDir = path.join(os.tmpdir(), `pngzip-true-${process.pid}`)
  await fsp.rm(trueDir, { recursive: true, force: true })
  const written = await unzipToDir(zipBuffer, trueDir)
  check(written.length >= 10, `写出文件数 >= 10（实际 ${written.length}）`)
  const trueExe = await fsp.stat(path.join(trueDir, 'realesrgan-ncnn-vulkan.exe')).catch(() => null)
  check((trueExe?.size ?? 0) > 5_000_000, `真实包落盘 exe > 5MB（实际 ${trueExe?.size}）`)
  await fsp.rm(trueDir, { recursive: true, force: true })
} else {
  console.log('\n  skip 没有真实压缩包，跳过「真实包落盘」')
}

console.log(failures === 0 ? '\nPNGZIP TEST PASSED' : `\nPNGZIP TEST FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
