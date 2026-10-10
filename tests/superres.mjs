/**
 * 离线验证「本地 GPU 超分」（Real-ESRGAN ncnn Vulkan）。不联网、不花钱、不需要显卡。
 *
 * 覆盖：
 *   1. 引擎没装时：报错必须说清「怎么装」，不能含糊
 *   2. esrgan-status：装前 / 装后 / 探显卡（真的运行一次引擎）
 *   3. 单测：buildEsrganArgs（尤其 `-m` 必须是绝对路径）/ parseDevices /
 *      diagnoseEngineOutput / validateUpscale
 *   4. 端到端跑通：尺寸、像素、落盘文件名、GPU 名称都要报对
 *   5. **纯黑输出必须判失败** —— 复现本机 K4200 的真实事故：
 *      退出码 0、进度条跑满、却给出一张全黑图。宁可报错，也不能把废图交出去
 *   6. Vulkan 设备丢失 / 显存不足 / 没有产出 / 尺寸不对 / 引擎崩溃 → 都要有明确原因
 *   7. 设备丢失时**自动降 tile 重试**，并把「重试过」这件事说出来
 *   8. 一键下载安装（用本地 HTTP 服务一个自己造的 zip，不碰外网）
 *   9. 「洗图」后端切换：local 走本机、cloud 仍然要 Key
 *
 * 为什么用假引擎（tests/fake-engine.mjs）而不是真引擎：真引擎要一块能跑 Vulkan
 * 的显卡，别的机器上装不出来；而真正需要被钉死的恰恰是**失败姿态** ——
 * 「进程说自己成功」在这条链路上完全不可信。
 *
 * 用法：node tests/superres.mjs
 */
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ESRGAN_LIMITS,
  buildEsrganArgs,
  diagnoseEngineOutput,
  parseDevices,
  probePng,
  validateUpscale,
} from '../esrgan.js'
import { readPngStats } from '../pngzip.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const out = path.join(here, 'out')
const fakeHome = path.join(here, '.fake-home-esrgan')
const fakeHomeInstall = path.join(here, '.fake-home-esrgan-install')
const engineDir = path.join(here, '.fake-engine')
const argsLog = path.join(here, '.fake-engine-args.log')

const nodeExe = process.execPath

let failures = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

/** 每次跑引擎前设一个姿态，跑完清掉。 */
function setMode(mode) {
  if (mode) process.env.FAKE_MODE = mode
  else delete process.env.FAKE_MODE
}

// ------------------------------------------------------- 测试用的小工具（PNG / ZIP）
// 都放在最前面：下面的测试体一上来就要用，函数声明会提升但 const 不会。

/** 一张纯黑 PNG。 */
function buildBlackPng(width, height) {
  return buildPng(width, height, () => [0, 0, 0])
}

/** 一张有内容的 PNG。 */
function buildContentPng(width, height) {
  return buildPng(width, height, (x, y) => [(x * 31) % 256, (y * 17) % 256, (x * y) % 256])
}

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

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function buildPng(width, height, pixel) {
  const rowBytes = width * 3
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const base = y * (rowBytes + 1)
    raw[base] = 0
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
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 造一个 ZIP（stored，不压缩）—— 喂给 installEsrgan 用，不必联网。 */
function makeZip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    parts.push(local, nameBuf, entry.data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(entry.data.length, 20)
    cd.writeUInt32LE(entry.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + entry.data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBuf, eocd])
}

// ---------------------------------------------------------------- 造一个假引擎
await fsp.rm(engineDir, { recursive: true, force: true })
await fsp.mkdir(path.join(engineDir, 'models'), { recursive: true })
// models 目录里要有 .bin，否则 status 会报「没有模型文件」
await fsp.writeFile(path.join(engineDir, 'models', 'realesrgan-x4plus.bin'), Buffer.alloc(64, 1))

// Windows 上 .cmd 包装脚本是很常见的用法（加环境变量、切显卡）。
// 顺带验证插件真的能跑 .cmd —— Node 直接 spawn 它是会抛 EINVAL 的。
const shim =
  '@echo off\r\n' + `"${nodeExe}" "${path.join(here, 'fake-engine.mjs')}" %*\r\n`
