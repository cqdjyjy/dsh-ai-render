/**
 * AI 效果图 · 宿主端（Host half）
 * 面板（Client half）通过人类命令 `cabinet-render` 提交两张（或多张）图片：
 *   。1 。= 底图（结构依据：立面施工。/ 线稿 / 模型截图 / 实拍照片 / 平面图）
 *   。2 张起 = 材质/颜色/风格参考图
 *
 * 本模块只做一件事：把这两类输入拼成提示词，调用图像生成服务出图，
 * 把结果写进磁盘，并把「文件路径」以 JSON 文本回给面板。* 面板再用 `ctx.remote.workspaceFiles.readBytes` 把图片读回去显示。* 因此整条链路都走框架已鉴权的 Remote 通道，不注册。HTTP 路由。*
 * 本模块刻意不依赖任何外部包（包括 schemastery）：workspace 链接的插。* 解析不到 dsh 内置包，一。import 失败整行插件就起不来。因此参数校。* 手写，可调项来自 cordis.patch.yml 。config 与下面的设置文件。* 密钥则由面板直接写入设置文件。*
 * @module @local/dsh-ai-render
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  TASK_MODES,
  STYLE_PRESETS,
  STYLE_SWATCHES,
  LIGHTING_PRESETS,
  CAMERA_PRESETS,
  CAMERA_AZIMUTH,
  CAMERA_ELEVATION,
  CAMERA_DISTANCE,
  CAMERA_COMBOS,
  RATIO_PRESETS,
  resolveRatio,
  sizeFromRatio,
  COMPOSER_SYSTEM,
  CAD_READER_SYSTEM,
  cadReaderSystem,
  resolveImageMentions,
  DIAGRAM_TYPES,
  QUICK_ACTIONS,
  MODE_STYLE_GROUPS,
  uiOf,
  styleIsFixedToBase,
  modeInheritsStyle,
  qcSystem,
  QC_SYSTEM,
  NEGATIVE_PROMPT,
  composePrompt,
  composeNegative,
  resolveTaskMode,
  resolveStyle,
} from './presets.js'

export const name = 'ai-render'
export { parseJobInput, fitSize, serviceOf, agyPrompt, harvestAgyImages, agyHomeDir, agyIndex, walkDir }
/**
 * 依赖声明。
 *
 * `llm` / `agentDefaultModel` 必须在这里声明 —— 否则 `ctx.get('llm')` 拿到的是
 * undefined，AI 润色会静默退回内置模板，用户看到的就是「AI 润色没走模型」。
 * 踩过的坑：这两个服务在宿主里明明存在，但没注入就用不到。
 *
 * 只能用数组形式。曾经试过 Cordis 的 `{ required: [...], optional: [...] }` 写法，
 * 结果插件直接 pending —— 宿主把对象的**键**当成了服务名，
 * 报 "waiting for services: required, optional"。数组是确定可用的形式。
 */
export const inject = ['commands', 'attachments', 'sessions', 'llm', 'agentDefaultModel']

/**
 * 取宿主服务：两种访问方式都试。
 *
 *   1. 直接属性 —— DSH 的服务通常直接挂在 ctx 上（ctx.llm / ctx.agentDefaultModel）
 *   2. ctx.get(name) —— Cordis 的通用取法
 *
 * 踩过的坑：只写 ctx.get() 时，AI 润色一直显示「内置模板（未走模型）」。
 * 服务明明在（include:llm 与 include:agent-default-model 都是 active，
 * 用 Inspect 确认过），但没取到，于是静默退回模板 —— 表现就是「润色没走模型」。
 */
function serviceOf(ctx, name) {
  if (!ctx) return undefined
  try {
    const direct = ctx[name]
    if (direct) return direct
  } catch {
    /* getter 抛错就当没有 */
  }
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    /* 同上 */
  }
  return undefined
}

/** cordis.patch.yml 。config 的默认值；设置文件可覆盖其中若干项。*/
const DEFAULTS = {
  arkApiKey: '',
  arkModel: 'doubao-seedream-4-0-250828',
  arkBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  dashscopeApiKey: '',
  dashscopeModel: 'qwen-image-edit-plus',
  dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  // 第三方中转站。OpenAI 兼容接口
  openaiApiKey: '',
  openaiBaseUrl: '',
  openaiModel: 'gpt-image-2',
  openaiMode: 'auto',
  openaiImageField: 'auto',
  openaiIncludeRefs: '1',
  // 异步任务接口专用：画质档位（留空=用服务端默认 auto）与图生图模。
openaiQuality: '',
  openaiImageMode: 'image_to_image',
  // gpt-image edits 的「保留输入图程度」：high = 尽量不改原图结构。
  // 默认 high：用户反馈过「结构经常被改」，这个字段是官方为此提供的开关。
  // 留空 = 不发送（某些中转站不透传；不认的话下面会自动去掉重发一次）。
  openaiInputFidelity: 'high',
  // Gemini（Antigravity CLI `agy`）通道。它不是在调生图 API，而是在驱动一个
  // **有文件系统权限的 CLI agent** —— 所以图片是「把文件路径写进提示词」喂进去的。
  agyBin: 'agy',
  // 留空 = 让 agy 自己选模型。硬写型号名会 "not recognized as a known model"，
  // 因为权威的模型列表只有 agy 从后端拉到的那份（踩过）。
  agyModel: '',
  agyEffort: '',
  agyHome: '',
  // agy 是 Go 程序：**只认 HTTPS_PROXY 环境变量，不读 Windows 系统代理**。
  // 本机系统代理由 WinINET 提供（PowerShell 能用），但 agy 会直连超时 —— 登录和
  // 出图都失败。所以这里显式给它一个代理。留空 = 不注入（继承进程环境）。
  agyProxy: '',
  // 出图后自动视觉质检，结构不过关就带着修正意见重出一。
autoQc: '1',
  defaultProvider: 'ark',
  outputDir: '',
  maxSide: 2048,
  // 异步任务要排。轮询，默认给。10 分钟
  timeoutMs: 600000,
  promptTemplate: '',
}

/** 设置文件允许用户覆盖的键。*/
const SETTABLE = [
  'arkApiKey',
  'arkModel',
  'arkBaseUrl',
  'dashscopeApiKey',
  'dashscopeModel',
  'openaiApiKey',
  'openaiBaseUrl',
  'openaiModel',
  'openaiMode',
  'openaiImageField',
  'openaiIncludeRefs',
  'openaiQuality',
  'openaiInputFidelity',
  'agyBin',
  'agyModel',
  'agyEffort',
  'agyHome',
  'agyProxy',
  'openaiImageMode',
  'autoQc',
  'defaultProvider',
  'outputDir',
]

/** OpenAI 兼容接口的调用形态。auto = 按模型名排序后逐个试。*/
const OPENAI_MODES = ['auto', 'async', 'async-linkai', 'edits', 'generations', 'chat']

const OPENAI_MODE_LABEL = {
  auto: '智能（按模型名自动选）',
  async: '异步任务 /v1/images/edits/async（AILink 等站的主力形态）',
  'async-linkai': '异步任务 /v1/linkai/images/edits/async（支。Gemini 分组。',
  edits: '/v1/images/edits（同步多图编辑，部分站的遗留通道。',
  generations: '/v1/images/generations（同步文生图。',
  chat: '/v1/chat/completions（Gemini/即梦等，图片在回复里返回。',
}

/**
 * 决定尝试顺序。中转站实现差异很大，同一模型在不同站的落点并不一致，
 * 所。auto 模式会给出一个有序候选，失败就换下一种。*
 * `async` / `async-linkai` 排在最前：AILink 这类站（direct.linkai.pics。* 的主力是异步任务接口，同步那三个只在部分站上是遗留兼容通道、容。502。*/
function openAiModeOrder(model, requested) {
  if (requested && requested !== 'auto' && OPENAI_MODES.includes(requested)) return [requested]
  const name = String(model ?? '').toLowerCase()
  const genericAsync = ['async', 'async-linkai']
  if (/gemini|nano-banana|imagen/.test(name)) {
    return ['async-linkai', 'async', 'chat', 'edits', 'generations']
  }
  if (/gpt-image|dall-e/.test(name)) return [...genericAsync, 'edits', 'generations', 'chat']
  if (/seedream|flux|kolors|qwen-image|wan|sd|sdxl|recraft|ideogram/.test(name)) {
    return [...genericAsync, 'generations', 'edits', 'chat']
  }
  return [...genericAsync, 'edits', 'generations', 'chat']
}

const PROVIDER_LABEL = {
  ark: '火山方舟 · 即梦 Seedream',
  qwen: '阿里云百炼 · 通义万相',
  openai: 'OpenAI 兼容中转',
  gemini: 'Google Gemini（Antigravity / agy）',
}

/** 不需要 API Key 的通道：agy 用自己那套登录态。 */
const KEYLESS_PROVIDERS = new Set(['gemini'])

/** 把任意输入规整成受支持的 provider id。*/
function normalizeProvider(value, fallback = 'ark') {
  if (value === 'ark' || value === 'qwen' || value === 'openai' || value === 'gemini') return value
  if (fallback === 'qwen' || fallback === 'openai' || fallback === 'gemini') return fallback
  return 'ark'
}

const MAX_ATTACHMENTS = 5

// ---------------------------------------------------------------- 小工。
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** 按原图长宽比求出图的整数尺寸：每条边都落在 [512,2048] 且是 16 的倍数。*/
function fitSize(srcWidth, srcHeight, maxSide) {
  const cap = Math.min(4096, Math.max(768, Number(maxSide) || 2048))
  const ar = srcWidth > 0 && srcHeight > 0 ? srcWidth / srcHeight : 4 / 3
  let width = ar >= 1 ? cap : Math.round(cap * ar)
  let height = ar >= 1 ? Math.round(cap / ar) : cap
  // 每边的钳制也必须放到 4096：上轮只改了外面的 cap，4K 时
    // 2548x4096 会被这里压成 2048x2048 —— 比例直接毁掉（测试抓到的）。
    const snap = (v) => Math.max(512, Math.min(4096, Math.round(v / 16) * 16))
  width = snap(width)
  height = snap(height)
  return { width, height }
}

