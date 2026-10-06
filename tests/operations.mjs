/**
 * 离线验证「操作库」扩展：不需要真实 Key、不联网（用本地假中转站）。
 *
 * 覆盖：
 *   1. 目录暴露：操作 / 分析图类型 / 一键操作
 *   2. 文生图（无底图）走 /images/generations/async 且不带 source_images
 *   3. 无底图时的图号偏移：@参考图1 → 图1
 *   4. 分析图操作会把【分析图类型】注入提示词
 *   5. 一键操作走「改这张」通道，提示词带【本次改动】
 *
 * 用法：node tests/operations.mjs
 */
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const out = path.join(here, 'out')
const fakeHome = path.join(here, '.fake-home-ops')

process.env.AI_RENDER_POLL_MS = '80'
process.env.DSH_HOME = fakeHome

/** 1x1 透明 PNG。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

let failures = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

const seen = []
let taskCount = 0
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    if (req.url?.endsWith('.png')) {
      res.setHeader('content-type', 'image/png')
      return res.end(PNG)
    }
    seen.push({ method: req.method, path: req.url, text: raw.toString('utf8'), bytes: raw.length })
    const send = (status, body) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
    if (req.url?.includes('/images/') && req.url.endsWith('/async')) {
      taskCount += 1
      return send(202, { task_id: `task_${taskCount}`, status: 'processing' })
    }
    if (req.url?.startsWith('/v1/images/tasks/')) {
      return send(200, {
        status: 'completed',
        progress: 100,
        result: { data: [{ url: `http://127.0.0.1:${server.address().port}/v1/fake.png` }] },
      })
    }
    send(404, { error: { message: `unhandled ${req.url}` } })
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
console.log(`假中转站: ${baseUrl}\n`)

await fsp.rm(fakeHome, { recursive: true, force: true })
await fsp.mkdir(path.join(fakeHome, 'ai-render'), { recursive: true })
await fsp.writeFile(
  path.join(fakeHome, 'ai-render', 'settings.json'),
  JSON.stringify({ openaiBaseUrl: baseUrl, openaiApiKey: 'fake-key', openaiMode: 'auto', openaiModel: 'gpt-image-2' }),
  'utf8',
)

const plugin = await import(`file://${path.join(root, 'index.js').replaceAll('\\', '/')}`)
let definition = null
/** 假的 llm 服务：用来验证「AI 润色」这条链路真的把模型输出带回来了。 */
let llmMode = 'text' // text | reasoning-only | block-end
let lastLlmCall = null
const fakeLlm = {
  async resolveModelInfo() {
    return { inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
  },
  stream(options) {
    // 记下真实发给模型的内容：要验证「用户原话确实传到了模型」，
    // 只看返回结果不够（模型完全可以自己编）。
    lastLlmCall = options
    // 推理模型可能只吐 reasoning、正文一个字没有 —— 这正是「每次润色结果都一样」
    // 的成因（每次都退回确定性的内置模板）。做成可切换的，便于回归。
    const chunks =
      llmMode === 'reasoning-only'
        ? [
            { type: 'reasoning-delta', text: '想一下……' },
            { type: 'reasoning-delta', text: '再想一下……' },
            { type: 'finish', reason: { kind: 'max-tokens' } },
          ]
        : llmMode === 'block-end'
          ? [
              { type: 'block-end', block: { type: 'text', text: '【结构锁死】文本块形态的模型输出。' } },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
          : [
              { type: 'text-delta', text: '【结构锁死】保持原有几何与分格不变。' },
              { type: 'text-delta', text: '【材质色彩】哑光肤感饰面板。' },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
  },
}
plugin.apply(
  {
    effect: (fn) => fn(),
    commands: { register: (def) => ((definition = def), () => {}) },
    attachments: { async readImage(ref) { return { ref, data: new Uint8Array(await fsp.readFile(ref.__file)) } } },
    sessions: { get: (id) => ({ header: { id, cwd: out } }) },
    get(name) {
      if (name === 'llm') return fakeLlm
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
      }
      return undefined
    },
  },
  {},
)

const call = async (job, attachments = []) => {
  const result = await definition.handler({
    commandId: 'ops',
    agent: { id: 'ops-session' },
    rawInput: JSON.stringify({ provider: 'openai', outDir: out, ...job }),
    attachments,
    signal: new AbortController().signal,
  })
  if (result.kind !== 'success') throw new Error(result.text)
  return JSON.parse(result.text)
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
const refBlock = await imageBlock(path.join(here, 'fixtures', 'user-ref-wood.jpg'))

console.log('== 1. 目录暴露 ==')
const catalog = await call({ action: 'presets' })
check(catalog.taskModes.length === 11, `操作 11 个（实为 ${catalog.taskModes.length}）`)
check(catalog.diagrams.length === 5, `分析图类型 5 个（实为 ${catalog.diagrams.length}）`)
check(catalog.quickActions.length === 8, `一键操作 8 个（实为 ${catalog.quickActions.length}）`)
check(
  catalog.taskModes.find((mode) => mode.id === 'text2img')?.noBase === true,
  '文生图标记为「不需要底图」',
)
// 菜单与功能对应：面板拿这些开关决定显示什么
check(
  catalog.taskModes.find((mode) => mode.id === 'view-switch')?.styleFixed === true,
  '换视角标记为「不选风格」',
)
check(
  catalog.taskModes.find((mode) => mode.id === 'style-transfer')?.styleFixed === true,
  '风格迁移标记为「不选风格」',
)
check(
  catalog.taskModes.find((mode) => mode.id === 'plan')?.ui?.lighting === false,
  '平面图标记为「不显示光影」',
)
check(
  catalog.taskModes.find((mode) => mode.id === 'text2img')?.ui?.read === false,
  '文生图标记为「不显示读图」',
)

console.log('\n== 5b. Gemini(agy) 通道：图片靠文件路径传递 ==')
// agy 是 CLI agent，不是生图 API —— 它不会猜「图1」是哪个文件，
// 所以必须把编号映射到真实路径写进提示词。这是该通道唯一能传图的机制。
const { agyPrompt, harvestAgyImages, agyHomeDir, agyIndex } = await import(
  `file://${path.join(root, 'index.js').replaceAll('\\', '/')}`
)
const legend = agyPrompt('把图1渲染成实景效果图。', [
  { label: '图1', path: 'C:\\tmp\\input-1.png' },
  { label: '图2', path: 'C:\\tmp\\input-2.png' },
])
check(legend.includes('图1 = C:\\tmp\\input-1.png'), '图1 映射到真实文件路径')
check(legend.includes('图2 = C:\\tmp\\input-2.png'), '图2 映射到真实文件路径')
check(legend.includes('把图1渲染成实景效果图。'), '原提示词完整保留在路径清单之后')
check(legend.indexOf('图1 =') < legend.indexOf('把图1渲染'), '路径清单在提示词之前（先告诉它文件在哪）')
check(agyPrompt('只有文字', []) === '只有文字', '没有图片时提示词不加前缀')

// 从 agy 数据目录按 mtime 捡新图（落盘位置不稳定，要递归找）
const agyHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'agy-home-'))
await fsp.mkdir(path.join(agyHome, 'brain', 'conv-1', '.tempmediaStorage'), { recursive: true })
await fsp.mkdir(path.join(agyHome, 'scratch'), { recursive: true })
const oldPng = path.join(agyHome, 'scratch', 'old.png')
await fsp.writeFile(oldPng, Buffer.from('89504e470d0a1a0a', 'hex'))
// 运行前先快照：只认新增/变动的文件，不靠时间容差
const beforeIndex = await agyIndex(agyHome)
const since = Date.now()
await fsp.writeFile(path.join(agyHome, 'brain', 'conv-1', 'new-1.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
await fsp.writeFile(path.join(agyHome, 'brain', 'conv-1', '.tempmediaStorage', 'new-2.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
await fsp.writeFile(path.join(agyHome, 'scratch', 'notes.txt'), 'x')
const harvested = await harvestAgyImages(agyHome, since, 4, beforeIndex)
check(harvested.length === 2, `只捡到本次生成的两张图（实为 ${harvested.length}）`)
check(
  harvested.every((file) => file.path.endsWith('.png')),
  '非图片文件被过滤掉（notes.txt 不在结果里）',
)
check(
  harvested.some((file) => file.path.includes('.tempmediaStorage')) &&
    harvested.some((file) => file.path.includes('brain')),
  '嵌套目录（brain/<id>/.tempmediaStorage）也能递归找到',
)
check(!harvested.some((file) => file.path.endsWith('old.png')), '运行前就存在的旧图被排除（即使只早 80ms）')
check(harvested[0].mediaType === 'image/png', '按扩展名给出正确 MIME')
check((await harvestAgyImages(path.join(agyHome, 'nope'), since, 4)).length === 0, '目录不存在时返回空表而不是抛错')
check(agyHomeDir({ agyHome: '' }).includes('.gemini'), '默认 agy 数据目录指向 ~/.gemini/antigravity-cli')
check(agyHomeDir({ agyHome: 'D:\\custom' }) === 'D:\\custom', '设置可覆盖 agy 数据目录')

console.log('\n== 6. 目录契约：面板要用的字段一个都不能少 ==')
// 这类 bug 反复出现：宿主 mapper 把面板需要的字段裁掉，按钮就变成「点了没反应」。
// 上一轮就是这样：cameraCombos 只下发了 id/label/hint，三个维度 id 全丢，
// 点「正视图」等于把相机设成 undefined —— 高亮全灭，看着像按钮坏了。
check(
  catalog.cameraCombos.every((combo) => combo.azimuth && combo.elevation && combo.distance),
  '常用机位带齐 azimuth / elevation / distance',
)
check(
  catalog.cameraCombos.every(
    (combo) =>
      catalog.cameras.some((item) => item.id === combo.azimuth) &&
      catalog.cameraElevations.some((item) => item.id === combo.elevation) &&
      catalog.cameraDistances.some((item) => item.id === combo.distance),
  ),
  '常用机位的三个 id 都能对应到真实选项',
)
check(catalog.cameras.every((item) => 'deg' in item), '水平角度带 deg（面板画示意图要用）')
check(catalog.cameraElevations.every((item) => 'deg' in item), '垂直角度带 deg')
check(catalog.cameraDistances.every((item) => 'level' in item), '取景距离带 level')
check(catalog.styles.every((item) => item.group && Array.isArray(item.swatch)), '风格带 group 与 swatch')
check(
  catalog.taskModes.every((item) => item.ui && typeof item.styleFixed === 'boolean'),
  '操作带 ui 与 styleFixed',
)
check(
  catalog.quickActions.every((item) => typeof item.needsReference === 'boolean'),
  '一键操作带 needsReference',
)
check(
  catalog.modeStyleGroups && Object.keys(catalog.modeStyleGroups).length > 0,
  '下发「操作 → 风格组」映射',
)

console.log('\n== 1d. 静态检查：函数不能引用自己没接收的变量 ==')
// 「AI 润色失效」的根因就是这个：expandPromptWithLlm 用了 invocation，
// 签名里却没有它，于是每次调用都抛错并静默退回内置模板（用户只看到「没润色」）。
const source = await fsp.readFile(path.join(root, 'index.js'), 'utf8')
const watched = ['invocation', 'ctx', 'settings', 'job', 'payload']
/** 从函数名后的第一个 { 开始按大括号配平取出函数体（粗略忽略字符串/注释）。 */
const bodyOf = (text, startIndex) => {
  const open = text.indexOf('{', startIndex)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return text.slice(open)
}
/** 剥掉字符串与注释，避免把 'settings.json' 这类内容当成变量访问。 */
const stripLiterals = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
const offenders = []
const funcRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm
let match
while ((match = funcRe.exec(source)) !== null) {
  const [, name, params] = match
  const body = stripLiterals(bodyOf(source, match.index))
  for (const variable of watched) {
    if (new RegExp(`\\b${variable}\\b`).test(params)) continue
    // 函数体里自己声明过（参数、解构、赋值）就不算
    if (new RegExp(`[(,]\\s*${variable}\\b|\\b(?:const|let|var)\\s+${variable}\\b|\\{\\s*${variable}\\b`).test(body)) continue
    if (new RegExp(`\\b${variable}\\.`).test(body)) offenders.push(`${name}() 用了 ${variable}`)
  }
}
check(
  offenders.length === 0,
  `没有函数引用未接收的变量${offenders.length ? `（${offenders.join('；')}）` : ''}`,
)
let transferMessage = ''
try {
  await call({ taskMode: 'style-transfer', stylePreset: 'as-is', count: 1 }, [cadBlock])
} catch (error) {
  transferMessage = String(error.message)
}
check(transferMessage.includes('参考图'), '风格迁移缺参考图时明确报错')

console.log('\n== 1e. 润色 = 基础框架 + 本次要求（两段式） ==')
// 设计要点：框架保证效果、大白话保证符合客户要求，两者都不能丢。
// 踩过两次坑：① 让模型重写整份提示词 → 框架被模型模板顶掉；
// ② 改成「只许用大白话、不许编」→ 框架被挤没了。所以锁住两段都在。
const composed = await call({
  action: 'compose',
  plain: '客户想要奶油风，柜门不要拉手',
  taskMode: 'elevation',
  stylePreset: 'cream',
  referenceCount: 1,
})
check(
  composed.rewritten === true,
  `润色走通了模型（rewritten=${composed.rewritten}，reason=${composed.reason ?? '无'}）`,
)
check(composed.by === 'deepseek-account/deepseek-flash', '回报了实际使用的模型')

// —— 第 1 段：基础框架必须原样保留 ——
const base = String(composed.base ?? '')
check(base.length > 300, `基础框架存在（${base.length} 字）`)
check(base.includes('【结构锁死】') && base.includes('【材质色彩】'), '框架含结构约束与材质段落')
check(base.includes('奶油白'), '框架含所选风格（奶油风）的材质描述')
check(!base.includes('【补充要求】'), '框架里不含大白话（大白话走第 2 段）')
check(String(composed.prompt).startsWith(base), '最终提示词以基础框架开头（框架没被顶掉）')

// 框架里的图纸规格必须跟读图结果走：漏传 structure 就会「一点润色，
// 图纸读出来的材质颜色五金全丢」—— 那是框架里最不该丢的东西。
lastLlmCall = null
const withSpec = await call({
  action: 'compose',
  plain: '不要拉手',
  taskMode: 'elevation',
  stylePreset: 'cream',
  referenceCount: 1,
  structure: '6. 材质与颜色：门板为白色亚克力，台面为黑色岩板\n7. 五金与细节：明装黑色长拉手',
})
check(withSpec.base.includes('白色亚克力'), '润色时基础框架带上了图纸读出的材质')
check(withSpec.base.includes('明装黑色长拉手'), '润色时基础框架带上了图纸读出的五金')
check(withSpec.base.includes('【图纸规定'), '润色时基础框架带上了【图纸规定】段')
check(/【材质色彩】[^\n]*以【图纸规定】为准/.test(withSpec.base), '润色时框架里的材质段仍以图纸为准，而不是风格模板')
check(
  String(lastLlmCall?.messages?.[0]?.content?.[0]?.text).includes('白色亚克力'),
  '模型也收到了图纸规格（才知道不要重复什么）',
)

// 用了润色（promptOverride）时画布护栏不能丢 —— override 会整体替换提示词，
// 如果只把护栏放进组装器，走润色那一路就没有这道约束了（结构就可能被重排）。
seen.length = 0
await call(
  {
    taskMode: 'elevation',
    stylePreset: 'cream',
    count: 1,
    ratio: '1:1',
    promptOverride: '把图1渲染成实景效果图。',
  },
  [cadBlock],
)
const overrideBody = seen.map((entry) => entry.text).join('')
check(overrideBody.includes('【画布与主体】'), '润色/手改过的提示词也会补上【画布与主体】护栏')
check(overrideBody.includes('不得为了填满画布而拉伸'), '护栏内容确实进了最终请求')
seen.length = 0

// 质检自动重出：源码层面锁住它不再用「改图」通道（那是把漂移固化的元凶）
const hostSource = await fsp.readFile(path.join(root, 'index.js'), 'utf8')
const autoFixBody = hostSource.slice(
  hostSource.indexOf('带着质检意见自动重出'),
  hostSource.indexOf('带着质检意见自动重出') + 900,
)
check(autoFixBody.includes('qcFix: review.problem'), '质检重出走 qcFix，而不是 instruction')
check(!/refineFrom:\s*first\.files\[0\]\.path/.test(autoFixBody), '质检重出不再把上一版效果图当底图（否则漂移会被固化）')

// —— 第 2 段：本次要求来自模型 ——
check(String(composed.prompt).includes('【本次要求】'), '有【本次要求】段')
check(
  String(composed.addition).includes('保持原有几何与分格不变'),
  `第 2 段是模型整理的内容（${String(composed.addition).slice(0, 30)}…）`,
)
check(
  String(composed.prompt) === `${base}\n【本次要求】${composed.addition}`,
  '最终提示词 = 框架 + 【本次要求】，结构固定',
)

// —— 送给模型的内容要同时含框架和大白话（否则它没法只写增量）——
const plainSent = '客户想要奶油风，柜门不要拉手，木纹再深一点'
lastLlmCall = null
await call({ action: 'compose', plain: plainSent, taskMode: 'elevation', stylePreset: 'cream', referenceCount: 1 })
const userText = String(lastLlmCall?.messages?.[0]?.content?.[0]?.text ?? '')
check(userText.includes(plainSent), '大白话原样送到了模型')
check(userText.includes('【结构锁死】'), '基础框架也一并发给了模型（它才知道不要重复什么）')
check(
  userText.includes('基础框架') && userText.includes('客户原话'),
  '框架与大白话在请求里分属两段、边界清楚',
)
check(
  String(lastLlmCall?.system).includes('增量') && String(lastLlmCall?.system).includes('不要复述框架'),
  '系统提示要求只写增量、不复述框架',
)
check(
  !String(lastLlmCall?.system).includes('只描述材质、光影、氛围与画质'),
  '去掉了「只描述材质光影氛围画质」这条（它会让模型无视客户输入）',
)
check(Number(lastLlmCall?.temperature) >= 0.7, `temperature 调高了（${lastLlmCall?.temperature}），多次润色才不会一模一样`)
check(Number(lastLlmCall?.maxTokens) >= 4000, `输出预算够（${lastLlmCall?.maxTokens}），避免正文被推理吃光`)
check(String(lastLlmCall?.reasoningEffort).length > 0, `显式指定了最低推理档（${lastLlmCall?.reasoningEffort}）`)
// 文本也可能从 block-end 出来（不是 text-delta），这条必须也收得到
llmMode = 'block-end'
const viaBlock = await call({ action: 'compose', plain: '随便写点', taskMode: 'elevation', stylePreset: 'cream', referenceCount: 1 })
check(viaBlock.rewritten === true && String(viaBlock.addition).includes('文本块形态'), 'block-end 形态的模型输出也能拿到')
check(String(viaBlock.prompt).startsWith(String(viaBlock.base)), 'block-end 时框架同样保留')
// 只吐 reasoning 时：必须给出可诊断的原因，而不是一句「返回空内容」
llmMode = 'reasoning-only'
const empty = await call({ action: 'compose', plain: '随便写点', taskMode: 'elevation', stylePreset: 'cream', referenceCount: 1 })
check(empty.rewritten === false, '只吐 reasoning 时不谎报成功')
check(
  String(empty.reason).includes('reasoning') && String(empty.reason).includes('max-tokens'),
  `诊断信息里带上推理段数与结束原因（${String(empty.reason).slice(0, 60)}）`,
)
// 关键：模型不给内容时，框架不能丢，客户的字面要求也要在
check(String(empty.prompt).startsWith(String(empty.base)), '模型空返回时基础框架仍然完整保留')
check(String(empty.prompt).includes('随便写点'), '模型空返回时把客户原话直接附在框架后面（要求没丢）')
check(String(empty.prompt).includes('【本次要求】'), '仍然有【本次要求】段，结构一致')
check(Boolean(empty.fallback), '同时把纯框架版本一并带回来，界面不至于空白')
llmMode = 'text'

console.log('\n== 2. 文生图：无底图走 generations/async ==')
seen.length = 0
const textJob = await call({
  taskMode: 'text2img',
  stylePreset: 'wabisabi',
  plain: '一个侘寂风茶室，原木与微水泥，纸灯笼',
  count: 1,
})
const textCreate = seen.find((entry) => entry.path.includes('/images/') && entry.path.endsWith('/async'))
check(Boolean(textCreate), `发起了创建请求（${textCreate?.path ?? '无'}）`)
check(textCreate?.path === '/v1/images/generations/async', '无图片时走 /images/generations/async（文生图）')
check(!textCreate?.text.includes('name="source_images"'), '文生图请求里没有 source_images')
check(textCreate?.text.includes('【画面内容'), '提示词带【画面内容】（用户描述被当硬约束）')
check(textJob.files?.length === 1, '文生图产出了一张图')

console.log('\n== 3. 有底图时仍走 edits/async ==')
seen.length = 0
const elevJob = await call(
  { taskMode: 'elevation', stylePreset: 'cream', count: 1 },
  [cadBlock, refBlock],
)
const elevCreate = seen.find((entry) => entry.path.includes('/images/') && entry.path.endsWith('/async'))
check(elevCreate?.path === '/v1/images/edits/async', '有图片时走 /images/edits/async')
check(elevCreate?.text.includes('name="source_images"'), '带上了 source_images')
check(elevJob.files?.length === 1, '立面渲染产出了一张图')

console.log('\n== 3b. 出图比例必须跟随底图长宽比 ==')
// 曾经踩过：附件 ref 上没有 width/height 时静默退回 4:3，出图比例就和底图对不上。
// 底图是竖构图，所以请求里必须是竖版尺寸。
check(cadBlock.attachment.width < cadBlock.attachment.height, '测试底图本身是竖构图')
check(
  String(elevCreate?.text).includes('1024x1536'),
  `有尺寸信息时请求竖版尺寸（${/\d+x\d+/.exec(String(elevCreate?.text))?.[0] ?? '未找到'}）`,
)
// 再造一个「ref 不带宽高」的附件：插件必须自己从图片字节量出来
const blindBlock = {
  type: 'image',
  attachment: {
    attachmentId: 'cad-blind.png',
    mediaType: 'image/png',
    bytes: cadBlock.attachment.bytes,
    name: 'cad-blind.png',
    __file: cadBlock.attachment.__file,
  },
}
seen.length = 0
await call({ taskMode: 'elevation', stylePreset: 'cream', count: 1 }, [blindBlock])
const blindCreate = seen.find((entry) => entry.path.includes('/images/') && entry.path.endsWith('/async'))
check(
  String(blindCreate?.text).includes('1024x1536'),
  `ref 缺宽高时仍按底图比例出图（${/\d+x\d+/.exec(String(blindCreate?.text))?.[0] ?? '未找到'}）`,
)
check(!String(blindCreate?.text).includes('1536x1024'), 'ref 缺宽高时没有退化成横版 4:3')

console.log('\n== 3c. 用户自己选的比例必须生效 ==')
// 默认跟随底图：竖构图底图 → 竖版
seen.length = 0
await call({ taskMode: 'elevation', stylePreset: 'cream', count: 1 }, [cadBlock])
const followReq = seen.find((entry) => entry.path.includes('/images/') && entry.path.endsWith('/async'))
check(String(followReq?.text).includes('1024x1536'), '默认「跟随底图」出竖版')
// 指定 16:9：即使底图是竖的，也要出横版
seen.length = 0
const wideJob = await call({ taskMode: 'elevation', stylePreset: 'cream', count: 1, ratio: '16:9' }, [cadBlock])
const wideReq = seen.find((entry) => entry.path.includes('/images/') && entry.path.endsWith('/async'))
check(String(wideReq?.text).includes('1536x1024'), `指定 16:9 出横版（${/\d+x\d+/.exec(String(wideReq?.text))?.[0] ?? '未找到'}）`)
// 回报的必须是「接口真实收到的尺寸」，并且被归档时要说明原因
check(wideJob.size === '1536x1024', `回报真实落地的尺寸（${wideJob.size}）`)
check(
  String(wideJob.sizeNotice).includes('只支持'),
  wideJob.sizeNotice ? '比例被模型归档时给出了说明' : '（本例未被归档）',
)
// 指定 1:1
seen.length = 0
await call({ taskMode: 'elevation', stylePreset: 'cream', count: 1, ratio: '1:1' }, [cadBlock])
const squareReq = seen.find((entry) => entry.path.includes('/images/') && entry.path.endsWith('/async'))
check(String(squareReq?.text).includes('1024x1024'), `指定 1:1 出方形（${/\d+x\d+/.exec(String(squareReq?.text))?.[0] ?? '未找到'}）`)
// 显式 WxH 优先级最高
seen.length = 0
await call({ taskMode: 'elevation', stylePreset: 'cream', count: 1, ratio: '16:9', size: '1536x1024' }, [cadBlock])
check(catalog.ratios.length === 8, `目录下发 8 个比例（实为 ${catalog.ratios.length}）`)
check(
  catalog.ratios.every((item) => 'w' in item && 'h' in item),
  '每个比例都带 w/h（面板画小方框要用）',
)

console.log('\n== 3d. input_fidelity：压住「结构被改」的官方开关 ==')
// gpt-image 的 edits 接口靠这个字段决定多大程度保留输入图。
// 实测本机中转站接受 high（见 relay-modes 的断言），所以默认发 high。
seen.length = 0
await call({ taskMode: 'elevation', stylePreset: 'cream', count: 1 }, [cadBlock])
const fidReq = seen.find((entry) => entry.path.includes('/images/') && entry.path.endsWith('/async'))
check(String(fidReq?.text).includes('name="input_fidelity"'), '创建请求里带上了 input_fidelity 字段')
check(/input_fidelity"\s*\r?\n\r?\nhigh/.test(String(fidReq?.text)) || String(fidReq?.text).includes('high'), '值为 high')

console.log('\n== 3e. 画布被接口归并时，护栏必须进提示词 ==')
// gpt-image 只认三种尺寸：竖图底图（测试用的是 272x437 = 0.622）会被归到
// 1024x1536（0.667），相差 7.1%。修复前护栏用的是「我们心里算的尺寸」
// （1280x2048 = 0.625），判断为「一致」→ 护栏压根没进提示词 →
// 模型为了填满画布拉伸重排（用户反馈：结构和比例还是被改了）。
const guardBody = String(fidReq?.text ?? '')
check(guardBody.includes('画布与主体'), '画布被归并时护栏进了提示词')
check(/相差约 ?7%/.test(guardBody), '护栏里带了具体偏差百分比（7%）')
check(guardBody.includes('每一格的长宽比'), '护栏给出了可核对的自检标准')
check(guardBody.includes('绝对不许'), '护栏是硬性措辞，不是「尽量」')

console.log('\n== 4. 无底图时的图号偏移 ==')
seen.length = 0
await call(
  {
    taskMode: 'text2img',
    stylePreset: 'modern',
    plain: '@参考图1 的质感，做个灵感参考',
    count: 1,
  },
  [refBlock],
)
const offsetCreate = seen.find((entry) => entry.path.includes('/images/') && entry.path.endsWith('/async'))
check(offsetCreate?.text.includes('图1 的质感'), '无底图时 @参考图1 翻译成 图1')
check(
  offsetCreate?.text.includes('【图号】图1 = 参考图1'),
  '无底图时图号对照从图1 开始（没有「底图」这一项）',
)

console.log('\n== 5. 分析图注入类型说明（只给底图、不给参考图也要能出） ==')
seen.length = 0
const diagramJob = await call({ taskMode: 'diagram', stylePreset: 'modern', diagram: 'circulation', count: 1 }, [cadBlock])
const diagramCreate = seen.find((entry) => entry.path.includes('/images/') && entry.path.endsWith('/async'))
check(diagramCreate?.text.includes('【分析图类型】'), '注入了【分析图类型】')
check(diagramCreate?.text.includes('流线分析'), '注入的是选中的流线分析')
check(diagramJob.files?.length === 1, '只有底图 + 风格预设也能出图（不强制参考图）')

console.log('\n== 5b. 跟随参考图时仍然强制要参考图 ==')
let guardMessage = ''
try {
  await call({ taskMode: 'elevation', stylePreset: 'custom', count: 1 }, [cadBlock])
} catch (error) {
  guardMessage = String(error.message)
}
check(guardMessage.includes('参考图'), '选「跟随参考图」但没给参考图时明确报错')

console.log('\n== 6. 一键操作走「改这张」通道 ==')
seen.length = 0
const quick = catalog.quickActions.find((action) => action.id === 'light-night')
const refineJob = await call(
  {
    taskMode: 'elevation',
    stylePreset: 'cream',
    instruction: quick.hint === '' ? '' : '把这张图改成夜间氛围：柜内线性藏灯与主光、环境压暗；结构材质构图完全不动。',
    refineFrom: elevJob.files[0].path,
    count: 1,
  },
  [cadBlock],
)
const refineCreate = seen.find((entry) => entry.path.includes('/images/') && entry.path.endsWith('/async'))
check(refineCreate?.text.includes('【本次改动】'), '一键操作进入迭代改图通道（带【本次改动】）')
check(refineCreate?.text.includes('夜间氛围'), '改动内容进了提示词')
check(refineCreate?.text.includes('除下面点名的改动之外'), '改图模式仍带「只改这一处」的结构锁死')
check(refineJob.files?.length === 1, '一键操作产出了一张新图')

console.log(`\n${failures === 0 ? 'OPERATIONS TEST PASSED' : `OPERATIONS TEST FAILED (${failures})`}`)
server.close()
await fsp.rm(fakeHome, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