await fsp.writeFile(path.join(engineDir, 'fake-esrgan.cmd'), shim, 'utf8')
const engineBin = path.join(engineDir, 'fake-esrgan.cmd')

// ---------------------------------------------------------------- 假宿主
await fsp.rm(fakeHome, { recursive: true, force: true })
await fsp.rm(fakeHomeInstall, { recursive: true, force: true })
await fsp.mkdir(path.join(fakeHome, 'ai-render'), { recursive: true })
await fsp.mkdir(path.join(fakeHomeInstall, 'ai-render'), { recursive: true })

const writeSettings = async (settings, home = fakeHome) =>
  fsp.writeFile(path.join(home, 'ai-render', 'settings.json'), JSON.stringify(settings), 'utf8')

// 一开始没有任何配置：验证「没装引擎」这条路径
await writeSettings({}, fakeHome)
await writeSettings({}, fakeHomeInstall)

process.env.DSH_HOME = fakeHome

const plugin = await import(`file://${path.join(root, 'index.js').replaceAll('\\', '/')}`)
let definition = null
plugin.apply(
  {
    effect: (fn) => fn(),
    commands: { register: (def) => ((definition = def), () => {}) },
    attachments: { async readImage(ref) { return { ref, data: new Uint8Array(await fsp.readFile(ref.__file)) } } },
    sessions: { get: (id) => ({ header: { id, cwd: out } }) },
  },
  {},
)

/** 调一次命令，成功返回解析后的 JSON，失败抛错。 */
const call = async (job, attachments = []) => {
  const result = await definition.handler({
    commandId: 'esrgan',
    agent: { id: 'esrgan-session' },
    rawInput: JSON.stringify({ outDir: out, ...job }),
    attachments,
    signal: new AbortController().signal,
  })
  if (result.kind !== 'success') throw new Error(result.text)
  return JSON.parse(result.text)
}

/** 调一次命令，不抛错，把错误文本带回来（错误路径本身就是要测的东西）。 */
const callError = async (job, attachments = []) => {
  const result = await definition.handler({
    commandId: 'esrgan',
    agent: { id: 'esrgan-session' },
    rawInput: JSON.stringify({ outDir: out, ...job }),
    attachments,
    signal: new AbortController().signal,
  })
  return result.kind === 'success' ? { ok: true, data: JSON.parse(result.text) } : { ok: false, text: result.text }
}

async function imageBlock(file) {
  const bytes = await fsp.readFile(file)
  return {
    type: 'image',
    attachment: {
      attachmentId: path.basename(file),
      mediaType: 'image/png',
      bytes: bytes.length,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      name: path.basename(file),
      __file: file,
    },
  }
}

const cadBlock = await imageBlock(path.join(here, 'fixtures', 'user-cad-front.png'))
const cadBytes = await fsp.readFile(path.join(here, 'fixtures', 'user-cad-front.png'))
const cadStats = readPngStats(cadBytes)
console.log(`底图：${cadStats.width}×${cadStats.height}（亮度 ${cadStats.min}~${cadStats.max}）\n`)

// ---------------------------------------------------------------- 1. 没装引擎
console.log('== 1. 引擎没装时的报错 ==')
{
  const failed = await callError({ taskMode: 'superres' }, [cadBlock])
  check(!failed.ok, '没装引擎时本地超分会失败（而不是静默出一张废图）')
  check(failed.text.includes('还没装本地超分引擎'), '报错说清是「引擎没装」')
  check(failed.text.includes('下载引擎'), '报错给出「下载引擎」这个动作')
  check(/realesrgan-ncnn-vulkan-20220424-windows\.zip/.test(failed.text), '报错带上官方下载地址')
  check(failed.text.includes('本地 GPU 超分失败'), '错误标题点明是本地超分这一步')

  const status = await call({ action: 'esrgan-status' })
  check(status.installed === false, 'status: 未安装')
  check(status.models.length === 3, `status: 列出 3 个模型（实为 ${status.models.length}）`)
  check(typeof status.toolsDir === 'string' && status.toolsDir.includes('realesrgan'), 'status: 给出自管目录')
  check(status.downloadUrl.includes('github.com'), 'status: 给出默认下载地址')
}