/** 从 PNG 头里读宽高；不是 PNG 就返回 0（调用方会退回到默认比例）。 */
function readPngSize(buffer) {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  return { width: 0, height: 0 }
}

/** 从 JPEG 的 SOF 段读宽高；读不到就返回 0。 */
function readJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return { width: 0, height: 0 }
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return { width: 0, height: 0 }
}

/**
 * 直接量图片字节的宽高。
 *
 * 出图尺寸完全依赖底图长宽比，而附件 ref 上的 width/height **不一定存在**
 * （宿主实现不同、Agent 传附件时也可能没有）。只信 ref 的话会静默退化成
 * 4:3，出图比例就和底图对不上了 —— 所以这里永远从字节兜一层底。
 */
function imageSizeOf(buffer, mediaType = '') {
  if (buffer.length >= 24 && /png/i.test(mediaType || '')) return readPngSize(buffer)
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) return readJpegSize(buffer)
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) return readPngSize(buffer)
  return { width: 0, height: 0 }
}

/** 取第一张图的尺寸：ref > 调用方给的 attachment > 直接量字节。 */
function pickSize(ref, fallbackRef, buffer, mediaType) {
  const fromRef = Number(ref?.width) > 0 && Number(ref?.height) > 0 ? { width: ref.width, height: ref.height } : null
  if (fromRef) return fromRef
  const fromCaller =
    Number(fallbackRef?.width) > 0 && Number(fallbackRef?.height) > 0
      ? { width: fallbackRef.width, height: fallbackRef.height }
      : null
  if (fromCaller) return fromCaller
  return imageSizeOf(buffer, mediaType)
}

/**
 * 出图提示词。*
 * 优先级：`promptTemplate` 整体覆盖（`{refs}` 会被替换。预设组装器。* 预设组装器按「任务帧 。结构锁死 。视角 。材质 。五金 。空间 。光影 。* 氛围 。画质 。清除 。补充」的顺序拼段落，并对长度敏感的模型做降级裁剪。*/
/**
 * 画布比例与底图不一致时的护栏文案；一致就返回空串。
 *
 * 单独抽出来是为了**也能加到「润色过的提示词」上**：override 会整体替换提示词，
 * 如果只把它放进组装器，用了润色的那一路就没有这道约束了。
 */
function canvasGuardText(sizing = {}) {
  const canvasAr = Number(sizing.canvasAr) || 0
  const baseAr = Number(sizing.baseAr) || 0
  if (!(canvasAr > 0 && baseAr > 0)) return ''
  const diff = canvasAr / baseAr
  if (diff <= 1.06 && diff >= 0.94) return ''
  return (
    '出图画布的长宽比和图1不同：主体必须**按图1的原始比例完整放进画面**，' +
    '宁可两侧或上下留白、或补画环境背景，也绝对不得为了填满画布而拉伸、压扁、加宽、' +
    '增删分格或重新排布结构。画面的宽窄只影响取景范围，不影响主体本身的形。'
  )
}


/** agy 的图片落盘根目录（可用设置覆盖）。 */
function agyHomeDir(settings) {
  const custom = typeof settings?.agyHome === 'string' ? settings.agyHome.trim() : ''
  return custom || path.join(os.homedir(), '.gemini', 'antigravity-cli')
}

const AGY_IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const AGY_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/**
 * 把「图N」的编号映射到真实文件路径，作为提示词前缀。
 *
 * agy 是 agent，不会自己猜我们说的「图1」是哪个文件 —— 必须把路径写给它。
 * 这是整个 Gemini 通道能传图的**唯一机制**，所以单独抽出来可测。
 */
function agyPrompt(prompt, imagePaths = []) {
  const list = imagePaths.filter((item) => item && item.path)
  if (list.length === 0) return prompt
  const legend = list
    .map((item, index) => `${item.label || `图${index + 1}`} = ${item.path}`)
    .join('\n')
  return (
    '本机已有以下图片文件，请直接读取这些文件作为参考，不要另外去找或凭空编造：\n' +
    `${legend}\n\n` +
    prompt
  )
}

/** 递归列出目录下的条目（含 mtime/size）；目录不存在就返回空表。 */
/**
 * 按字节魔数判断图片真实格式。
 *
 * agy 落盘的文件扩展名不一定可信（实测拿到过后缀 .png 的真 JPEG），
 * 而我们存盘时如果硬编码 .png，下游拿到的扩展名就是错的。
 */
function sniffImageExt(buffer, mediaType = '') {
  const b = buffer
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return '.webp'
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif'
  if (/jpe?g/i.test(mediaType)) return '.jpg'
  if (/webp/i.test(mediaType)) return '.webp'
  return '.png'
}

const EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

async function walkDir(root) {
  const found = []
  const walk = async (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile()) {
        try {
          const info = await fsp.stat(full)
          found.push({ path: full, mtimeMs: info.mtimeMs, size: info.size })
        } catch {
          /* 文件在扫描过程中消失：忽略 */
        }
      }
    }
  }
  await walk(root, 0)
  return found
}

/**
 * 从 agy 的数据目录里挑出「这次新生成」的图片。
 *
 * 落盘位置不稳定（scratch / brain/<id>/ / brain/<id>/.tempmediaStorage 都见过），
 * 所以整棵子树按 mtime 递归找，取比 startedAt 新的、最新的几张。
 */
async function agyIndex(homeDir) {
  const map = new Map()
  for (const file of await walkDir(homeDir)) map.set(file.path, file.mtimeMs)
  return map
}

async function harvestAgyImages(homeDir, startedAt, limit = 4, before = null) {
  const all = await walkDir(homeDir)
  // 判「新」以运行前的文件清单为准（路径不存在 = 新增，mtime 变大 = 被改写）。
  // 不用「mtime > startedAt - 若干秒」那种时间容差：它会把刚好早一点点写下的
  // 旧图也算进来（测试里就抓到过），而且依赖时钟精度。
  const isNew = (file) => {
    if (!before) return file.mtimeMs >= startedAt
    const previous = typeof before.get === 'function' ? before.get(file.path) : before[file.path]
    return previous === undefined || file.mtimeMs > previous
  }
  return all
    .filter((file) => AGY_IMAGE_EXT.test(file.path) && isNew(file))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, Math.max(1, limit))
    .map((file) => ({
      data: null,
      path: file.path,
      mediaType: AGY_MIME[path.extname(file.path).toLowerCase()] || 'image/png',
    }))
}

/** 起一个子进程并收集输出。 */
function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * 走 Gemini（agy）通道出图。
 *
 * 与其它 provider 的本质区别：这不是 HTTP 生图接口，而是**驱动一个 CLI agent**。
 * 图片靠「把文件路径写进提示词」传递；出图靠扫 agy 数据目录里的新文件。
 */
async function callAgy(ctx, settings, prompt, images, signal, count) {
  const startedAt = Date.now()
  const home = agyHomeDir(settings)
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ai-render-agy-'))

  // 图片落到磁盘，编号沿用提示词里的「图1/图2…」（图1=底图，其后是参考图）
  const labeled = []
  for (const [index, image] of (images || []).entries()) {
    const ext = (image.mediaType || '').includes('jpeg') ? 'jpg' : 'png'
    const file = path.join(workDir, `input-${index + 1}.${ext}`)
    await fsp.writeFile(file, image.data)
    labeled.push({ label: `图${index + 1}`, path: file })
  }

  const finalPrompt = agyPrompt(prompt, labeled)
  const timeoutMs = Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : 600000
  const model = String(settings.agyModel ?? '').trim()
  const args = ['-p', finalPrompt, '--dangerously-skip-permissions']
  // 不指定就把选模型的事交给 agy：它从后端拉到的列表才是权威的
  if (model) args.push('--model', model)
  args.push('--print-timeout', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`)
  if (settings.agyEffort) args.push('--effort', settings.agyEffort)

  const beforeIndex = await agyIndex(home)
  const bin = settings.agyBin || 'agy'
  // 优先用宿主的 subprocess 服务解析可执行文件：Windows 上的 .cmd/.ps1 shim
  // 直接 spawn 会失败，它知道怎么解析。
  let command = bin
  try {
    const subprocess = typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined
    if (subprocess?.resolveExecutable) {
      command = (await subprocess.resolveExecutable(bin, undefined, signal)) || bin
    }
  } catch {
    command = bin
  }

  let ran
  try {
    const proxy = typeof settings.agyProxy === 'string' ? settings.agyProxy.trim() : ''
    // Go 的 http.ProxyFromEnvironment 认这三个变量；不注入的话它直连 Google 会超时。
    const env = proxy
      ? { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy }
      : process.env
    ran = await runCommand(command, args, { signal, env })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `Gemini 通道需要 Antigravity CLI（agy），当前找不到「${bin}」。` +
          '先安装并登录 agy，或在设置里把「agy 可执行文件」指向它的完整路径。' +
          `（官方安装命令：curl -fsSL https://antigravity.google/cli/install.sh | bash；Windows 是否可用请自行确认）`,
      )
    }
    throw new Error(`调用 agy 失败：${errorMessage(error)}`)
  }

  const harvested = await harvestAgyImages(home, startedAt, Math.max(1, count), beforeIndex)
  if (harvested.length === 0) {
    const detail = [ran.stderr, ran.stdout].filter(Boolean).join(' / ').trim().slice(0, 300)
    throw new Error(
      `agy 跑完了（退出码 ${ran.code}）但在 ${home} 里没找到新图片。` +
        `请确认 agy 已登录、模型名（${settings.agyModel}）可用` +
        (detail ? `；agy 输出：${detail}` : '。'),
    )
  }

  const images2 = []
  for (const file of harvested) {
    const data = await fsp.readFile(file.path)
    // 用字节而不是后缀决定媒体类型
    images2.push({ data, mediaType: EXT_MIME[sniffImageExt(data, file.mediaType)] || 'image/png' })
  }
  return { images: images2, modeUsed: 'agy', agyOutput: String(ran.stdout || '').slice(0, 2000) }
}

