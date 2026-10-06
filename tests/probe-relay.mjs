/**
 * 只探测中转站：不出图、不花钱。顺便验证 Key 是否已被读到。
 * 打印时刻意对 Key 做掩码，不把密钥写进任何输出。
 *
 * 用法：node tests/probe-relay.mjs
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const settingsPath = path.join(
  process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : path.join(process.env.USERPROFILE ?? '', '.dsh'),
  'ai-render',
  'settings.json',
)

const mask = (value) => {
  const text = String(value ?? '')
  if (!text) return '(空)'
  const head = text.slice(0, 6)
  return `${head}${'*'.repeat(Math.max(0, text.length - 10))}${text.slice(-4)}  (长度 ${text.length})`
}

console.log('== 设置文件 ==')
console.log('路径     :', settingsPath)
try {
  const raw = await fsp.readFile(settingsPath, 'utf8')
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  console.log('baseUrl  :', parsed.openaiBaseUrl)
  console.log('model    :', parsed.openaiModel)
  console.log('mode     :', parsed.openaiMode)
  console.log('apiKey   :', mask(parsed.openaiApiKey))
} catch (failure) {
  console.log('读取失败 :', failure.message)
}

const plugin = await import(`file://${path.join(root, 'index.js').replaceAll('\\', '/')}`)
let definition = null
plugin.apply(
  {
    effect: (fn) => fn(),
    commands: { register: (def) => ((definition = def), () => {}) },
    attachments: { async readImage(ref) { return { ref, data: new Uint8Array() } } },
    sessions: { get: (id) => ({ header: { id, cwd: here } }) },
  },
  {},
)

const call = async (job) => {
  const result = await definition.handler({
    commandId: 'probe',
    agent: { id: 'probe-session' },
    rawInput: JSON.stringify(job),
    attachments: [],
    signal: new AbortController().signal,
  })
  return result
}

console.log('\n== 插件 status ==')
const status = await call({ action: 'status' })
const info = JSON.parse(status.text)
console.log('openai.configured :', info.openai.configured)
console.log('openai.baseUrl    :', info.openai.baseUrl)
console.log('openai.mode       :', info.openai.mode)
console.log('settingsError     :', info.settingsError || '(无)')
if (!info.openai.configured) {
  console.log('\nKey 还没读到，先在记事本里填好并保存（Ctrl+S），再跑一次。')
  process.exit(1)
}

console.log('\n== 探测 GET /v1/models ==')
const probed = await call({ action: 'probe' })
if (probed.kind !== 'success') {
  console.log('失败：', probed.text)
  process.exit(1)
}
const list = JSON.parse(probed.text)
console.log('接口地址   :', list.baseUrl)
console.log('模型总数   :', list.total)
console.log('\n像图像模型的候选（可直接填进 openaiModel）：')
for (const id of list.imageLike ?? []) console.log('  -', id)
if (!list.imageLike?.length) {
  console.log('  （没识别出图像模型，下面是全部前 40 个）')
  for (const id of list.sample ?? []) console.log('  -', id)
}