// ---------------------------------------------------------------- 2. status / 探测
console.log('\n== 2. 装上之后的 status 与显卡探测 ==')
await writeSettings({ esrganBin: engineBin, esrganModel: 'realesrgan-x4plus', esrganScale: '2', esrganTile: '128' })
{
  const status = await call({ action: 'esrgan-status' })
  check(status.installed === true, 'status: 已安装')
  check(status.bin === engineBin, 'status: 报出引擎的真实路径')
  check(status.source === 'setting', 'status: 标明来源是「设置里指定的路径」')
  check(status.modelsPresent === true, 'status: 认出 models 目录里有 .bin')
  check(status.scale === 2 && status.tile === 128, `status: 回读设置里的倍数与 tile（${status.scale} / ${status.tile}）`)
  check(!status.probe, 'status: 不带 probe 时不去跑引擎（省时间）')

  const probed = await call({ action: 'esrgan-status', probe: true })
  check(probed.probe?.ok === true, 'probe: 引擎可用')
  check(probed.probe?.runnable === true, 'probe: 标记 runnable（真的算出了一张图）')
  check(
    probed.probe.devices.some((item) => item.name === 'Fake Vulkan GPU'),
    `probe: 认出显卡名（${probed.probe.devices.map((item) => item.name).join('、')}）`,
  )
  check(probed.probe.devices.length === 1, `probe: 同一块卡只报一次（实为 ${probed.probe.devices.length}）`)
  // 设置里是 tile 128 → 探针图取 2×tile = 256：tile 才是显存的决定因素，
  // 拿小图去探大 tile 会「假成功」（ncnn 会把 tile 收敛到图的大小）。
  check(probed.probe.probeSize === '256×256', `probe: 探针图按 tile 走（${probed.probe.probeSize}）`)

  // 引擎根本跑不动时要如实说 —— 这才是 probe 存在的意义
  setMode('device-lost')
  const broken = await call({ action: 'esrgan-status', probe: true })
  setMode(null)
  check(broken.probe.ok === false, 'probe: 跑不动时 ok=false')
  check(broken.probe.runnable === false, 'probe: 跑不动时 runnable=false')
  check(/本地 GPU 超分失败/.test(broken.probe.reason), `probe: 带上失败原因（${broken.probe.reason.slice(0, 40)}…）`)
}

// ---------------------------------------------------------------- 2.5 探针会试一档更小的 tile
console.log('\n== 2.5 配置的 tile 跑不通时，探针自己降一档并把结论说出来 ==')
{
  // 设置成 128，假引擎在 tile>=128 时设备丢失、<128 正常
  await writeSettings({ esrganBin: engineBin, esrganModel: 'realesrgan-x4plus', esrganScale: '2', esrganTile: '128' })
  setMode('device-lost-retry')
  const probed = await call({ action: 'esrgan-status', probe: true })
  setMode(null)
  check(probed.probe.ok === true, 'probe: 降档后能跑通')
  check(probed.probe.configuredTile === 128, 'probe: 记住配置的 tile 是 128')
  check(probed.probe.recommendedTile === 64, `probe: 建议用 tile 64（实为 ${probed.probe.recommendedTile}）`)
  check(/tile 128 上跑不了/.test(probed.probe.hint), `probe: 直说「128 跑不了、64 可以」：${probed.probe.hint}`)
  // 还原成 64，后面的用例按默认走
  await writeSettings({ esrganBin: engineBin, esrganModel: 'realesrgan-x4plus', esrganScale: '2', esrganTile: '64' })
}