function buildJobPrompt(settings, job, referenceCount, sizing = {}) {
  // 面板。AI 润色/手改过的提示词优先，原样发送。
  const override = typeof job.promptOverride === 'string' ? job.promptOverride.trim() : ''
  const guard = canvasGuardText(sizing)
  if (override) {
    // 润色过的提示词也要带上画布护栏（它不在组装器里，容易漏）
    if (!guard || override.includes('【画布与主体】')) return override
    return `${override}\n【画布与主体】${guard}`
  }
  const refs = referenceCount <= 1 ? '图1' : `图1~图${referenceCount + 1}`
  const template = settings.promptTemplate
  if (template && template.trim()) {
    const head = template.replaceAll('{refs}', refs)
    const tail = [job.plain, job.promptExtra]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean)
      .join('；')
    return tail ? `${head}\n补充要求：${tail}` : head
  }
  // 即梦 Seedream 官方建议提示。。00 汉字，超了就只发必需段。
// 但带结构清单时不裁：清单本身就是内容，且它是硬约束段，索性不设预算。
  const structure = typeof job.structure === 'string' ? job.structure.trim() : ''
  // 「分析图」这类操作会额外注入一段类型说明。
const diagram = typeof job.diagram === 'string' ? job.diagram.trim() : ''
    // 即梦官方「建议」≤300 字，但那只是建议。300 会逼着我们在
  // 「客户原话」和「清除施工图元素」之间二选一 —— 两个都不该丢，
  // 所以给到 600（仍远低于模型的上限）。
  const budget = !structure && normalizeProvider(job.provider, settings.defaultProvider) === 'ark' ? 600 : 0
  return composePrompt({
    taskMode: job.taskMode,
    stylePreset: job.stylePreset,
    lighting: job.lighting,
    camera: job.camera,
    cameraElevation: job.cameraElevation,
    cameraDistance: job.cameraDistance,
    referenceCount,
    instruction: job.instruction,
    structure,
    diagram,
    qcFix: job.qcFix,
    plain: job.plain,
    extra: job.promptExtra,
    // 画布比例与底图比例：不一致时提示词会额外加一段「不许为了填满画布而重排结构」
    canvasAr: sizing.canvasAr,
    baseAr: sizing.baseAr,
    budget,
  })
}

/**
 * 出图目录：调用方指定 > 设置/配置 > 会话工作目录/AI效果图 > 图片/AI效果图。* 会话工作目录来自 `SessionHeader.cwd`，是唯一可靠的每会话根目录。*/
function resolveOutputDir(settings, requested, cwd) {
  const candidate = (requested && String(requested).trim()) || (settings.outputDir && String(settings.outputDir).trim())
  if (candidate) return path.resolve(candidate)
  if (typeof cwd === 'string' && cwd.trim()) return path.join(path.resolve(cwd), 'AI效果图')
  return path.join(os.homedir(), 'Pictures', 'AI效果图')
}

function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) return process.env.DSH_HOME.trim()
  return path.join(os.homedir(), '.dsh')
}

function settingsDir() {
  return path.join(dshHome(), 'ai-render')
}

function settingsFile() {
  return path.join(settingsDir(), 'settings.json')
}

function historyFile() {
  return path.join(settingsDir(), 'history.json')
}

/** 历史记录最多留这么多条，超出丢最旧的。*/
const HISTORY_LIMIT = 80

/**
 * 读历史记录。*
 * 历史文件坏了不该让整个插件瘫掉，所以这里宽容处理：解析失败就当空历史，
 * 并带上一。error 让面板提示用户（与设置文件的严格策略不同 —。设置的静。* 失败会导致「保存了没生效」，历史的失败只影响列表显示）。*/
async function readHistory() {
  try {
    const text = (await fsp.readFile(historyFile(), 'utf8')).replace(/^\uFEFF/, '')
    if (!text.trim()) return { records: [], error: '' }
    const parsed = JSON.parse(text)
    const records = Array.isArray(parsed?.records) ? parsed.records : []
    return { records, error: '' }
  } catch (error) {
    if (error?.code === 'ENOENT') return { records: [], error: '' }
    return { records: [], error: `历史记录文件无法读取：${errorMessage(error)}` }
  }
}

async function writeHistory(records) {
  const target = historyFile()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const body = JSON.stringify({ version: 1, records: records.slice(0, HISTORY_LIMIT) }, null, 2)
  const temporary = `${target}.tmp`
  await fsp.writeFile(temporary, body, 'utf8')
  await fsp.rename(temporary, target)
}

/**
 * 记一条出图历史。*
 * 只存「能复现这张图」的参数 + 结果路径，不存图片本身（图片已经在磁盘上。* 面板按路径读回来做缩略图即可，避免把 JSON 撑爆）。*/
async function appendHistory(entry) {
  const { records } = await readHistory()
  const record = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, ...entry }
  records.unshift(record)
  await writeHistory(records)
  return record
}

/**
 * 读设置文件。*
 * 手工编辑这个文件很容易踩两个坑，都会表现成「保存了但没生效」：
 *   1. 记事本可能写。UTF-8 BOM，JSON.parse 遇到 BOM 直接抛错。*   2. JSON 语法错（中文引号、路径里的反斜杠没转义、多一个逗号）。* BOM 直接剥掉；语法错必须报出来，绝不静默吞掉 —。静默吞掉正是
 * 「我明明保存了却没生效」这种反馈的根源。*/
/**
 * 解析面板 / Agent 传来的参数。
 *
 * 为什么还要支持 base64：面板是把整个 job 塞进**命令行字符串**发过来的
 * （`/ai-render {…}`），而命令行要过命令解析器 —— 它会处理引号、反斜杠、
 * 空白和转义。API Key 里一旦出现这些字符，传过来的内容就被改写了，
 * 表现就是「填了 Key 但没保存成功 / 点了保存没反应」。
 * 所以面板改成传 base64url（只含 A-Za-z0-9-_），这里两种都认，老客户端也不受影响。
 */
function parseJobInput(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  // base64url → UTF-8 → JSON
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(normalized, 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

async function readSettings() {
  let text
  try {
    text = await fsp.readFile(settingsFile(), 'utf8')
  } catch {
    return { settings: {}, error: '' } // 文件还不存在 = 正常
  }
  const body = text.replace(/^\uFEFF/, '').trim()
  if (!body) return { settings: {}, error: '' }
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (failure) {
    return {
      settings: {},
      error:
        `${settingsFile()} 不是合法 JSON：${errorMessage(failure)}）。` +
        '常见原因：用了中文引号、路径里的反斜杠没写成两个、多了一个逗号。',
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { settings: {}, error: `${settingsFile()} 的顶层必须是一。JSON 对象。` }
  }
  return { settings: parsed, error: '' }
}

/** 合并 patch 进设置文件；空字符串表示「清掉这一项」。*/
async function writeSettings(patch) {
  const loaded = await readSettings()
  // 文件已损坏时拒绝写入，否则会把用户手写的内容直接抹掉。
if (loaded.error) throw new Error(`设置文件有问题，先修好再保存：${loaded.error}`)
  const next = { ...loaded.settings }
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTABLE.includes(key)) continue
    if (value === null || value === undefined || value === '') delete next[key]
    else next[key] = String(value)
  }
  await fsp.mkdir(settingsDir(), { recursive: true })
  await fsp.writeFile(settingsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/** 有效配置 = patch config 默认。。设置文件覆盖。*/
function effective(config, settings) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  for (const key of SETTABLE) {
    if (typeof settings[key] === 'string' && settings[key].trim()) merged[key] = settings[key]
  }
  return merged
}

function apiKeyOf(settings, provider) {
  // gemini 走 agy 的登录态，不需要 Key（返回非空哨兵让上层检查通过）
  if (KEYLESS_PROVIDERS.has(provider)) return 'agy'
  if (provider === 'qwen') {
    return settings.dashscopeApiKey || process.env.DASHSCOPE_API_KEY || ''
  }
  if (provider === 'openai') {
    return settings.openaiApiKey || process.env.OPENAI_API_KEY || ''
  }
  if (provider === 'ark') {
    return settings.arkApiKey || process.env.ARK_API_KEY || ''
  }
  return ''
}

// ---------------------------------------------------------------- HTTP

async function postJson(url, headers, body, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 300)}`)
  }
  if (!response.ok) {
    const detail = json?.error?.message ?? json?.message ?? json?.error ?? text.slice(0, 300)
    throw new Error(`接口调用失败（HTTP ${response.status}）：${detail}`)
  }
  if (json?.code && String(json.code) !== '0') {
    throw new Error(`接口返回错误 ${json.code}：${json.message ?? ''}`)
  }
  return json
}

async function downloadImage(url, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`下载生成结果失败（HTTP ${response.status}）`)
  return Buffer.from(await response.arrayBuffer())
}

// ---------------------------------------------------------------- 出图服务

/** 火山方舟 · 即梦 Seedream：支持多图参。+ 组图输出。*/
async function callArk({ apiKey, baseUrl, model, prompt, images, size, count, signal }) {
  const dataUrls = images.map((image) => image.dataUrl)
  const buildBody = (sizeValue) => {
    const body = {
      model,
      prompt,
      image: dataUrls.length === 1 ? dataUrls[0] : dataUrls,
      size: sizeValue,
      response_format: 'b64_json',
      watermark: false,
    }
    if (count > 1) {
      body.sequential_image_generation = 'auto'
      body.sequential_image_generation_options = { max_images: count }
    }
    return body
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/images/generations`
  const headers = { authorization: `Bearer ${apiKey}` }
  let json
  try {
    // 优先发像素尺寸：我们要的是「画布比例和底图一致」，这是压住结构被改的关键。
    json = await postJson(url, headers, buildBody(`${size.width}x${size.height}`), signal)
  } catch (failure) {
    // 但各家对 size 的接受范围不一致（Agent Plan 的示例用的是 "2K" 这种档位字符串）。
    // 像素被拒时退回档位写法再试一次 —— 总比直接失败好，用户至少能拿到图。
    const text = String(failure?.message ?? failure)
    // 型号不在套餐里时，方舟只回一句很含糊的「does not support the agent plan
    // feature」，用户根本不知道该换哪个 —— 换成可执行的提示。
    if (/UnsupportedModel|does not support the agent plan/i.test(text)) {
      throw new Error(
        `方舟说这个模型不在你的套餐里：${model}。\n` +
          '型号能不能用取决于**你买的套餐开没开**，和官网有没有这个型号无关 —— ' +
          'Agent Plan 目前实测可用的是 doubao-seedream-5.0-pro。\n' +
          '请在面板「方舟模型」里换成可用型号，或到方舟控制台确认套餐支持哪些模型。',
      )
    }
    if (!/size|尺寸|分辨率|resolution|宽高|invalid/i.test(text)) throw failure
    json = await postJson(url, headers, buildBody('2K'), signal)
  }
  const list = Array.isArray(json?.data) ? json.data : []
  const out = []
  for (const item of list) {
    if (item?.b64_json) out.push({ data: Buffer.from(item.b64_json, 'base64'), mediaType: 'image/png' })
    else if (item?.url) out.push({ data: await downloadImage(item.url, signal), mediaType: 'image/png' })
  }
  if (out.length === 0) throw new Error(`方舟未返回图片：${JSON.stringify(json).slice(0, 400)}`)
  return out
}

