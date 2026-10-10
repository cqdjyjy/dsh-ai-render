/**
 * 本地 GPU 超分引擎接入层（Real-ESRGAN ncnn Vulkan）。
 *
 * 为什么是 Real-ESRGAN ncnn Vulkan（业界事实标准，Upscayl 打包的就是它）：
 *   - 免 CUDA、免 Python、免 PyTorch —— 一个 exe + 几个模型文件就能跑
 *   - 走 **Vulkan** 调 GPU，Intel / AMD / NVIDIA 独显核显通吃
 *   - 模型只有几十 MB，可以随用随下，不需要用户折腾运行环境
 *
 * 本模块只干三件事，且刻意不依赖任何外部包（workspace 链接的插件解析不到
 * dsh 内置包，一 import 失败整行插件就起不来）：
 *   1. **找到引擎** —— 设置里的路径 > 插件自管目录 > PATH
 *   2. **跑超分** —— 拼参数、起子进程、超时中断
 *   3. **校验结果** —— 这一步是这个功能能不能信的关键，见下面 validateUpscale
 *
 * ## 为什么「校验结果」是必需品而不是加分项
 *
 * 实测（本机 Quadro K4200 / Kepler / 4GB）：引擎会**退出码 0、跑完进度条、
 * 报告 done，然后吐出一张 1600×1068 的纯黑 PNG**（5077 字节）。
 * 同时 stderr 上是 `vkWaitForFences failed -4` / `vkQueueSubmit failed -4`
 * （VK_ERROR_DEVICE_LOST）。也就是说：**GPU 什么也没算出来，但进程自称成功。**
 *
 * 用户最恨的就是这种静默失败 —— 拿到一张全黑的图，还不知道是哪一步坏的。
 * 所以这里坚持三条：
 *   - 退出码只是「参考」，不作数；以**解码后的像素**为准
 *   - 输入有内容、输出却是纯色 → 判定失败，并把 GPU 名字、tile、日志一起报出来
 *   - 校验不了（解不开 PNG）也要**明说校验不了**，不含糊放行
 *
 * @module @local/dsh-ai-render/esrgan
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { readPngStats, unzipToDir } from './pngzip.js'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 可用的模型。别硬写死「只有 x4plus」—— 显存小或者跑动漫图时，
 * 换一个模型往往就是「能不能跑起来」的差别。
 */
export const ESRGAN_MODELS = [
  {
    id: 'realesrgan-x4plus',
    label: '写实（推荐）',
    hint: '真实照片与效果图的主力模型，细节与质感最好，显存占用也最大',
    scales: [2, 3, 4],
  },
  {
    id: 'realesrgan-x4plus-anime',
    label: '动漫 / 插画',
    hint: '二次元、插画、线条类画面，写实图别用',
    scales: [2, 3, 4],
  },
  {
    id: 'realesr-animevideov3',
    label: '轻量（最省显存）',
    hint: '模型最小、显存占用最低：老显卡或 4GB 以下显存可以先拿它试通',
    scales: [2, 3, 4],
  },
]

/** 官方 Release（v0.2.5.0）里的 Windows 包，约 43MB，含 exe + 全部模型。 */
export const ESRGAN_RELEASE_URL =
  'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip'

/** 校验与超时用的硬边界。 */
export const ESRGAN_LIMITS = {
  /** 输出长边超过这个值就提示（不拦），再往上乘会很慢、文件很大。 */
  warnSide: 8192,
  /** 输出长边超过这个值直接拒绝：再大基本是误操作，不是需求。 */
  hardSide: 16384,
  /** tile 低于这个值 ncnn 自己也不认（官方说 >=32）。 */
  minTile: 32,
}

// ---------------------------------------------------------------- 探针图（最小 PNG 编码器）

/**
 * 最小 PNG 编码器：8 位 RGB、filter 0、无隔行。
 *
 * 只为一件事存在 —— **探活要用一张真图**。实测真引擎在 `-h` 或不带参数时
 * 只打印用法、**不枚举 Vulkan 设备**；设备信息是真正处理图片时才打印的。
 * 所以「这块卡能不能跑」这个问题，只有让它真算一张图才能回答。
 *
 * 刻意不引入任何图像库：插件必须零外部依赖（见 README 的维护者说明）。
 */
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

