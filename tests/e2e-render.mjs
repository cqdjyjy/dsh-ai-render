/**
 * 真实出图的端到端回归测试。
 *
 * 直接驱动插件宿主端注册出来的命令 handler（不经 UI、不经会话），
 * 用真实 API Key 打真实图像服务，把结果写到 tests/out/。
 * 密钥来源与插件一致：<DSH_HOME>/ai-render/settings.json（或环境变量）。
 *
 * 用法：
 *   node tests/e2e-render.mjs [provider=ark|qwen] [count=1..4]
 *
 * 注意：会真实计费（按成功张数）。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const fixtures = path.join(here, 'fixtures')
const out = path.join(here, 'out')

const provider = ['ark', 'qwen', 'openai'].includes(process.argv[2]) ? process.argv[2] : 'ark'
const count = Math.max(1, Math.min(4, Number(process.argv[3]) || 1))

const plugin = await import(`file://${path.join(root, 'index.js').replaceAll('\\', '/')}`)

let definition = null
const fakeCtx = {
  effect: (fn) => fn(),
  commands: { register: (def) => ((definition = def), () => {}) },
  attachments: {
    async readImage(ref) {
      const bytes = await fsp.readFile(ref.__file)
      return { ref, data: new Uint8Array(bytes) }
    },
  },
  sessions: { get: (id) => ({ header: { id, cwd: path.join(here, '..') } }) },
}
plugin.apply(fakeCtx, {})

const imageBlock = async (file) => {
  const { promises: fsp2 } = await import('node:fs')
  const bytes = await fsp2.readFile(file)
  // 用 PNG 头读出宽高，避免引第三方库。
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return {
    type: 'image',
    attachment: {
      attachmentId: path.basename(file),
      mediaType: 'image/png',
      bytes: bytes.length,
      width,
      height,
      name: path.basename(file),
      __file: file,
    },
  }
}

const invoke = (rawInput, attachments) =>
  definition.handler({
    commandId: 'e2e',
    agent: { id: 'e2e-session' },
    rawInput,
    attachments,
    signal: new AbortController().signal,
  })

console.log('== status ==')
const status = await invoke(JSON.stringify({ action: 'status' }), [])
console.log(status.text)

if (provider === 'openai') {
  console.log('\n== 探测中转站 GET /v1/models ==')
  const probed = await invoke(JSON.stringify({ action: 'probe' }), [])
  console.log(probed.kind === 'success' ? probed.text.slice(0, 1500) : probed.text)
  if (probed.kind !== 'success') process.exit(1)
}

const cadPath = path.join(fixtures, 'cad-elevation.png')
const refPath = path.join(fixtures, 'reference.png')
try {
  await fsp.access(cadPath)
} catch {
  console.error(`\n缺少测试图：先跑 python tests/make-fixtures.py "${fixtures}"`)
  process.exit(1)
}

console.log(`\n== 真实出图 provider=${provider} count=${count} ==`)
const started = Date.now()
const result = await invoke(
  JSON.stringify({ provider, count, promptExtra: '', outDir: out }),
  [await imageBlock(cadPath), await imageBlock(refPath)],
)

if (result.kind !== 'success') {
  console.error('FAILED:', result.text)
  process.exit(1)
}
const payload = JSON.parse(result.text)
console.log(`provider   : ${payload.providerLabel} / ${payload.model}`)
if (payload.modeUsed) console.log(`实际形态   : ${payload.modeUsed}`)
console.log(`size       : ${payload.size}`)
console.log(`elapsed    : ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log(`dir        : ${payload.dir}`)
for (const file of payload.files) {
  const stat = await fsp.stat(file.path)
  console.log(`  - ${file.name}  ${(stat.size / 1024).toFixed(0)} KB`)
}
console.log('\nE2E PASSED')