/** 阿里云百。· 通义万相 图像编辑。~3 张输入图做多图融合。*/
async function callQwen({ apiKey, baseUrl, model, prompt, images, size, count, signal }) {
  const content = images.map((image) => ({ image: image.dataUrl }))
  content.push({ text: prompt })
  const body = {
    model,
    input: { messages: [{ role: 'user', content }] },
    parameters: {
      n: Math.max(1, Math.min(6, count)),
      watermark: false,
      prompt_extend: true,
      negative_prompt: payload.negative || NEGATIVE_PROMPT,
      size: `${size.width}*${size.height}`,
    },
  }
  const json = await postJson(
    `${baseUrl.replace(/\/+$/, '')}/services/aigc/multimodal-generation/generation`,
    { authorization: `Bearer ${apiKey}` },
    body,
    signal,
  )
  const choices = json?.output?.choices ?? []
  const out = []
  for (const choice of choices) {
    for (const part of choice?.message?.content ?? []) {
      if (part?.image) out.push({ data: await downloadImage(part.image, signal), mediaType: 'image/png' })
    }
  }
  if (out.length === 0) throw new Error(`通义万相未返回图片：${JSON.stringify(json).slice(0, 400)}`)
  return out
}

// ------------------------------------------------- 第三方中转站（OpenAI 兼容。
/**
 * 。base URL 规整成可直接拼接接口路径的形式：
 *   relay.example.com        。https://relay.example.com/v1
 *   https://x.com/api        。https://x.com/api/v1
 *   https://x.com/v1/        。https://x.com/v1
 */
function normalizeOpenAiBase(baseUrl) {
  let base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) return ''
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`
  if (!/\/v\d+$/.test(base)) base = `${base}/v1`
  return base
}

/**
 * gpt-image 系列只接受三个固定尺寸，按长宽比归到最接近的一个；
 * 其它模型（不少中转站转的即梦/Flux 等）继续。WxH。*/
function openAiEditSize(size, model) {
  if (!/gpt-image|dall-e/i.test(model)) return `${size.width}x${size.height}`
  const ar = size.width / size.height
  if (ar > 1.15) return '1536x1024'
  if (ar < 0.87) return '1024x1536'
  return '1024x1024'
}

/** 。chat 回复里把图片抠出来：支持 data URL 。http(s) 链接。*/
function extractImagesFromChat(json) {
  const found = []
  const push = (value) => {
    if (typeof value !== 'string' || !value) return
    const dataUrl = value.match(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=\s]+/)
    if (dataUrl) {
      found.push({ kind: 'base64', value: dataUrl[0].replace(/\s+/g, '') })
      return
    }
    const url = value.match(/https?:\/\/[^\s"')]+\.(?:png|jpe?g|webp)[^\s"')]*/i)
    if (url) found.push({ kind: 'url', value: url[0] })
  }
  const visit = (node, depth = 0) => {
    if (depth > 6 || node === null || node === undefined) return
    if (typeof node === 'string') return push(node)
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1))
      return
    }
    if (typeof node !== 'object') return
    // markdown 图片 ![alt](url) 。OpenRouter 风格。images[].image_url.url
    if (typeof node.url === 'string') push(node.url)
    if (typeof node.b64_json === 'string') found.push({ kind: 'base64', value: `data:image/png;base64,${node.b64_json}` })
    for (const [key, value] of Object.entries(node)) {
      // url / b64_json 已在上面处理过，再递归一次会把同一张图算两遍。
if (key === 'b64_json' || key === 'url') continue
      visit(value, depth + 1)
    }
  }
  const choices = json?.choices ?? []
  for (const choice of choices) visit(choice?.message?.images)
  for (const choice of choices) visit(choice?.message?.content)
  return found
}

async function materializeImages(found, signal, what) {
  const out = []
  for (const item of found) {
    if (item.kind === 'base64') {
      const comma = item.value.indexOf(',')
      out.push({ data: Buffer.from(item.value.slice(comma + 1), 'base64'), mediaType: 'image/png' })
    } else {
      out.push({ data: await downloadImage(item.value, signal), mediaType: 'image/png' })
    }
  }
  if (out.length === 0) throw new Error(`${what}没有返回图片`)
  return out
}

/** OpenAI 兼容 /v1/images/edits：multipart，多图参考的原生形态。*/
async function callOpenAiEdits({ apiKey, baseUrl, model, prompt, images, size, count, imageField, signal }) {
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  form.append('n', String(Math.max(1, Math.min(10, count))))
  form.append('size', openAiEditSize(size, model))
  const field = imageField === 'image' || imageField === 'image[]' ? imageField : images.length > 1 ? 'image[]' : 'image'
  for (const [index, image] of images.entries()) {
    form.append(field, new Blob([image.data], { type: image.mediaType }), image.name || `input-${index + 1}.png`)
  }
  const response = await fetch(`${baseUrl}/images/edits`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  })
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 300)}`)
  }
  if (!response.ok) {
    throw new Error(`接口调用失败（HTTP ${response.status}）：${json?.error?.message ?? text.slice(0, 300)}`)
  }
  const out = []
  for (const item of json?.data ?? []) {
    if (item?.b64_json) out.push({ data: Buffer.from(item.b64_json, 'base64'), mediaType: 'image/png' })
    else if (item?.url) out.push({ data: await downloadImage(item.url, signal), mediaType: 'image/png' })
  }
  if (out.length === 0) throw new Error(`images/edits 未返回图片：${JSON.stringify(json).slice(0, 400)}`)
  return out
}

/** OpenAI 兼容 /v1/images/generations：JSON 文生图，部分中转站支。image 参考。*/
async function callOpenAiGenerations({ apiKey, baseUrl, model, prompt, images, size, count, includeRefs, signal }) {
  const body = { model, prompt, n: Math.max(1, Math.min(10, count)), size: `${size.width}x${size.height}` }
  if (includeRefs && images.length > 0) {
    body.image = images.length === 1 ? images[0].dataUrl : images.map((image) => image.dataUrl)
  }
  const json = await postJson(`${baseUrl}/images/generations`, { authorization: `Bearer ${apiKey}` }, body, signal)
  const out = []
  for (const item of json?.data ?? []) {
    if (item?.b64_json) out.push({ data: Buffer.from(item.b64_json, 'base64'), mediaType: 'image/png' })
    else if (item?.url) out.push({ data: await downloadImage(item.url, signal), mediaType: 'image/png' })
  }
  if (out.length === 0) throw new Error(`images/generations 未返回图片：${JSON.stringify(json).slice(0, 400)}`)
  return out
}

/** OpenAI 兼容 /v1/chat/completions：把图片当多模态输入，图片在回复里。*/
async function callOpenAiChat({ apiKey, baseUrl, model, prompt, images, size, count, signal }) {
  const content = [{ type: 'text', text: `${prompt}\n出图尺寸：${size.width}x${size.height} 的比例。` }]
  for (const image of images) content.push({ type: 'image_url', image_url: { url: image.dataUrl } })
  const json = await postJson(
    `${baseUrl}/chat/completions`,
    { authorization: `Bearer ${apiKey}` },
    { model, messages: [{ role: 'user', content }], n: Math.max(1, Math.min(10, count)) },
    signal,
  )
  const found = extractImagesFromChat(json)
  if (found.length === 0) {
    // 把模型回的文字带出来，方便判断是「不支持出图」还是「被拒」。
const texts = []
    for (const choice of json?.choices ?? []) {
      const part = choice?.message?.content
      if (typeof part === 'string') texts.push(part)
      else if (Array.isArray(part)) for (const item of part) if (typeof item?.text === 'string') texts.push(item.text)
    }
    const said = texts.join(' ').trim()
    throw new Error(`没返回图片，模型回的是文字：${said ? said.slice(0, 300) : JSON.stringify(json).slice(0, 300)}`)
  }
  return materializeImages(found, signal, 'chat/completions')
}

// ------------------------------------------------- AILink 式异步任务接。
/**
 * 轮询间隔：文档建议按 Retry-After 。3 秒查一次。* 可用 AI_RENDER_POLL_MS 覆盖（测试用，避免干等）。*/
const TASK_POLL_INTERVAL_MS = Math.max(50, Number(process.env.AI_RENDER_POLL_MS) || 3000)

/**
 * 任务已经创建、但结果没拿到。*
 * 这种错误**绝不能再换形态重。*：创建请求已经扣过一次费，换形态等于再扣一次。* 文档原话：「创建请求不自动重试，避免重复生成并扣费」。*/
class TaskNotSettledError extends Error {}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    if (signal.aborted) {
      clearTimeout(timer)
      reject(new Error('已取。'))
      return
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('已取。'))
      },
      { once: true },
    )
  })
}

async function readJsonBody(response, url) {
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${url} 返回了非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  return { json, text }
}

/**
 * AILink 式异步生图：POST 。images/edits/async 。task_id。* 。GET /v1/images/tasks/{task_id} 轮询，完成后从签名链接下载。*
 * 参数名是 `source_images`（multipart 重复该字段上传文件）。* 参考图只接。Base64/data URL 或文件，不接。https 图片链接。* 每个任务只出一张图，不支持 n 批量；返回里没有 b64_json，必须下。url。*/