/** 生成一张 side×side 的梯度图（必须有内容，否则纯色判定会失效）。 */
export function probePng(side = 256) {
  const size = Math.max(8, Math.min(1024, Math.round(side)))
  const rowBytes = size * 3
  const raw = Buffer.alloc((rowBytes + 1) * size)
  for (let y = 0; y < size; y += 1) {
    const base = y * (rowBytes + 1)
    raw[base] = 0 // filter: None
    for (let x = 0; x < size; x += 1) {
      const at = base + 1 + x * 3
      raw[at] = (x * 7 + y * 3) % 256
      raw[at + 1] = (x * 3) % 256
      raw[at + 2] = (y * 5 + 40) % 256
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colorType: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- 定位引擎
/** 插件自管目录：引擎下到这里，跟着 DSH_HOME 走，不污染系统目录。 */
export function esrganToolsDir(dshHome) {
  return path.join(dshHome, 'ai-render', 'tools', 'realesrgan')
}

/** Windows 上是 .exe，其它平台是裸文件名。 */
export function esrganExeName(platform = process.platform) {
  return platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan'
}

/**
 * 找一个能用的引擎。返回 `{ bin, modelsDir, source }`，找不到返回 `null`。
 *
 * 顺序：设置里的显式路径 > 插件自管目录 > PATH。
 * **模型目录一定是「exe 旁边的 models」并使用绝对路径** —— 因为
 * `-m models` 是相对**进程工作目录**解析的，而我们的工作目录是用户会话目录，
 * 用默认值 100% 找不到模型。
 */
export async function locateEsrgan({ settings = {}, dshHome, platform = process.platform, resolveExecutable } = {}) {
  const exe = esrganExeName(platform)

  /** 给定 exe 路径，确认文件真的在，并推导模型目录。 */
  const asPath = async (candidate, source) => {
    if (!candidate || typeof candidate !== 'string') return null
    const raw = candidate.trim().replace(/^"|"$/g, '')
    if (!raw) return null
    try {
      const stat = await fsp.stat(raw)
      if (stat.isDirectory()) {
        const inner = path.join(raw, exe)
        await fsp.access(inner)
        return { bin: inner, modelsDir: path.join(raw, 'models'), source }
      }
      if (stat.isFile()) {
        return { bin: raw, modelsDir: path.join(path.dirname(raw), 'models'), source }
      }
    } catch {
      return null
    }
    return null
  }

  // 1. 设置里显式指定的路径 / 命令名
  const configured = typeof settings.esrganBin === 'string' ? settings.esrganBin.trim() : ''
  if (configured) {
    const byPath = await asPath(configured, 'setting')
    if (byPath) return byPath
    // 也可能给的是「命令名」，交给宿主解析（Windows 上的 .cmd / .ps1 shim 就是这么处理的）
    if (typeof resolveExecutable === 'function') {
      try {
        const resolved = await resolveExecutable(configured)
        const byResolved = await asPath(resolved, 'setting')
        if (byResolved) return byResolved
      } catch {
        /* 解析不了就继续往下试 */
      }
    }
  }

  // 2. 插件自管目录（「下载引擎」装到这里）
  if (dshHome) {
    const managed = await asPath(esrganToolsDir(dshHome), 'managed')
    if (managed) return managed
  }

  // 3. PATH 上现成的（用户自己装过 Upscayl / 手动解压并加了 PATH）
  if (typeof resolveExecutable === 'function') {
    try {
      const resolved = await resolveExecutable('realesrgan-ncnn-vulkan')
      const byPath = await asPath(resolved, 'path')
      if (byPath) return byPath
    } catch {
      /* 没有就算了 */
    }
  }

  return null
}

// ---------------------------------------------------------------- 拼参数 / 读日志

/**
 * 组命令行。
 *
 * 两个必须显式给、不能靠默认值的参数：
 *   - `-m <绝对模型目录>`：默认 `models` 相对进程工作目录，必然找不到
 *   - `-f png`：默认跟随输出后缀，我们固定要 PNG（无损，且好做像素校验）
 */
export function buildEsrganArgs({
  input,
  output,
  model = 'realesrgan-x4plus',
  scale = 4,
  tile = 0,
  gpu = '',
  tta = false,
  modelsDir = '',
} = {}) {
  const args = ['-i', String(input), '-o', String(output), '-f', 'png', '-v']
  if (modelsDir) args.push('-m', String(modelsDir))
  if (model) args.push('-n', String(model))
  args.push('-s', String(scale))
  // tile=0 交给 ncnn 自己按显存算；其余情况给明确值（4GB 显存要压到 128~192）
  args.push('-t', String(Number(tile) > 0 ? Number(tile) : 0))
  if (String(gpu).trim() !== '') args.push('-g', String(gpu).trim())
  if (tta) args.push('-x')
  return args
}

/**
 * 从引擎输出里认出用了哪块 GPU。
 *
 * ncnn 的 `-v` 会打一行 `[0 Quadro K4200]  queueC=0[16] ...`。
 * 把设备名报给用户很重要：多卡机器上跑错卡、或者静默回退到核显，
 * 用户看耗时不对劲却不知道原因。
 *
 * **注意要去重**：ncnn 对**同一块卡**会连着打好几行（队列、精度、子组各一行），
 * 不去重的话一块卡会被报成三块（实测踩到过）。
 */
export function parseDevices(text) {
  const byId = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\[(\d+)\s+([^\]]+)\]/)
    if (!match) continue
    const id = Number(match[1])
    if (!byId.has(id)) byId.set(id, { id, name: match[2].trim() })
  }
  return [...byId.values()].sort((left, right) => left.id - right.id)
}

