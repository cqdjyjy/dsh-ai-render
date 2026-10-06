/**
 * 真实端到端：验证「风格预设」与「迭代改图」两条 agent 主线。会计费。
 *
 *   1. 用 奶油风 预设出一张
 *   2. 拿这张当输入，用一句修改意见再出一张（画布式迭代）
 *
 * 用法：node tests/e2e-presets.mjs [provider] [stylePreset]
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const fixtures = path.join(here, 'fixtures')
const out = path.join(here, 'out')

const provider = ['ark', 'qwen', 'openai'].includes(process.argv[2]) ? process.argv[2] : 'openai'
const stylePreset = process.argv[3] ?? 'cream'
const instruction = process.argv[4] ?? '柜门换成浅色原木格栅样式，五金改为隐形无拉手，其余结构与构图完全不动'

await fsp.mkdir(out, { recursive: true })

const plugin = await import(`file://${path.join(root, 'index.js').replaceAll('\\', '/')}`)
let definition = null
plugin.apply(
  {
    effect: (fn) => fn(),
    commands: { register: (def) => ((definition = def), () => {}) },
    attachments: { async readImage(ref) { return { ref, data: new Uint8Array(await fsp.readFile(ref.__file)) } } },
    sessions: { get: (id) => ({ header: { id, cwd: root } }) },
  },
  {},
)

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

const invoke = (job, attachments) =>
  definition.handler({
    commandId: 'e2e-presets',
    agent: { id: 'e2e-session' },
    rawInput: JSON.stringify(job),
    attachments,
    signal: new AbortController().signal,
  })

const cadBlock = await imageBlock(path.join(fixtures, 'cad-elevation.png'))
const refBlock = await imageBlock(path.join(fixtures, 'reference.png'))

// ---------------------------------------------------- 1. 风格预设

console.log(`== 1. 真实出图 · 风格预设 ${stylePreset} ==`)
const first = await invoke({ provider, stylePreset, taskMode: 'elevation', lighting: 'auto', count: 1, outDir: out }, [cadBlock, refBlock])
if (first.kind !== 'success') {
  console.error('FAILED:', first.text)
  process.exit(1)
}
const firstPayload = JSON.parse(first.text)
console.log(`形态     : ${firstPayload.modeUsed ?? '(同步)'}`)
console.log(`耗时     : ${((firstPayload.elapsedMs ?? 0) / 1000).toFixed(1)}s`)
console.log(`提示词   :\n${firstPayload.prompt}`)
console.log(`文件     : ${firstPayload.files[0].path}`)

// ---------------------------------------------------- 2. 迭代改图

console.log(`\n== 2. 迭代改图：在上一版基础上只改一处 ==`)
console.log(`修改意见 : ${instruction}`)
const second = await invoke(
  {
    provider,
    stylePreset,
    taskMode: 'elevation',
    lighting: 'auto',
    count: 1,
    outDir: out,
    refineFrom: firstPayload.files[0].path,
    instruction,
  },
  [cadBlock, refBlock],
)
if (second.kind !== 'success') {
  console.error('FAILED:', second.text)
  process.exit(1)
}
const secondPayload = JSON.parse(second.text)
console.log(`是否迭代 : ${secondPayload.refined}`)
console.log(`耗时     : ${((secondPayload.elapsedMs ?? 0) / 1000).toFixed(1)}s`)
console.log(`提示词   :\n${secondPayload.prompt}`)
console.log(`文件     : ${secondPayload.files[0].path}`)

console.log('\nE2E PRESETS PASSED')