async function callOpenAiAsync(payload, linkai) {
  const root = linkai ? `${payload.baseUrl}/linkai` : payload.baseUrl
  const hasRefs = payload.images.length > 0
  const createPath = hasRefs ? '/images/edits/async' : '/images/generations/async'
  const createUrl = `${root}${createPath}`

  const buildForm = (withFidelity) => {
    const form = new FormData()
    form.append('model', payload.model)
    form.append('prompt', payload.prompt)
    form.append('size', openAiEditSize(payload.size, payload.model))
    if (payload.quality) form.append('quality', payload.quality)
    if (withFidelity && payload.inputFidelity) form.append('input_fidelity', payload.inputFidelity)
    if (hasRefs) {
      form.append('mode', payload.imageMode || 'image_to_image')
      for (const [index, image] of payload.images.entries()) {
        form.append('source_images', new Blob([image.data], { type: image.mediaType }), image.name || `source-${index + 1}.png`)
      }
    }
    return form
  }

  const post = (form) =>
    fetch(createUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${payload.apiKey}` },
      body: form,
      signal: payload.signal,
    })

  let created = await post(buildForm(true))
  let { json, text } = await readJsonBody(created, createUrl)
  // 中转站不认 input_fidelity 时自动降级重发。
  // 只在「创建阶段失败」时重发：此时没有 task_id，不存在重复扣费
  // （一旦拿到 task_id 就绝不重发，那是另一条铁律）。
  if (!created.ok && payload.inputFidelity && created.status >= 400 && created.status < 500) {
    created = await post(buildForm(false))
    ;({ json, text } = await readJsonBody(created, createUrl))
  }
  if (!created.ok) {
    throw new Error(
      `创建任务失败（HTTP ${created.status}）：${json?.error?.message ?? json?.message ?? text.slice(0, 240)}`,
    )
  }
  const taskId = json?.task_id ?? json?.taskId ?? json?.id
  if (!taskId) throw new Error(`创建任务成功但没拿到 task_id：${text.slice(0, 240)}`)

  const deadline = Date.now() + (Number(payload.pollTimeoutMs) > 0 ? Number(payload.pollTimeoutMs) : 600000)
  let lastStatus = ''
  while (Date.now() < deadline) {
    await sleep(TASK_POLL_INTERVAL_MS, payload.signal)
    const pollUrl = `${payload.baseUrl}/images/tasks/${encodeURIComponent(String(taskId))}`
    const polled = await fetch(pollUrl, { headers: { authorization: `Bearer ${payload.apiKey}` }, signal: payload.signal })
    const { json: task, text: taskText } = await readJsonBody(polled, pollUrl)
    if (!polled.ok) {
      throw new TaskNotSettledError(`查询任务失败（HTTP ${polled.status}），task_id=${taskId}：${taskText.slice(0, 200)}`)
    }
    const status = String(task?.status ?? '')
    lastStatus = status || lastStatus
    if (status === 'completed') {
      const url = task?.result?.data?.[0]?.url ?? task?.image_url ?? task?.result?.image_url
      if (!url) throw new TaskNotSettledError(`任务已完成但没有图片地址，task_id=${taskId}：${taskText.slice(0, 240)}`)
      return [{ data: await downloadImage(url, payload.signal), mediaType: 'image/png' }]
    }
    if (status === 'failed') {
      // task_id 一定要带出来：文档要求用户自行保存，凭它才能查。申诉。
throw new TaskNotSettledError(
        `任务失败（task_id=${taskId}，http_status=${task?.http_status ?? '?'}）：` +
          `${JSON.stringify(task?.error ?? task).slice(0, 240)}`,
      )
    }
  }
  throw new TaskNotSettledError(
    `任务超时未完成（最后状：${lastStatus || '未知'}），task_id=${taskId}。` +
      '任务仍在服务端跑，可用该 task_id 查询结果，不要重发（会重复扣费）。',
  )
}

/** 按候选顺序逐个试，成功就回报用的哪一种。*/
async function callOpenAi(payload) {
  const order = openAiModeOrder(payload.model, payload.mode)
  const failures = []
  for (const mode of order) {
    try {
      const images =
        mode === 'async'
          ? await callOpenAiAsync(payload, false)
          : mode === 'async-linkai'
            ? await callOpenAiAsync(payload, true)
            : mode === 'chat'
              ? await callOpenAiChat(payload)
              : mode === 'generations'
                ? await callOpenAiGenerations(payload)
                : await callOpenAiEdits(payload)
      return { images, modeUsed: mode }
    } catch (error) {
      // 任务已经创建过：再换形态就是再扣一次钱，必须直接失败。
if (error instanceof TaskNotSettledError) throw error
      failures.push(`【${OPENAI_MODE_LABEL[mode]}】${errorMessage(error).slice(0, 240)}`)
      if (order.length === 1) break
    }
  }
  const tried = order.length
  if (failures.length === 1) throw new Error(failures[0])
  throw new Error(`${tried} 种接口形态都试过了，都不通：\n${failures.join('\n')}`)
}

/**
 * 大白话 → 专业话术。
 *
 * **两段式设计**（这是核心，别改回一段）：
 *   1. 【基础框架】由操作 / 风格预设 / 光影 / 机位 / 画质决定，**保证出图效果**；
 *      它与客户说什么无关，是效果的底线，绝不能被润色改掉或丢掉。
 *   2. 【本次要求】由模型把客户的大白话整理成专业说法，**保证符合客户要求**。
 *
 * 所以模型只负责第 2 段，第 1 段原样保留。早先让模型「重写整份提示词」，
 * 结果框架被模型自己的模板顶掉（反馈：「没有根据大白话来」）；后来改成
 * 「只许用大白话、不许编」，框架又被挤没了。两段式才同时满足两边。
 *
 * 任何一步失败都不会丢框架：模型不给内容就把原话直接附在第 2 段。
 */
async function expandPromptWithLlm(ctx, settings, job, invocation) {
  const plain = typeof job.plain === 'string' ? job.plain.trim() : ''
  // 基础框架：注意 plain 传空 —— 客户的话走第 2 段，不能混进框架里。
  //
  // 字段必须与 buildJobPrompt 保持一致（structure / camera / diagram 一个都不能漏）：
  // 漏了 structure 就会变成「一点润色，图纸读出来的材质颜色五金全丢」，
  // 而这恰恰是基础框架里最不该丢的东西。
  const base = composePrompt({
    taskMode: job.taskMode,
    stylePreset: job.stylePreset,
    lighting: job.lighting,
    camera: job.camera,
    cameraElevation: job.cameraElevation,
    cameraDistance: job.cameraDistance,
    referenceCount: Number(job.referenceCount) || 1,
    instruction: job.instruction,
    structure: job.structure,
    diagram: job.diagram,
    plain: '',
    extra: job.promptExtra,
  })
  const assemble = (addition, extra = {}) => ({
    ...extra,
    base,
    addition,
    // 框架永远在最前面，第 2 段明确标为「以本节为准」，冲突时覆盖框架
    prompt: addition ? `${base}\n【本次要求】${addition}` : base,
    fallback: base,
  })

  if (!plain) {
    return assemble('', { rewritten: false, reason: '没写大白话，只用了基础框架。' })
  }

  const llm = serviceOf(ctx, 'llm')
  if (!llm) {
    return assemble(plain, { rewritten: false, reason: 'llm 服务不可用，已把你的原话直接附在框架后面。' })
  }

  let selection
  try {
    selection = serviceOf(ctx, 'agentDefaultModel')?.currentSelection()
  } catch {
    selection = undefined
  }
  // 先取「当前会话正在用的模型」。
  //
  // 为什么优先它而不是全局默认模型：用户正在用它跟我对话，说明这个提供商
  // 的凭据一定是好的；而全局默认模型可能指向一个没配好 Key 的提供商。
  // 踩过的坑：默认模型指向走方舟的提供商，润色直接 401
  // （"the API key or AK/SK in the request is missing or invalid"，code AUTH）。
  let live
  try {
    live = invocation?.agent?.model ?? invocation?.agent?.header?.model
  } catch {
    live = undefined
  }
  let provider = live?.provider || selection?.provider
  let model = live?.model || selection?.model
  if (!provider || !model) {
    return assemble(plain, {
      rewritten: false,
      reason:
        '未解析到默认模型，已把你的原话直接附在框架后面。' +
        `（诊断：agentDefaultModel=${serviceOf(ctx, 'agentDefaultModel') ? '有' : '无'}，` +
        `llm=${serviceOf(ctx, 'llm') ? '有' : '无'}）`,
    })
  }

  try {
    // 同时把「框架」和「大白话」都给模型：它需要知道框架里已经写了什么，
    // 才能只写增量、不重复、不冲突。
    const context = [
      `操作：${resolveTaskMode(job.taskMode).label}`,
      `风格预设：${(STYLE_PRESETS.find((item) => item.id === job.stylePreset) ?? { label: '不限' }).label}`,
      `参考图数量：${Number(job.referenceCount) || 0}`,
      '',
      '—— 基础框架（已经固定，不要改写、不要重复）——',
      base,
      '',
      '—— 客户原话（本次要求的唯一来源）——',
      plain,
      '—— 客户原话结束 ——',
    ].join('\n')
    // 润色是「写作」不是「推理」：给最低档推理 + 充足输出预算，temperature 调高
    // 一点让每次润色有差异。踩过坑：只收 text-delta 时推理模型的推理 token 会
    // 把预算吃光、正文一个字不吐，表现就是「每次都退回确定性的内置模板」。
    let modelInfo
    try {
      modelInfo = await llm.resolveModelInfo(provider, model)
    } catch {
      modelInfo = undefined
    }
    const effortIds = (modelInfo?.reasoning?.efforts ?? []).map((entry) => entry.id)
    const cheapest = effortIds.find((id) => /minimal|none|off|low/i.test(String(id))) ?? undefined

    const textDeltas = []
    const blockTexts = []
    const reasoningDeltas = []
    let finish = null
    const stream = llm.stream({
      provider,
      model,
      sessionId: invocation.agent.id,
      system: COMPOSER_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: context }] }],
      maxTokens: 4000,
      temperature: 0.8,
      ...(cheapest ? { reasoningEffort: cheapest } : {}),
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') textDeltas.push(chunk.text)
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') blockTexts.push(chunk.block.text)
      else if (chunk?.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
      else if (chunk?.type === 'finish') finish = chunk.reason
    }
    const text = (textDeltas.join('') || blockTexts.join('')).trim()
    if (!text) {
      return assemble(plain, {
        rewritten: false,
        reason:
          `模型没有返回文字内容（用的是 ${provider}/${model}；` +
          `text-delta ${textDeltas.length} 段 / reasoning ${reasoningDeltas.length} 段 / ` +
          `结束原因 ${finish ? JSON.stringify(finish) : '未收到 finish 块'}），已把你的原话直接附在框架后面。`,
      })
    }
    return assemble(text, { rewritten: true, by: `${provider}/${model}` })
  } catch (error) {
    return assemble(plain, { rewritten: false, reason: `润色失败：${errorMessage(error)}，已把你的原话直接附在框架后面。` })
  }
}

/**
 * 读图出结构：让多模态模型看底图，输出结构清单。*
 * 这是「让模型读懂图纸」的唯一正解：图片模型只会模仿像素，视觉模型能数门板。* 读分格。用会话当前的默认模型（DeepSeek 。deepseek-flash 声明。image 模态）。* 所以不需要额外开 Key。*
 * 图片以耐久附件引用直接塞进消息内容里，走的是框架自己的 request image 通道。*/
async function readStructureWithLlm(ctx, job, invocation) {
  const blocks = (invocation.attachments ?? []).filter((block) => block?.type === 'image')
  if (blocks.length === 0) throw new Error('请先导入底图，再读图出结构。')
  if (blocks.length > 1 && job.useFirstOnly !== false) {
    // 参考图对读结构没帮助，只用第一张（CAD）。
}

  const llm = serviceOf(ctx, 'llm')
  if (!llm) throw new Error('llm 服务不可用，读图功能无法使用。')
  let selection
  try {
    selection = serviceOf(ctx, 'agentDefaultModel')?.currentSelection()
  } catch {
    selection = undefined
  }
  const provider = selection?.provider
  const model = selection?.model
  if (!provider || !model) throw new Error('未解析到默认模型，无法读图。')

  // 先确认这个模型真的收图；不然会把图片降级成文字占位符，读出来全是废话。
let info
  try {
    info = await llm.resolveModelInfo(provider, model)
  } catch {
    info = undefined
  }
  if (info?.inputModalities && !info.inputModalities.includes('image')) {
    throw new Error(`当前模型 ${provider}/${model} 不支持图像输入，请在模型选择里换一个多模态模型。`)
  }

  const content = [
    ...blocks.map((block) => ({ type: 'image', attachment: block.attachment })),
    { type: 'text', text: '请按系统提示的格式，输出这张图的结构清单。' },
  ]

  // 读图是「感知」不是「推理」：用最低档推理 + 充足输出预算。
// 否则推理 token 会把 maxTokens 吃光，表现成「模型没有返回任何内容」。
  const effortIds = (info?.reasoning?.efforts ?? []).map((entry) => entry.id)
  const cheapest =
    effortIds.find((id) => /minimal|none|off|low/i.test(String(id))) ?? undefined

  const textDeltas = []
  const reasoningDeltas = []
  const blockTexts = []
  let finish = null
  let usage = null
  const stream = llm.stream({
    provider,
    model,
    // 读图会走「把附件投影成请求图片」的通道，带上会话身份更稳。
sessionId: invocation.agent.id,
    system: cadReaderSystem(job.taskMode),
    messages: [{ role: 'user', content }],
    maxTokens: 4000,
    temperature: 0.2,
    ...(cheapest ? { reasoningEffort: cheapest } : {}),
  })
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') textDeltas.push(chunk.text)
    else if (chunk?.type === 'reasoning-delta') reasoningDeltas.push(chunk.text)
    else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') blockTexts.push(chunk.block.text)
    else if (chunk?.type === 'usage') usage = chunk.usage
    else if (chunk?.type === 'finish') finish = chunk.reason
  }

  const structure = (textDeltas.join('') || blockTexts.join('')).trim()
  if (!structure) {
    // 失败也要能自证：把流里究竟来了什么报出来，别只说「没内容」。
const detail = [
      `text-delta ${textDeltas.length} 段`,
      `reasoning-delta ${reasoningDeltas.length} 段`,
      `block-end ${blockTexts.length} 个`,
      `结束原因 ${finish ? JSON.stringify(finish) : '未收。finish 。'}`,
      usage ? `tokens ：${usage.inputTokens ?? '?'} / ：${usage.outputTokens ?? '?'}` : '',
    ]
      .filter(Boolean)
      .join('；')
    const hint =
      reasoningDeltas.length > 0
        ? '看起来推理把输出预算吃光了。'
        : finish?.kind === 'max-tokens'
          ? '输出。maxTokens 截断。'
          : '可能是图片没能送进请求，或该模型这一路不支持图像输入。'
    throw new Error(`模型没有返回文字内容：${provider}/${model}）。诊断：${detail}：${hint}`)
  }
  return {
    ok: true,
    action: 'read',
    structure,
    by: `${provider}/${model}`,
    modalities: info?.inputModalities ?? ['text'],
  }
}

/**
 * 视觉质检：把 CAD 与成品并排交给多模态模型，只判「结构是否忠实」。*
 * openevai / 建筑学长这类平台「一键优化」的内核就是这个闭环。* 出图 。自查 。给出具体修正意见 。重出。*/
async function reviewRender(ctx, job, invocation, renderPath) {
  const cadBlock = (invocation.attachments ?? []).find((block) => block?.type === 'image')
  if (!cadBlock) return null
  const llm = serviceOf(ctx, 'llm')
  if (!llm) return null
  let selection
  try {
    selection = serviceOf(ctx, 'agentDefaultModel')?.currentSelection()
  } catch {
    selection = undefined
  }
  const provider = selection?.provider
  const model = selection?.model
  if (!provider || !model) return null

  // 成品图在磁盘上，先落成耐久附件引用才能塞进消息内容。
const bytes = await fsp.readFile(renderPath)
  const [saved] = await ctx.attachments.saveImages([
    { data: new Uint8Array(bytes), mediaType: 'image/png', name: path.basename(renderPath) },
  ])
  const structure = typeof job.structure === 'string' ? job.structure.trim() : ''
  const content = [
    { type: 'image', attachment: cadBlock.attachment },
    { type: 'image', attachment: saved },
    { type: 'text', text: structure ? `图1的结构清单（供比对）：\n${structure}` : '请对比图1与图2的结构。' },
  ]

  const textDeltas = []
  const blockTexts = []
  const stream = llm.stream({
    provider,
    model,
    sessionId: invocation.agent.id,
    system: qcSystem(job.taskMode),
    messages: [{ role: 'user', content }],
    maxTokens: 2000,
    temperature: 0.1,
  })
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') textDeltas.push(chunk.text)
    else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') blockTexts.push(chunk.block.text)
  }
  const raw = (textDeltas.join('') || blockTexts.join('')).trim()
  if (!raw) return { verdict: 'unknown', problem: '', raw: '', by: `${provider}/${model}` }

  const verdict = /判定[:：]\s*需修正/.test(raw) ? 'need-fix' : 'ok'
  const matched = raw.match(/问题[:：]\s*([\s\S]*)/)
  const problem = (matched?.[1] ?? '').trim()
  return { verdict, problem: problem === '无' ? '' : problem, raw, by: `${provider}/${model}` }
}

/** 出图 + 可选质检 + 可选自动修正重出。*/
async function generateWithQc(ctx, settings, job, invocation) {
  const first = await generate(ctx, settings, job, invocation)
  // 用户自己点的迭代改图不插质检；关掉开关也不插。
const qcOn = String(settings.autoQc) !== '0' && job.autoQc !== false && !job.instruction
  if (!qcOn || !(first.files ?? []).length) return first

  let review
  try {
    review = await reviewRender(ctx, job, invocation, first.files[0].path)
  } catch (error) {
    return { ...first, qc: { verdict: 'error', problem: errorMessage(error) } }
  }
  if (!review) return { ...first, qc: { verdict: 'unavailable' } }
  if (review.verdict !== 'need-fix' || !review.problem) return { ...first, qc: review }

  // 带着质检意见自动重出。
  //
  // 关键：**不要把上一版效果图当底图**。早先走的是「迭代改图」通道
  // （instruction + refineFrom），那个分支会用上一版当图1、并说「其余一律沿用图1」，
  // 于是第一版的漂移会被固化下来 —— 这正是「经常改结构和材质」的成因之一。
  // 现在保持原始底图不变，只追加一段【质检修正】，框架（图纸规定/结构/材质）全在。
  try {
    const second = await generate(
      ctx,
      settings,
      { ...job, qcFix: review.problem, promptOverride: '' },
      invocation,
    )
    return { ...second, qc: review, autoFixed: true, firstFiles: first.files }
  } catch (error) {
    return { ...first, qc: review, autoFixError: errorMessage(error) }
  }
}

/** 预设目录，给面板做选择器用（单一数据源在 presets.js）。*/
function presetsCatalog() {
  return {
    ok: true,
    action: 'presets',
    taskModes: TASK_MODES.map(({ id, label, hint, noBase }) => ({
      id,
      label,
      hint,
      noBase: Boolean(noBase),
      // 面板据此决定显示哪些控件：彩平图不该有光。构图选择器。
ui: uiOf(id),
      styleFixed: styleIsFixedToBase(id),
    })),
    diagrams: DIAGRAM_TYPES.map(({ id, label, hint }) => ({ id, label, hint })),
    quickActions: QUICK_ACTIONS.map(({ id, label, hint, group, needsReference }) => ({
      id,
      label,
      hint,
      group,
      needsReference: Boolean(needsReference),
    })),
    styles: STYLE_PRESETS.map(({ id, label, hint, group }) => ({
      id,
      label,
      hint,
      group: group ?? 'interior',
      swatch: STYLE_SWATCHES[id],
    })),
    // 操作 。可选风格组：面板据此过滤，避免「平面图」里看到「奶油风柜门」。
modeStyleGroups: MODE_STYLE_GROUPS,
    lighting: LIGHTING_PRESETS.map(({ id, label, hint }) => ({ id, label, hint })),
    // 出图比例：面板据此画比例小方框。
    ratios: RATIO_PRESETS.map(({ id, label, hint, w, h }) => ({ id, label, hint, w, h })),
    // 机位拆成三个正交维度 + 常用组合，面板据此画图示卡片。
cameras: CAMERA_AZIMUTH.map(({ id, label, hint, deg }) => ({ id, label, hint, deg })),
    cameraElevations: CAMERA_ELEVATION.map(({ id, label, hint, deg }) => ({ id, label, hint, deg })),
    cameraDistances: CAMERA_DISTANCE.map(({ id, label, hint, level }) => ({ id, label, hint, level })),
    // 常用机位必须把三个维度的 id 一起下。—。少一个，面板点了就没反应。
cameraCombos: CAMERA_COMBOS.map(({ id, label, hint, azimuth, elevation, distance }) => ({
      id,
      label,
      hint,
      azimuth,
      elevation,
      distance,
    })),
  }
}

/** 探测中转站：GET /v1/models，顺便把像图像模型的挑出来。*/
async function probeOpenAi(settings) {
  const baseUrl = normalizeOpenAiBase(settings.openaiBaseUrl)
  const apiKey = apiKeyOf(settings, 'openai')
  if (!baseUrl) throw new Error('还没填中转站的接口地址（base URL）。')
  if (!apiKey) throw new Error('还没填中转站的 API Key。')
  const response = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } })
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`GET ${baseUrl}/models 返回了非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    throw new Error(`GET ${baseUrl}/models 失败（HTTP ${response.status}）：${json?.error?.message ?? text.slice(0, 200)}`)
  }
  const ids = (json?.data ?? []).map((item) => item?.id).filter((id) => typeof id === 'string')
  const imageLike = ids.filter((id) => /image|dall|flux|gemini|seedream|seededit|qwen|kolors|wan|nano|banana|sd|sdxl|recraft|ideogram/i.test(id))
  return { ok: true, action: 'probe', baseUrl, total: ids.length, imageLike: imageLike.slice(0, 120), sample: ids.slice(0, 40) }
}