/**
 * 从引擎输出里认故障。
 *
 * 为什么要认字符串：这台机器上的实测是**退出码 0 + 全黑输出**，
 * 唯一可靠的线索就是 stderr 里的 Vulkan 报错。退出码在这里没有意义。
 */
export function diagnoseEngineOutput(text) {
  const body = String(text ?? '')
  const failures = []
  if (/vkWaitForFences failed|vkQueueSubmit failed|VK_ERROR_DEVICE_LOST|device\s+lost/i.test(body)) {
    failures.push({
      kind: 'device-lost',
      label: 'Vulkan 设备丢失（GPU 计算中断）',
      hint:
        '显卡驱动或架构撑不住这次的 Vulkan 计算负载。**先把 tile 调到 64 或 32** 再试' +
        '（实测一块 4GB 的 Quadro K4200：tile 128 稳定失败、tile 64 正常，与图的大小无关），' +
        '还不行就换「轻量」模型；仍然失败说明这块卡跑不动 ncnn Vulkan，改用云 AI 通道。',
    })
  }
  if (/vkAllocateMemory failed|out of memory|OutOfMemory|VK_ERROR_OUT_OF_DEVICE_MEMORY/i.test(body)) {
    failures.push({
      kind: 'out-of-memory',
      label: '显存不足',
      hint: '把 tile 调小（默认 64；2GB 显存用 32），或换「轻量」模型，或把放大倍数降到 2。',
    })
  }
  // 引擎算完了却写不出文件。实测存在这种机器：C: 盘整盘都写不进去
  // （系统 temp、桌面、用户目录全试过，报的都是这句），换到 D: 就正常。
  // 所以这**不是**「图像编码坏了」，而是「这个位置不可写」，必须分开说。
  if (/encode image .* failed/i.test(body)) {
    failures.push({
      kind: 'write-failed',
      label: '引擎无法写入输出文件',
      hint:
        '引擎算完了却写不出文件：这个目录对这个进程不可写（实测有机器整个 C: 盘都写不进去，' +
        '系统 temp / 桌面 / 用户目录都一样），也可能是磁盘满了或被杀毒软件的「受控文件夹访问」拦了。' +
        '把出图目录换到另一个盘再试。',
    })
  }
  if (/decode image .* failed/i.test(body)) {
    failures.push({
      kind: 'input-unreadable',
      label: '引擎读不出输入图',
      hint: '输入图不是引擎认得的格式（只认 png / jpg / webp）。换一张 PNG 再试。',
    })
  }
  if (/findFile failed|failed to load|invalid model|not found/i.test(body) && !failures.length) {
    failures.push({
      kind: 'model',
      label: '模型文件读不到',
      hint: '引擎旁边的 models 目录不完整。用「下载引擎」重装一次，或检查设置里的引擎路径。',
    })
  }
  return { failures, deviceLost: failures.some((item) => item.kind === 'device-lost') }
}