// ---------------------------------------------------------------- 3. 单测
console.log('\n== 3. 单测：参数 / 日志解析 / 结果校验 ==')
{
  const args = buildEsrganArgs({
    input: 'C:\\in.png',
    output: 'C:\\out.png',
    model: 'realesrgan-x4plus',
    scale: 4,
    tile: 128,
    modelsDir: 'C:\\tools\\models',
  })
  check(args.includes('-f') && args[args.indexOf('-f') + 1] === 'png', 'args: 固定输出 png')
  check(args[args.indexOf('-m') + 1] === 'C:\\tools\\models', 'args: -m 用的是传进来的模型目录')
  check(args[args.indexOf('-n') + 1] === 'realesrgan-x4plus', 'args: -n 带上模型名')
  check(args[args.indexOf('-s') + 1] === '4', 'args: -s 带上倍数')
  check(args[args.indexOf('-t') + 1] === '128', 'args: -t 带上 tile')
  check(args.includes('-v'), 'args: 带 -v（要靠它拿设备名与报错）')
  check(!args.includes('-g'), 'args: 没指定 GPU 时不传 -g')
  check(!args.includes('-x'), 'args: 没开 TTA 时不传 -x')

  const withGpu = buildEsrganArgs({ input: 'a', output: 'b', modelsDir: 'm', gpu: '1', tta: true, tile: 0 })
  check(withGpu[withGpu.indexOf('-g') + 1] === '1', 'args: 指定了 GPU 就传 -g')
  check(withGpu[withGpu.indexOf('-t') + 1] === '0', 'args: tile=0 时传 0（交给引擎自己算）')
  check(withGpu.includes('-x'), 'args: 开了 TTA 就传 -x')

  const devices = parseDevices(
    '[0 Quadro K4200]  queueC=0[16]\n[1 NVIDIA GeForce RTX 4090]  queueC=0[16]\nnot a device line',
  )
  check(devices.length === 2, `parseDevices: 认出 2 个设备（实为 ${devices.length}）`)
  check(devices[0].name === 'Quadro K4200' && devices[1].id === 1, 'parseDevices: 名字与编号都对')

  const lost = diagnoseEngineOutput('vkWaitForFences failed -4\nvkQueueSubmit failed -4')
  check(lost.deviceLost === true, 'diagnose: 认出 Vulkan 设备丢失')
  check(lost.failures[0].hint.includes('tile'), 'diagnose: 设备丢失给出的建议里有 tile')
  const oom = diagnoseEngineOutput('vkAllocateMemory failed -2')
  check(oom.failures[0]?.kind === 'out-of-memory', 'diagnose: 认出显存不足')
  check(diagnoseEngineOutput('0.00%\n25.00%\ndone').failures.length === 0, 'diagnose: 正常输出不误报')

  // 「算完了却写不出文件」必须是独立的一条：实测有机器整个 C: 盘都写不进去，
  // 报的就是 `encode image ... failed`，而退出码仍然是 0。
  const writeFail = diagnoseEngineOutput('encode image C:\\x\\y.png failed')
  check(writeFail.failures[0]?.kind === 'write-failed', 'diagnose: 认出「引擎写不出文件」')
  check(/不可写/.test(writeFail.failures[0]?.hint ?? ''), 'diagnose: 给出「换个盘」的建议')
  const decodeFail = diagnoseEngineOutput('decode image C:\\x\\in.png failed')
  check(decodeFail.failures[0]?.kind === 'input-unreadable', 'diagnose: 认出「读不出输入图」')

  // 探针图：必须有内容，否则「输出纯色」这条校验会被自己的探针图骗过去
  const probe = readPngStats(probePng(64))
  check(probe?.width === 64 && probe.height === 64, `probePng: 尺寸正确（${probe?.width}×${probe?.height}）`)
  check(probe.max - probe.min > 2, `probePng: 有内容（亮度 ${probe.min}~${probe.max}）`)
  check(readPngStats(probePng(4096))?.width === 1024, 'probePng: 尺寸有上限，不会造出巨图')

  // validateUpscale：纯色判定要跟**输入**比，不能只看输出黑不黑
  const black = buildBlackPng(8, 8)
  const content = buildContentPng(8, 8)
  const inputHasContent = readPngStats(content)
  const inputFlat = readPngStats(black)

  const blankResult = validateUpscale({
    outputBuffer: black,
    inputStats: inputHasContent,
    scale: 1,
    inputWidth: 8,
    inputHeight: 8,
  })
  check(blankResult.ok === false, 'validate: 输入有内容、输出纯黑 → 判失败')
  check(/全黑/.test(blankResult.problems.join(' ')), 'validate: 说清「输出是一片全黑」')

  const flatOk = validateUpscale({
    outputBuffer: black,
    inputStats: inputFlat,
    scale: 1,
    inputWidth: 8,
    inputHeight: 8,
  })
  check(flatOk.ok === true, 'validate: 输入本身就是纯色 → 不误判（色卡这种图是正常用法）')

  const wrongSize = validateUpscale({
    outputBuffer: content,
    inputStats: inputHasContent,
    scale: 4,
    inputWidth: 8,
    inputHeight: 8,
  })
  check(wrongSize.ok === false && /尺寸不对/.test(wrongSize.problems.join(' ')), 'validate: 尺寸不对 → 判失败')

  const empty = validateUpscale({ outputBuffer: Buffer.alloc(0), inputStats: inputHasContent, scale: 2 })
  check(empty.ok === false && /没有产出任何文件/.test(empty.problems.join(' ')), 'validate: 空输出 → 判失败')

  const garbage = validateUpscale({ outputBuffer: Buffer.from('not a png'), inputStats: inputHasContent, scale: 2 })
  check(garbage.ok === false && /解不开/.test(garbage.problems.join(' ')), 'validate: 坏文件 → 判失败')

  check(ESRGAN_LIMITS.minTile === 32 && ESRGAN_LIMITS.hardSide === 16384, 'limits: 下限/硬上限都在')
}