// ---------------------------------------------------------------- 主流。
async function collectImages(ctx, invocation) {
  const images = []
  for (const block of invocation.attachments ?? []) {
    if (block?.type !== 'image') continue
    const stored = await ctx.attachments.readImage(block.attachment, invocation.signal)
    const data = Buffer.from(stored.data)
    // 宽高绝不信单一来源：附件 ref 上不一定有，缺了就从字节量。
    const size = pickSize(stored.ref, block.attachment, data, stored.ref?.mediaType)
    if (size.width <= 0 || size.height <= 0) {
      // 量不出来时至少不要静默变成 4:3：留个痕，出图目录里能看到。
      console.warn('[cabinet-render] 无法确定底图尺寸，出图比例将回落到 4:3')
    }
    images.push({
      data,
      mediaType: stored.ref.mediaType,
      dataUrl: `data:${stored.ref.mediaType};base64,${data.toString('base64')}`,
      width: size.width,
      height: size.height,
      name: stored.ref.name,
    })
    if (images.length >= MAX_ATTACHMENTS) break
  }
  return images
}

async function generate(ctx, settings, job, invocation) {
  const started = Date.now()
  const session = ctx.sessions.get(invocation.agent.id)
  const cwd = session?.header?.cwd
  const provider = normalizeProvider(job.provider, settings.defaultProvider)
  const apiKey = apiKeyOf(settings, provider)
  if (!apiKey) {
    const where = {
      qwen: '百炼 DashScope API Key',
      openai: '中转站的 API Key',
      ark: '火山方舟 API Key',
      gemini: '（Gemini 通道不需要 Key）',
    }[provider]
    throw new Error(`还没配置${where}：在面板的「设置」里填入并保存。`)
  }
  const openaiBaseUrl = provider === 'openai' ? normalizeOpenAiBase(settings.openaiBaseUrl) : ''
  if (provider === 'openai' && !openaiBaseUrl) {
    throw new Error('还没填中转站的接口地址：在面板的「设置」里。base URL，例。https://your-relay.com/v1。')
  }

  const images = await collectImages(ctx, invocation)
  const jobMode = resolveTaskMode(job.taskMode)
  // 文生图不需要任何图片；其余操作必须有底图。
if (images.length < 1 && !jobMode.noBase) {
    throw new Error('请先导入底图（立。/ 模型截图 / 实拍照片 / 平面图都可以）。')
  }

  // 迭代改图：把上一版效果图从磁盘读回来当图1，用户只描述「本次改动」。
const instruction = typeof job.instruction === 'string' ? job.instruction.trim() : ''
  if (instruction) {
    if (!job.refineFrom || typeof job.refineFrom !== 'string') {
      throw new Error('迭代改图需要带上上一版效果图的路径（refineFrom）。')
    }
    const previousPath = path.resolve(String(job.refineFrom))
    // 白名单必须用「本次实际会写入的目录」，否则传了 outDir 时会误判成越界。
const allowedRoot = resolveOutputDir(settings, job.outDir, cwd)
    if (!previousPath.startsWith(allowedRoot)) {
      throw new Error(`只允许对出图目录内的结果做迭代：${allowedRoot}`)
    }
    const bytes = await fsp.readFile(previousPath)
    const previousSize = readPngSize(bytes)
    images.unshift({
      data: bytes,
      mediaType: 'image/png',
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      width: previousSize.width,
      height: previousSize.height,
      name: path.basename(previousPath),
    })
  }

  const mode = resolveTaskMode(job.taskMode)
  const noBase = Boolean(mode.noBase)
  // 文生图没有底图：所有图片都是参考图，尺寸也要另外定。
const cad = noBase ? null : images[0]
  const references = noBase ? images : images.slice(1)
  // 参考图不是必须的：风格预设本身就能给「长什么样」；换视。照片优化则沿用底图。
// 只有既没有参考图、所选风格又不提供材质、操作也不沿用底图时，才真的无从下手。
  const styleId = typeof job.stylePreset === 'string' ? job.stylePreset.trim() : ''
  const styleObj = resolveStyle(styleId)
  const styleGivesLook = Boolean(styleObj && (styleObj.group ?? 'interior') !== 'none' && styleObj.material)
  if (!instruction && !noBase && references.length === 0 && !styleGivesLook && !modeInheritsStyle(mode.id)) {
    throw new Error(
      '这个操作还不知道「长什么样」：请选一个风格预设，或上传 1 张参考图；换视角 / 照片优化这类操作可选「沿用底图」。',
    )
  }
  // 风格迁移的风格完全来自参考图，没有参考图就无从迁移。
if (mode.id === 'style-transfer' && references.length === 0) {
    throw new Error('「风格迁移」需要 1 张参考图作为风格来源：请上传参考图（第 2 张）。')
  }

  const count = Math.max(1, Math.min(4, Number(job.count) || 1))
  const explicit = typeof job.size === 'string' && /^\d+x\d+$/.test(job.size.trim()) ? job.size.trim() : null
  // 尺寸优先级：调用方显式给的 WxH > 用户选的比例 > 跟随底图 > 文生图默认
  const ratioSize = sizeFromRatio(resolveRatio(job.ratio), settings.maxSide)
  // 分辨率档位 → 像素上限。
  //
  // 为什么不直接把 "2K" 档位字符串发给接口：那样画布比例就由接口决定，
  // 底图 0.62 的竖图会被塞进 0.67 的画布 —— 模型为了填满而拉伸/重排，
  // 结构又会被改。所以「分辨率」只决定**像素上限**，比例始终跟随底图。
  const RESOLUTION_SIDES = { '1K': 1024, '1.5K': 1536, '2K': 2048, '4K': 4096 }
  const resolutionSide = RESOLUTION_SIDES[String(job.resolution ?? '').toUpperCase()] || 0
  const size = explicit
    ? { width: Number(explicit.split('x')[0]), height: Number(explicit.split('x')[1]) }
    : ratioSize
      ? ratioSize
      : noBase
        ? { width: 1536, height: 1024 }
        : fitSize(cad.width, cad.height, resolutionSide || settings.maxSide)
  // 接口实际会收到的尺寸：gpt-image 系列只认三种固定尺寸，会被归一次。
  //
  // 这一步必须在组装提示词**之前**算，因为护栏要用「接口真正收到的画布比例」。
  // 踩过的坑：以前这里传的是我们心里算的尺寸（如 1280x2048 = 0.625），
  // 而接口实际收到 1024x1536（= 0.667），**差 7.1%** —— 模型为了填满画布
  // 就会拉伸或重排分格（用户反馈：结构和比例还是被改了）。
  const modelForSize =
    provider === 'qwen' ? settings.dashscopeModel : provider === 'openai' ? settings.openaiModel : settings.arkModel
  const intendedSize = `${size.width}x${size.height}`
  const snappedSize = provider === 'openai' ? openAiEditSize(size, modelForSize) : intendedSize
  const [canvasWidth, canvasHeight] = snappedSize.split('x').map(Number)
  const baseAr = cad && cad.width > 0 && cad.height > 0 ? cad.width / cad.height : 0
  const prompt = buildJobPrompt(settings, job, references.length, {
    canvasAr: canvasWidth / canvasHeight,
    baseAr,
  })

  const timeout = Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : 600000
  const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(timeout)])

  const payload = {
    apiKey,
    baseUrl:
      provider === 'qwen' ? settings.dashscopeBaseUrl : provider === 'openai' ? openaiBaseUrl : settings.arkBaseUrl,
    model:
      provider === 'qwen' ? settings.dashscopeModel : provider === 'openai' ? settings.openaiModel : settings.arkModel,
    prompt,
    images,
    size,
    count,
    signal,
    // 。openai 形态使。
mode: settings.openaiMode,
    imageField: settings.openaiImageField,
    includeRefs: String(settings.openaiIncludeRefs) !== '0',
    quality: settings.openaiQuality,
    inputFidelity: settings.openaiInputFidelity,
    imageMode: settings.openaiImageMode,
    pollTimeoutMs: timeout,
    negative: composeNegative(job.negativeExtra, resolveStyle(job.stylePreset)),
  }
  let results
  let modeUsed
  // 复用上面已经算好的归并结果（别再算一遍，免得两处漂移）
  const intended = intendedSize
  const finalSize = snappedSize
  const reportedSize = {
    size: finalSize,
    notice:
      finalSize === intended
        ? ''
        : `你选的比例对应 ${intended}，但 ${payload.model} 只支持 1024x1024 / 1536x1024 / 1024x1536，已归到最接近的 ${finalSize}。想要精确比例请换即梦或通义万相。`,
  }
  if (provider === 'gemini') {
    // Gemini 通道不是 HTTP 生图接口，而是驱动 CLI agent：
    // 图片靠「把文件路径写进提示词」，出图靠扫 agy 数据目录里的新文件。
    const outcome = await callAgy(ctx, settings, prompt, images, signal, count)
    results = outcome.images
    modeUsed = outcome.modeUsed
  } else if (provider === 'openai') {
    const outcome = await callOpenAi(payload)
    results = outcome.images
    modeUsed = outcome.modeUsed
  } else {
    results = provider === 'qwen' ? await callQwen(payload) : await callArk(payload)
  }

  const dir = resolveOutputDir(settings, job.outDir, cwd)
  await fsp.mkdir(dir, { recursive: true })
  const tag = stamp()
  const files = []
  for (const [index, image] of results.entries()) {
    const fileName = `render_${tag}_${index + 1}${sniffImageExt(image.data, image.mediaType)}`
    const filePath = path.join(dir, fileName)
    await fsp.writeFile(filePath, image.data)
    const relativePath = typeof cwd === 'string' && cwd.trim() ? path.relative(path.resolve(cwd), filePath) : undefined
    files.push({ name: fileName, path: filePath, relativePath, bytes: image.data.length })
  }

  return {
    ok: true,
    provider,
    providerLabel: PROVIDER_LABEL[provider],
    model: payload.model,
    modeUsed,
    taskMode: resolveTaskMode(job.taskMode).id,
    stylePreset: job.stylePreset ?? 'custom',
    lighting: job.lighting ?? 'auto',
    refined: Boolean(instruction),
    // 报「实际向接口要的尺寸」而不是我们心里的尺寸：
    // gpt-image 只收三种固定尺寸，中间会被归一次，瞒着用户没意义。
    size: reportedSize.size,
    sizeNotice: reportedSize.notice,
    prompt,
    dir,
    workspaceRoot: typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd) : undefined,
    files,
    elapsedMs: Date.now() - started,
  }
}