// ---------------------------------------------------------------- 结果校验

/**
 * 校验超分结果。**这是整个功能能不能信的地方。**
 *
 * 判据（顺序即优先级）：
 *   1. 文件字节 > 0 且能解出 8 位 PNG 像素
 *   2. 尺寸 == 输入 × 倍数（Real-ESRGAN 是精确整数倍，差一个像素都算异常）
 *   3. **纯色检测**：输入有明显内容（max-min > 2），输出却是纯色（max-min <= 2）
 *      → 判定「GPU 没有真正算出来」。
 *
 * 为什么纯色检测要跟**输入**比，而不是直接看输出黑不黑：
 * 用户完全可能就传了一张纯色图（色卡、纯色背景）。只看输出会把这种正常情况
 * 误判成失败。跟输入比就不会：输入本来就没内容，那输出没内容是对的。
 */
export function validateUpscale({ outputBuffer, inputStats, scale, inputWidth, inputHeight } = {}) {
  const problems = []
  const advanced = []

  if (!outputBuffer || outputBuffer.length === 0) {
    return {
      ok: false,
      problems: ['引擎没有产出任何文件（输出为空）'],
      advanced,
      stats: null,
      verified: false,
    }
  }

  const stats = readPngStats(outputBuffer)
  if (!stats) {
    return {
      ok: false,
      problems: ['输出文件解不开（不是合法的 8 位 PNG，可能写了一半就被中断）'],
      advanced,
      stats: null,
      verified: false,
    }
  }

  const ratio = Number(scale) > 0 ? Number(scale) : 0
  if (ratio > 0 && inputWidth > 0 && inputHeight > 0) {
    const expectWidth = inputWidth * ratio
    const expectHeight = inputHeight * ratio
    if (stats.width !== expectWidth || stats.height !== expectHeight) {
      problems.push(
        `输出尺寸不对：期望 ${expectWidth}×${expectHeight}（${inputWidth}×${inputHeight} × ${ratio}），` +
          `实际 ${stats.width}×${stats.height}`,
      )
    }
  }

  const inputHasContent = Boolean(inputStats) && inputStats.max - inputStats.min > 2
  const outputIsFlat = stats.max - stats.min <= 2
  if (inputHasContent && outputIsFlat) {
    const tone = stats.max <= 2 ? '全黑' : stats.max >= 253 ? '全白' : `纯色（RGB≈${stats.max}）`
    problems.push(
      `输出是一片${tone}：输入明显有内容（亮度 ${inputStats.min}~${inputStats.max}），` +
        `输出却完全没有变化（${stats.min}~${stats.max}）。说明 GPU 没有真正算出结果。`,
    )
  } else if (!inputStats) {
    advanced.push('输入图不是 8 位 PNG，没能做「输入有内容 / 输出纯色」的比对。')
  }

  return { ok: problems.length === 0, problems, advanced, stats, verified: true }
}

// ---------------------------------------------------------------- 起子进程

/**
 * 起一个子进程并收集输出。
 *
 * 与 index.js 里那个 runCommand 的区别：这里要**显式管超时**并把子进程杀掉。
 * 超分可能跑几分钟，卡住时不杀会一直挂着（面板上就是永远「正在超分」）。
 */
function runProcess(command, args, { timeoutMs = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child
    const options = { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    try {
      // Windows 上 .cmd / .bat **不能直接 spawn**：Node 会同步抛 EINVAL。
      // 但用户完全可能把「引擎路径」指向自己写的 .cmd 包装脚本（加环境变量、
      // 切显卡、套代理都很常见），所以这里给它们走 shell 这条路。
      // 代价：shell 模式下 Node 只是把参数用空格拼起来，不会加引号 ——
      // 所以参数里的空格必须我们自己补引号，否则路径一带空格就散架。
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
        const quote = (text) => (/[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '')}"` : text)
        // 自己拼成一整条命令行再交给 shell：不要用「shell:true + args 数组」那种写法，
        // Node 会报 DEP0190（它只是把数组用空格拼起来，并不转义，等于骗你）。
        // 代价是参数里的空格必须我们自己补引号 —— 下面就是干这个的。
        const line = [quote(command), ...args.map((value) => quote(String(value)))].join(' ')
        child = spawn(line, { ...options, shell: true })
      } else {
        child = spawn(command, args, options)
      }
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timer = null
    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        onAbort()
      }, timeoutMs)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      cleanup()
      resolve({ code, stdout, stderr, timedOut, text: `${stdout}\n${stderr}` })
    })
  })
}

