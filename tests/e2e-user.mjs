/**
 * 用用户真实素材验证「裁切 + 反相」是否改善结构还原。会计费。
 *
 *   CAD 输入 = tests/fixtures/user-cad-front.png（正立面，已反相成白底黑线）
 *   参考输入 = tests/fixtures/user-ref-wall.jpg（只裁材质区域）
 *
 * 先跑 python tests/make-user-fixtures.py tests/fixtures 生成这两张。
 *
 * 用法：node tests/e2e-user.mjs [provider] [stylePreset] [refFile]
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const fixtures = path.join(here, 'fixtures')
const out = path.join(here, 'out')

const provider = ['ark', 'qwen', 'openai', 'gemini'].includes(process.argv[2]) ? process.argv[2] : 'openai'
const stylePreset = process.argv[3] ?? 'modern'
const refName = process.argv[4] ?? 'user-ref-wall.jpg'
const plain = process.argv[5] ?? ''
const taskMode = process.argv[6] ?? 'elevation'
const ratio = process.argv[7] ?? 'follow'
const useAttachments = taskMode !== 'text2img'
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

/** PNG 与 JPEG 都要能读出宽高，别只认 PNG。 */
async function imageBlock(file) {
  const bytes = await fsp.readFile(file)
  let width = 0
  let height = 0
  if (bytes.readUInt32BE(0) === 0x89504e47) {
    width = bytes.readUInt32BE(16)
    height = bytes.readUInt32BE(20)
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset < bytes.length - 9) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1]
      const length = bytes.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = bytes.readUInt16BE(offset + 5)
        width = bytes.readUInt16BE(offset + 7)
        break
      }
      offset += 2 + length
    }
  }
  return {
    type: 'image',
    attachment: {
      attachmentId: path.basename(file),
      mediaType: file.endsWith('.png') ? 'image/png' : 'image/jpeg',
      bytes: bytes.length,
      width,
      height,
      name: path.basename(file),
      __file: file,
    },
  }
}

const cadFile = path.join(fixtures, process.env.CAD_FILE ?? 'user-cad-front.png')
const refFile = path.join(fixtures, refName)
const cadBlock = useAttachments ? await imageBlock(cadFile) : null
// 参考图可选：文件名不存在就表示「只给底图」。
const hasRef = useAttachments && (await fsp.stat(refFile).then(() => true).catch(() => false))
const refBlock = hasRef ? await imageBlock(refFile) : null
if (useAttachments) {
  console.log(`底图   : ${path.basename(cadFile)}  ${cadBlock.attachment.width}x${cadBlock.attachment.height}`)
  console.log(
    `参考图 : ${hasRef ? `${path.basename(refFile)}  ${refBlock.attachment.width}x${refBlock.attachment.height}` : '（只给底图）'}`,
  )
} else {
  console.log(`模式   : ${taskMode}（不带任何图片，纯文字出图）`)
}

const started = Date.now()
const result = await definition.handler({
  commandId: 'e2e-user',
  agent: { id: 'e2e-session' },
  rawInput: JSON.stringify({
    provider,
    stylePreset,
    taskMode,
    ratio,
    lighting: 'auto',
    count: 1,
    outDir: out,
    plain,
  }),
  attachments: useAttachments ? [cadBlock, refBlock].filter(Boolean) : [],
  signal: new AbortController().signal,
})

if (result.kind !== 'success') {
  console.error('FAILED:', result.text)
  process.exit(1)
}
const payload = JSON.parse(result.text)
console.log(`\n形态   : ${payload.modeUsed ?? '(同步)'}`)
console.log(`目标尺寸: ${payload.size}`)
console.log(`耗时   : ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (plain) {
  console.log('\n提示词（验证 @提及 是否翻译成图号）：')
  console.log(payload.prompt)
}
console.log(`\n文件   : ${payload.files[0].path}`)
console.log('\nE2E USER PASSED')