function statusOf(settings, cwd, settingsError = '') {
  return {
    ok: true,
    action: 'status',
    ark: {
        configured: Boolean(apiKeyOf(settings, 'ark')),
        model: settings.arkModel,
        baseUrl: settings.arkBaseUrl,
      },
    qwen: { configured: Boolean(apiKeyOf(settings, 'qwen')), model: settings.dashscopeModel },
    openai: {
      configured: Boolean(apiKeyOf(settings, 'openai') && normalizeOpenAiBase(settings.openaiBaseUrl)),
      model: settings.openaiModel,
      baseUrl: normalizeOpenAiBase(settings.openaiBaseUrl),
      mode: OPENAI_MODES.includes(settings.openaiMode) ? settings.openaiMode : 'auto',
      // 面板据此显示「结构优先」开关的当前状态
      inputFidelity: String(settings.openaiInputFidelity ?? '').trim(),
    },
    defaultProvider: normalizeProvider(settings.defaultProvider),
    outputDir: resolveOutputDir(settings, '', cwd),
    settingsFile: settingsFile(),
    settingsError,
  }
}

// ---------------------------------------------------------------- 插件入口

export function apply(ctx, rawConfig = {}) {
  /** 统一入口：面板与 Agent 走同一条命令。*/
  const definition = {
    name: 'ai-render',
    description: '效果图：导入底图 + 参考图，生成写实效果图（支持 @参考图1 指定参考图）',
    input: {
      hint: '{"provider":"ark|qwen|openai","stylePreset":"cream","taskMode":"elevation","lighting":"auto","plain":"大白话","count":1}',
      attachments: true,
    },
    async handler(invocation) {
      let job = {}
      const raw = (invocation.rawInput ?? '').trim()
      if (raw) {
        const parsed = parseJobInput(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { kind: 'error', text: `参数无法解析（既不是合法 JSON，也不是合法 base64）：${raw.slice(0, 200)}` }
        }
        job = parsed
      }
      const session = ctx.sessions.get(invocation.agent.id)
      const cwd = session?.header?.cwd
      try {
        const loaded = await readSettings()
        const settings = effective(rawConfig, loaded.settings)

        // 统一把提示词里的 @提及 翻译成图号（。=底图，图2=参考图1…）。
// 放在入口做一次，面板。Agent 两条路都生效。
  const imageBlocks = (invocation.attachments ?? []).filter((block) => block?.type === 'image')
        const referenceCount =
          job.action === 'compose' || job.action === 'read'
            ? Number(job.referenceCount) || 0
            : Math.max(0, imageBlocks.length - 1)
        const referenceNames = imageBlocks.slice(1).map((block) => block?.attachment?.name).filter(Boolean)
        if (typeof job.plain === 'string') job.plain = resolveImageMentions(job.plain, referenceCount, referenceNames)
        if (typeof job.promptExtra === 'string') {
          job.promptExtra = resolveImageMentions(job.promptExtra, referenceCount, referenceNames)
        }

        if (job.action === 'status') {
          return { kind: 'success', text: JSON.stringify(statusOf(settings, cwd, loaded.error)) }
        }
        if (job.action === 'configure') {
          // 只处理调用方显式给出的键：缺。= 不修改，空串 = 清除。
const patch = {}
          for (const key of SETTABLE) {
            if (Object.prototype.hasOwnProperty.call(job, key)) patch[key] = job[key]
          }
          await writeSettings(patch)
          const after = await readSettings()
          const saved = statusOf(effective(rawConfig, after.settings), cwd, after.error)
          return { kind: 'success', text: JSON.stringify({ ...saved, saved: true }) }
        }
        if (job.action === 'presets') {
          return { kind: 'success', text: JSON.stringify(presetsCatalog()) }
        }
        if (job.action === 'history') {
          const { records, error } = await readHistory()
          return {
            kind: 'success',
            text: JSON.stringify({
              ok: true,
              action: 'history',
              error,
              count: records.length,
              records: records.slice(0, Math.max(1, Math.min(HISTORY_LIMIT, Number(job.limit) || 30))),
            }),
          }
        }
        if (job.action === 'history-clear') {
          await writeHistory([])
          return { kind: 'success', text: JSON.stringify({ ok: true, action: 'history-clear' }) }
        }
        if (job.action === 'compose') {
          // 必须把 invocation 传下去：llm.stream 需要 sessionId，
          // 漏传会让润色整条链路抛错并静默退回内置模板（表现为「润色失效」）。
          return { kind: 'success', text: JSON.stringify({ ok: true, action: 'compose', ...(await expandPromptWithLlm(ctx, settings, job, invocation)) }) }
        }
        if (job.action === 'read') {
          return { kind: 'success', text: JSON.stringify(await readStructureWithLlm(ctx, job, invocation)) }
        }
        if (job.action === 'probe') {
          // 允许用面板里还没保存的值直接试。
const candidate = { ...settings }
          for (const key of ['openaiBaseUrl', 'openaiApiKey', 'openaiModel']) {
            if (typeof job[key] === 'string' && job[key].trim()) candidate[key] = job[key].trim()
          }
          return { kind: 'success', text: JSON.stringify(await probeOpenAi(candidate)) }
        }
        // 设置文件坏了就说清是文件的问题，而不是含糊地报「还没配。Key」。
if (loaded.error) throw new Error(loaded.error)
        const result = await generateWithQc(ctx, settings, job, invocation)
        // 记一条历史，让面板能「还原参数再来一张」。
// 记历史失败绝不能让出图结果丢。—。图已经出了，这是主要价值。
  let record = null
        try {
          record = await appendHistory({
            at: new Date().toISOString(),
            taskMode: result.taskMode,
            taskModeLabel: TASK_MODES.find((mode) => mode.id === result.taskMode)?.label ?? result.taskMode,
            stylePreset: result.stylePreset,
            styleLabel: STYLE_PRESETS.find((style) => style.id === result.stylePreset)?.label ?? result.stylePreset,
            lighting: job.lighting ?? 'auto',
            camera: job.camera ?? 'inherit',
            cameraElevation: job.cameraElevation ?? 'inherit',
            cameraDistance: job.cameraDistance ?? 'inherit',
            ratio: job.ratio ?? 'follow',
            diagram: job.diagram ?? '',
            structure: typeof job.structure === 'string' ? job.structure : '',
            plain: typeof job.plain === 'string' ? job.plain : '',
            promptOverride: typeof job.promptOverride === 'string' ? job.promptOverride : '',
            provider: result.provider,
            model: result.model,
            modeUsed: result.modeUsed,
            size: result.size,
            prompt: result.prompt,
            refined: result.refined,
            elapsedMs: result.elapsedMs,
            qcVerdict: result.qc?.verdict ?? '',
            files: (result.files ?? []).map((file) => file.path),
          })
        } catch (historyError) {
          record = { failed: errorMessage(historyError) }
        }
        return { kind: 'success', text: JSON.stringify({ ...result, historyId: record?.id ?? '' }) }
      } catch (error) {
        const subject =
          job.action === 'probe'
            ? '中转站探测失。'
            : job.action === 'configure'
              ? '保存配置失败'
              : job.action === 'read'
                ? '读图出结构失。'
                : job.action === 'compose'
                  ? '提示词润色失。'
                  : '效果图生成失败'
        return { kind: 'error', text: `${subject}：${errorMessage(error)}` }
      }
    },
  }
  // 旧名字保留为别名：这个插件原来叫 cabinet-render，老用户和历史会话里
  // 还写着旧命令，直接删掉会让他们的习惯落空。描述里标明新名字。
  const legacyDefinition = {
    ...definition,
    name: 'cabinet-render',
    description: '【旧命令名，已更名为 ai-render】' + definition.description,
  }
  return ctx.effect(
    () => [ctx.commands.register(definition), ctx.commands.register(legacyDefinition)],
    'ai-render: command',
  )
}