// ---------------------------------------------------------------- 跑一次超分

/**
 * 跑一次本地 GPU 超分。
 *
 * 失败时**自动降 tile 重试一次**：tile 是唯一一个「调小只有好处、没有副作用」的
 * 参数（结果完全一样，只是慢一点），拿它当第一道兜底最划算。
 * 不自动换模型 —— 换模型会改变画面，属于用户的选择，不能替他做。
 *
 * ## `tmpDir` 请务必给出图目录那种「确认可写」的位置
 *
 * 不传就走系统 temp —— **但那在某些机器上会让引擎彻底写不出文件**。
 * 实测这台机器：引擎对 `C:` 盘**整盘**都无法写入（系统 temp、桌面、用户目录全试过），
 * 报的是 `encode image <path> failed`，退出码仍然是 0；换到 `D:` 就一切正常。
 * 既然最终那张图本来就要写进出图目录，把中间文件也放那里最稳。
 */
export async function runUpscale({
  bin,
  modelsDir,
  inputBuffer,
  inputStats = null,
  model = 'realesrgan-x4plus',
  scale = 4,
  tile = 128,
  gpu = '',
  tta = false,
  timeoutMs = 600000,
  signal,
  tmpDir,
  maxSide = ESRGAN_LIMITS.hardSide,
} = {}) {
  if (!bin) throw new Error('内部错误：没有可用的引擎路径。')
  if (!inputBuffer || inputBuffer.length === 0) throw new Error('没有可超分的图片数据。')

  const inputSize = readPngStats(inputBuffer)
  if (!inputSize) throw new Error('输入图不是可解析的 8 位 PNG，本地超分只接受 PNG。')

  const ratio = Number(scale) > 0 ? Number(scale) : 4
  const outSide = Math.max(inputSize.width, inputSize.height) * ratio
  if (outSide > maxSide) {
    throw new Error(
      `输出会到 ${Math.round(outSide)} 像素（长边），超过上限 ${maxSide}。` +
        `输入是 ${inputSize.width}×${inputSize.height}、放大 ${ratio} 倍。` +
        '把放大倍数调小，或先把图裁小再超分。',
    )
  }

  const work = tmpDir || (await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-render-esrgan-')))
  const createdWork = !tmpDir
  await fsp.mkdir(work, { recursive: true })

  const warnings = []
  if (outSide > ESRGAN_LIMITS.warnSide) {
    warnings.push(`输出长边 ${Math.round(outSide)} 像素，文件会比较大、耗时也长（tile 越小越慢）。`)
  }

  try {
    return await runUpscaleAttempts({
      bin,
      modelsDir,
      inputBuffer,
      inputSize,
      model,
      ratio,
      outSide,
      configuredTile: Number(tile) > 0 ? Math.max(ESRGAN_LIMITS.minTile, Math.round(Number(tile))) : 0,
      gpu,
      tta,
      timeoutMs,
      signal,
      work,
      warnings,
    })
  } finally {
    // 临时文件只在这一次调用里有意义：结果已经读进内存了，别把它留在磁盘上。
    if (createdWork) await fsp.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/** runUpscale 的主体（拆出来只是为了能用 try/finally 管临时目录）。 */
async function runUpscaleAttempts({
  bin,
  modelsDir,
  inputBuffer,
  inputSize,
  model,
  ratio,
  outSide,
  configuredTile,
  gpu,
  tta,
  timeoutMs,
  signal,
  work,
  warnings,
}) {
  const inputPath = path.join(work, `in-${Date.now()}.png`)
  await fsp.writeFile(inputPath, inputBuffer)

  // 重试序列：先按配置跑，失败就把 tile 减半（下限 32）。不换模型。
  const tilePlan = []
  if (configuredTile > 0) {
    tilePlan.push(configuredTile)
    const halved = Math.max(ESRGAN_LIMITS.minTile, Math.floor(configuredTile / 2))
    if (halved < configuredTile) tilePlan.push(halved)
  } else {
    tilePlan.push(0)
  }

  const attempts = []
  let lastFailure = null

  for (const [index, tileUsed] of tilePlan.entries()) {
    const outputPath = path.join(work, `out-${Date.now()}-${index}.png`)
    const args = buildEsrganArgs({ input: inputPath, output: outputPath, model, scale: ratio, tile: tileUsed, gpu, tta, modelsDir })
    const started = Date.now()
    let ran
    try {
      ran = await runProcess(bin, args, { timeoutMs, signal })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`找不到超分引擎：${bin}。用「下载引擎」装一个，或在设置里把「引擎路径」指向它的完整路径。`)
      }
      throw new Error(`启动超分引擎失败：${errorMessage(error)}`)
    }
    const elapsedMs = Date.now() - started
    const diagnosis = diagnoseEngineOutput(ran.text)
    const devices = parseDevices(ran.text)

    let outputBuffer = null
    try {
      outputBuffer = await fsp.readFile(outputPath)
    } catch {
      outputBuffer = null
    }
    const verdict = validateUpscale({
      outputBuffer,
      // 判「纯色」要跟输入比：输入本来就没内容（色卡、纯色底），输出没内容是对的。
      inputStats: inputSize,
      scale: ratio,
      inputWidth: inputSize.width,
      inputHeight: inputSize.height,
    })

    const record = {
      tile: tileUsed,
      elapsedMs,
      exitCode: ran.code,
      timedOut: Boolean(ran.timedOut),
      devices,
      failures: diagnosis.failures,
      problems: verdict.problems,
      advanced: verdict.advanced,
      stats: verdict.stats,
    }
    attempts.push(record)

    if (ran.timedOut) {
      lastFailure = {
        reason: `超时（${Math.round(timeoutMs / 1000)} 秒）`,
        hint: 'tile 越小越慢。把放大倍数调小、或把 tile 调大一点（显存够的话），也可以在设置里放宽超时。',
        record,
      }
      continue
    }

    if (verdict.ok) {
      return {
        buffer: outputBuffer,
        width: verdict.stats.width,
        height: verdict.stats.height,
        inputWidth: inputSize.width,
        inputHeight: inputSize.height,
        scale: ratio,
        model,
        tile: tileUsed,
        devices,
        attempts,
        warnings: [...warnings, ...verdict.advanced],
        stats: verdict.stats,
        elapsedMs: attempts.reduce((sum, item) => sum + item.elapsedMs, 0),
      }
    }

    lastFailure = {
      reason: [...verdict.problems, ...diagnosis.failures.map((item) => item.label)].join('；') || `引擎退出码 ${ran.code}`,
      hint: diagnosis.failures[0]?.hint ?? '',
      record,
    }
  }

  // 所有 tile 都试过了还是不行 —— 把能查的东西全摊给用户，别让他猜。
  const last = attempts[attempts.length - 1]
  const detail = []
  if (last?.devices?.length) detail.push(`识别到的 GPU：${last.devices.map((item) => `${item.id} ${item.name}`).join('、')}`)
  detail.push(`模型：${model}`)
  detail.push(`试过的 tile：${attempts.map((item) => item.tile || 'auto').join(' → ')}`)
  if (last?.exitCode !== undefined) detail.push(`引擎退出码：${last.exitCode}`)
  if (last?.stats) detail.push(`产出像素亮度：${last.stats.min}~${last.stats.max}`)
  throw new Error(
    `本地 GPU 超分失败：${lastFailure?.reason ?? '未知原因'}。` +
      `${lastFailure?.hint ? `\n建议：${lastFailure.hint}` : ''}` +
      `\n诊断：${detail.join(' · ')}`,
  )
}

// ---------------------------------------------------------------- 探测 / 安装

/**
 * 探一下引擎**到底能不能跑**，并列出它认到的 GPU。
 *
 * 为什么要真的算一张图，而不是跑个 `-h`：实测真引擎在 `-h` / 不带参数时
 * **只打印用法，不枚举 Vulkan 设备**（设备信息是真正处理图片时才打出来的）。
 * 所以「列设备」这件事本身就要求真跑一次。只用 `-h` 的话，一块完好的卡也会被
 * 报成「没有报告任何 Vulkan 设备」—— 那是彻头彻尾的误报，比不报还糟。
 *
 * 探针图的大小按 tile 走（约 2×tile，最少 128）：**tile 才是显存占用的决定因素**。
 * 拿一张 16×16 的小图去探 tile=128 会「假成功」—— ncnn 会把 tile 收敛到图的大小，
 * 于是小图过了、真图照样爆。这一点是实测踩出来的（同一块 K4200：
 * tile 128 出全黑、tile 64 正常，而 tile 与图的大小无关）。
 *
 * `tmpDir` 要给出图目录那种**确认可写**的位置 —— 见 runUpscale 里关于
 * 「引擎写不进系统 temp」的说明。
 */
export async function probeEsrgan({
  bin,
  modelsDir,
  model = 'realesrgan-x4plus',
  tile = 0,
  gpu = '',
  signal,
  tmpDir,
  timeoutMs = 120000,
} = {}) {
  if (!bin) return { ok: false, runnable: false, devices: [], reason: '没有可用的引擎路径。' }

  const configured = Number(tile) > 0 ? Math.max(ESRGAN_LIMITS.minTile, Math.round(Number(tile))) : 0
  // 探针图至少 2×tile，否则 tile 会被 ncnn 收敛掉，探不出真实显存压力。
  const side = Math.max(128, Math.min(512, (configured || 64) * 2))

  try {
    // 注意：**不要再套一层重试**。runUpscale 自己就会在失败时降一档 tile，
    // 外面再套一层只会把「实际生效的 tile」报错（踩过：明明降到了 64，却报成 128）。
    const outcome = await runUpscale({
      bin,
      modelsDir,
      inputBuffer: probePng(side),
      model,
      scale: 2,
      tile: configured,
      gpu,
      signal,
      tmpDir,
      timeoutMs,
      maxSide: 8192,
    })
    const downgraded = configured > 0 && outcome.tile !== configured
    return {
      ok: true,
      runnable: true,
      devices: outcome.devices,
      configuredTile: configured,
      tile: outcome.tile,
      recommendedTile: outcome.tile,
      probeSize: `${side}×${side}`,
      elapsedMs: outcome.elapsedMs,
      reason: '',
      hint: downgraded
        ? `这块卡在 tile ${configured} 上跑不了，插件自动降到 tile ${outcome.tile} 才成功` +
          `（探针图 ${side}×${side}）。把面板上的 tile 改成 ${outcome.tile}，下次就不用重试了。`
        : '',
    }
  } catch (error) {
    return {
      ok: false,
      runnable: false,
      devices: [],
      configuredTile: configured,
      probeSize: `${side}×${side}`,
      reason: errorMessage(error),
      hint: '',
    }
  }
}

/**
 * 下载并安装引擎到插件自管目录。
 *
 * 为什么不让用户自己去 GitHub 下：这一步是「装上插件就能用」的最后一公里，
 * 而且国内直连 GitHub 经常不通 —— 所以给了 `url` 覆盖（可填镜像/代理地址）。
 */
export async function installEsrgan({ dshHome, url = ESRGAN_RELEASE_URL, signal, timeoutMs = 600000 } = {}) {
  const target = esrganToolsDir(dshHome)
  const exe = esrganExeName()
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    throw new Error(`下载引擎失败（HTTP ${response.status}）：${url}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 1_000_000) {
    throw new Error(`下载回来的文件只有 ${bytes.length} 字节，明显不是引擎包（可能被代理/网关拦了）：${url}`)
  }
  // 先解到临时目录再搬：解压中途失败时不会把已装好的旧版本弄坏。
  const staging = `${target}.staging`
  await fsp.rm(staging, { recursive: true, force: true })
  await fsp.mkdir(staging, { recursive: true })
  let written
  try {
    written = await unzipToDir(bytes, staging)
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true })
    throw new Error(`引擎包解压失败：${error?.message ?? error}`)
  }
  const stagedExe = path.join(staging, exe)
  try {
    await fsp.access(stagedExe)
  } catch {
    await fsp.rm(staging, { recursive: true, force: true })
    throw new Error(`引擎包里没有找到 ${exe}（解出 ${written.length} 个文件），下载到的可能不是官方包。`)
  }
  await fsp.rm(target, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.rename(staging, target)
  return { dir: target, bin: path.join(target, exe), modelsDir: path.join(target, 'models'), files: written.length, bytes: bytes.length }
}