// ---------------------------------------------------------------- 4. 端到端跑通
console.log('\n== 4. 端到端：假引擎跑通本地超分 ==')
{
  await fsp.rm(argsLog, { force: true })
  process.env.FAKE_LOG = argsLog
  setMode('ok')
  const result = await call(
    { taskMode: 'superres', esrganScale: '2', esrganTile: '128', esrganModel: 'realesrgan-x4plus' },
    [cadBlock],
  )
  setMode(null)
  delete process.env.FAKE_LOG

  check(result.ok === true, '本地超分成功')
  check(result.provider === 'local', 'provider 标记为 local（不走云通道）')
  check(result.providerLabel.includes('本地 GPU 超分'), `providerLabel 是人话：${result.providerLabel}`)
  check(result.taskMode === 'superres', 'taskMode 是 superres')
  check(result.size === `${cadStats.width * 2}x${cadStats.height * 2}`, `尺寸是输入 ×2：${result.size}`)
  check(result.sourceSize === `${cadStats.width}x${cadStats.height}`, `回报了原始尺寸：${result.sourceSize}`)
  check(result.local.device === 'Fake Vulkan GPU', `回报了 GPU 名字：${result.local.device}`)
  check(result.local.tile === 128, '回报了实际使用的 tile')
  check(result.local.engine === engineBin, '回报了引擎路径')
  check(Array.isArray(result.local.warnings) && result.local.warnings.length === 0, '没有多余告警')
  check(result.files.length === 1, '产出 1 个文件')
  check(/^upscale_\d{8}_\d{6}_2x\.png$/.test(result.files[0].name), `文件名规范：${result.files[0].name}`)

  // 落盘的图必须是真图：尺寸对、不是纯色
  const written = readPngStats(await fsp.readFile(result.files[0].path))
  check(written.width === cadStats.width * 2 && written.height === cadStats.height * 2, '磁盘上的图尺寸正确')
  check(written.max - written.min > 2, `磁盘上的图有内容（亮度 ${written.min}~${written.max}）`)

  // 引擎收到的参数：`-m` 必须是绝对路径（相对路径会按工作目录解析，必然找不到模型）
  const logged = (await fsp.readFile(argsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  check(logged.length === 1, `引擎只被调用 1 次（实为 ${logged.length}）`)
  const argv = logged[0].argv
  const modelsArg = argv[argv.indexOf('-m') + 1]
  check(path.isAbsolute(modelsArg), `-m 是绝对路径：${modelsArg}`)
  check(path.resolve(modelsArg) === path.join(engineDir, 'models'), '-m 指向引擎旁边的 models 目录')
  check(argv[argv.indexOf('-f') + 1] === 'png', '引擎收到了 -f png')
  check(argv[argv.indexOf('-s') + 1] === '2', '引擎收到了 -s 2')
  check(argv[argv.indexOf('-t') + 1] === '128', '引擎收到了 -t 128')
  // 中间文件必须放在**出图目录**里，不能放系统 temp：
  // 实测有机器上引擎对 C: 盘整盘写不进去（系统 temp 就在 C:），放那儿等于必然失败。
  check(
    path.resolve(path.dirname(argv[argv.indexOf('-i') + 1])).startsWith(path.resolve(out)),
    `中间文件在出图目录里（${path.dirname(argv[argv.indexOf('-i') + 1])}）`,
  )
  check(
    (await fsp.readdir(out)).every((name) => !name.startsWith('.esrgan-')),
    '跑完把临时目录清掉了（出图目录里不留 .esrgan-*）',
  )
}

// ---------------------------------------------------------------- 5. 纯黑必须是失败
console.log('\n== 5. 纯黑输出必须判失败（复现 K4200 的真实事故）==')
{
  setMode('black')
  const failed = await callError({ taskMode: 'superres', esrganScale: '2', esrganTile: '128' }, [cadBlock])
  setMode(null)
  check(!failed.ok, '退出码 0 + 纯黑图 → 插件判失败（绝不把废图当成功）')
  check(failed.text.includes('本地 GPU 超分失败'), '错误标题正确')
  check(/全黑/.test(failed.text), '说清「输出是一片全黑」')
  check(/GPU 没有真正算出结果/.test(failed.text), '点明原因是「GPU 没算出来」')
  check(/试过的 tile/.test(failed.text) && /识别到的 GPU/.test(failed.text), '诊断信息里带上 tile 与 GPU')
  check(failed.text.includes('Fake Vulkan GPU'), '诊断信息里带上识别到的显卡名')
}

// ---------------------------------------------------------------- 6. 各种失败姿态
console.log('\n== 6. 各种失败都要有明确原因 ==')
{
  const cases = [
    { mode: 'device-lost', label: 'Vulkan 设备丢失', expect: /设备丢失/ },
    { mode: 'oom', label: '显存不足', expect: /显存不足/ },
    { mode: 'no-file', label: '没有产出文件', expect: /没有产出任何文件/ },
    { mode: 'wrong-size', label: '尺寸不对', expect: /尺寸不对/ },
    { mode: 'bad-model', label: '模型读不到', expect: /模型文件读不到/ },
  ]
  for (const item of cases) {
    setMode(item.mode)
    const failed = await callError({ taskMode: 'superres', esrganScale: '2', esrganTile: '128' }, [cadBlock])
    setMode(null)
    check(!failed.ok, `${item.label}：判失败`)
    check(item.expect.test(failed.text), `${item.label}：原因说清楚了`)
  }

  setMode('crash')
  const crashed = await callError({ taskMode: 'superres', esrganScale: '2' }, [cadBlock])
  setMode(null)
  check(!crashed.ok, '引擎崩溃（退出码 1）：判失败')
}

// ---------------------------------------------------------------- 7. 自动降 tile 重试
console.log('\n== 7. 设备丢失时自动降 tile 重试 ==')
{
  await fsp.rm(argsLog, { force: true })
  process.env.FAKE_LOG = argsLog
  setMode('device-lost-retry')
  const result = await call({ taskMode: 'superres', esrganScale: '2', esrganTile: '128' }, [cadBlock])
  setMode(null)
  delete process.env.FAKE_LOG

  check(result.local.tile === 64, `自动降到 tile 64 后成功（实际 ${result.local.tile}）`)
  check(result.local.attempts.length === 2, `引擎跑了 2 次（实为 ${result.local.attempts.length}）`)
  check(result.local.attempts[0].tile === 128 && result.local.attempts[1].tile === 64, '两次的 tile 依次是 128 → 64')
  const logged = (await fsp.readFile(argsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  check(logged.length === 2, '引擎确实被调用了两次')
  check(
    logged[1].argv[logged[1].argv.indexOf('-t') + 1] === '64',
    '第二次传给引擎的 -t 是 64',
  )
}

// ---------------------------------------------------------------- 8. 洗图后端切换
console.log('\n== 8.「洗图」后端切换：本地 / 云 ==')
{
  setMode('ok')
  const local = await call({ taskMode: 'wash', washBackend: 'local', esrganScale: '2' }, [cadBlock])
  setMode(null)
  check(local.provider === 'local', 'wash + local → 走本机，不需要 Key')
  check(local.taskMode === 'superres', 'wash + local → 归到本地超分')

  // 同一个操作、同一个底图，切回云通道就必须去要 Key —— 证明这个开关真的在起作用
  const cloud = await callError({ taskMode: 'wash', washBackend: 'cloud' }, [cadBlock])
  check(!cloud.ok, 'wash + cloud → 仍然走云通道（没有 Key 就失败）')
  check(/API Key|Key/.test(cloud.text), `wash + cloud 的失败原因是要 Key：${cloud.text.slice(0, 60)}`)

  const missing = await callError({ taskMode: 'superres' }, [])
  check(!missing.ok && /需要一张图/.test(missing.text), '没有图时提示要导入底图')
}

// ---------------------------------------------------------------- 9. 一键下载安装
console.log('\n== 9. 一键下载安装引擎（本地 HTTP，不碰外网）==')
{
  const payload = Buffer.from('MZ fake realesrgan binary payload for tests')
  // 模型故意做大到 1MB 以上：installEsrgan 有一条「小于 1MB 肯定不是引擎包」的
  // 防线（真实的模型文件是 33MB 那个量级），测试必须跨过它才测得到后面的逻辑。
  const archive = makeZip([
    { name: 'realesrgan-ncnn-vulkan.exe', data: payload },
    { name: 'models/realesrgan-x4plus.bin', data: Buffer.alloc(1_200_000, 7) },
    { name: 'models/realesrgan-x4plus.param', data: Buffer.from('param', 'utf8') },
    { name: 'README_windows.md', data: Buffer.from('# readme', 'utf8') },
  ])
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/zip')
    res.end(archive)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/realesrgan.zip`

  // 换一个干净的 DSH_HOME：验证「不靠设置里的路径、靠自管目录也能找到引擎」
  process.env.DSH_HOME = fakeHomeInstall
  try {
    const installed = await call({ action: 'esrgan-install', esrganDownloadUrl: url })
    check(installed.installed === true, '安装后 status 报「已安装」')
    check(installed.install.bytes === archive.length, '回报下载字节数')
    check(installed.install.files === 4, `解出 4 个文件（实为 ${installed.install.files}）`)
    check(installed.source === 'managed', '来源标成「插件自管目录」')
    check(installed.bin.endsWith('realesrgan-ncnn-vulkan.exe'), `引擎落到了自管目录：${installed.bin}`)
    check(installed.modelsPresent === true, 'models 目录被认出来')
    const onDisk = await fsp.readFile(installed.bin)
    check(onDisk.equals(payload), '解出来的 exe 内容与 zip 里一致（真的解压了，不是写了个空壳）')

    // 坏地址要说清是「下载失败」，而不是含糊报错
    const bad = await callError({ action: 'esrgan-install', esrganDownloadUrl: 'http://127.0.0.1:1/none.zip' })
    check(!bad.ok, '下载失败时判失败')
    check(/下载超分引擎失败/.test(bad.text), '错误标题点明是「下载引擎」这一步')
  } finally {
    server.close()
    process.env.DSH_HOME = fakeHome
  }
}

// ---------------------------------------------------------------- 收尾
await fsp.rm(fakeHomeInstall, { recursive: true, force: true })
await fsp.rm(engineDir, { recursive: true, force: true })
await fsp.rm(argsLog, { force: true })

console.log('')
if (failures) {
  console.log(`SUPERRES TEST FAILED (${failures})`)
  process.exit(1)
}
console.log('SUPERRES TEST PASSED')
process.exit(0)
