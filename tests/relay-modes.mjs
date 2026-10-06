/**
 * 用本地假中转站离线验证 OpenAI 兼容分支。不联网、不花钱。
 *
 * 覆盖：
 *   1. 智能模式的尝试顺序（异步接口优先）
 *   2. AILink 式异步流程：创建 → 轮询 processing → completed → 下载 → 落盘
 *   3. 异步请求的字段名（source_images 重复、mode、size）
 *   4. 同步 /v1/images/edits 的 multipart 构造
 *   5. chat 回复里 base64 图片的解析（且只算一次）
 *   6. 任务创建成功后失败，绝不换形态重试（防重复扣费）
 *
 * 用法：node tests/relay-modes.mjs
 */
import http from 'node:http'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const out = path.join(here, 'out')
const fakeHome = path.join(here, '.fake-home')

// 让轮询间隔压到 120ms，测试不用干等 3 秒
process.env.AI_RENDER_POLL_MS = '120'
process.env.DSH_HOME = fakeHome

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

let failures = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

// ---------------------------------------------------------------- 假中转站

const seen = []
/** 'ok' = 异步成功；'fail' = 任务失败；'none' = 不实现异步 */
let asyncBehaviour = 'none'
let chatSucceeds = false
let pollCount = 0

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    seen.push({
      method: req.method,
      path: req.url,
      contentType: req.headers['content-type'] ?? '',
      text: raw.toString('utf8'),
    })
    const send = (status, body, type = 'application/json') => {
      res.statusCode = status
      res.setHeader('content-type', type)
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    }

    if (req.url === '/v1/images/edits/async' && req.method === 'POST' && asyncBehaviour !== 'none') {
      return send(202, { task_id: 'temp_linkai_img_0123456789abcdef0123456789abcdef', status: 'processing' })
    }
    if (req.url?.startsWith('/v1/images/tasks/')) {
      pollCount += 1
      if (asyncBehaviour === 'fail') {
        return send(200, { status: 'failed', http_status: 500, error: { message: 'upstream exploded' } })
      }
      if (pollCount === 1) return send(200, { status: 'processing' })
      return send(200, {
        status: 'completed',
        result: { data: [{ url: `http://127.0.0.1:${server.address().port}/files/out.png` }] },
      })
    }
    if (req.url === '/files/out.png') return send(200, PNG_1x1, 'image/png')
    if (chatSucceeds && req.url === '/v1/chat/completions') {
      return send(200, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: '这是效果图' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1x1.toString('base64')}` } },
              ],
            },
          },
        ],
      })
    }
    send(404, { error: { message: `no such endpoint: ${req.url}`, type: 'invalid_request_error' } })
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
console.log(`假中转站: ${baseUrl}\n`)

// ---------------------------------------------------------------- 装配插件

await fsp.rm(fakeHome, { recursive: true, force: true })
await fsp.mkdir(path.join(fakeHome, 'ai-render'), { recursive: true })
const writeSettings = (settings) =>
  fsp.writeFile(path.join(fakeHome, 'ai-render', 'settings.json'), JSON.stringify(settings), 'utf8')

await writeSettings({
  openaiBaseUrl: baseUrl,
  openaiApiKey: 'fake-relay-key',
  openaiMode: 'auto',
  openaiModel: 'gpt-image-2',
})

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

const cadBlock = await imageBlock(path.join(here, 'fixtures', 'cad-elevation.png'))
const refBlock = await imageBlock(path.join(here, 'fixtures', 'reference.png'))
const invoke = (job, attachments = [cadBlock, refBlock]) =>
  definition.handler({
    commandId: 'relay-test',
    agent: { id: 'relay-session' },
    rawInput: JSON.stringify(job),
    attachments,
    signal: new AbortController().signal,
  })

// ---------------------------------------------------- 1. 全失败 → 顺序与聚合

console.log('== 1. 全 404：验证智能模式顺序与错误聚合 ==')
asyncBehaviour = 'none'
seen.length = 0
const allFail = await invoke({ provider: 'openai', count: 1, promptExtra: '' })
check(allFail.kind === 'error', '全部失败时结算为 error')
const order = seen.map((request) => request.path)
check(order[0] === '/v1/images/edits/async', `gpt-image 优先走异步接口（实际第一跳 ${order[0]}）`)
check(order.includes('/v1/linkai/images/edits/async'), '回退尝试 linkai 异步入口')
check(order.includes('/v1/images/edits'), '回退尝试同步 edits')
check(String(allFail.text).includes('都试过了'), '错误里说明多种形态都试过')

// ---------------------------------------------------- 2. 异步成功

console.log('\n== 2. AILink 式异步：创建 → 轮询 → 下载 → 落盘 ==')
asyncBehaviour = 'ok'
pollCount = 0
seen.length = 0
const asyncRun = await invoke({ provider: 'openai', count: 1, promptExtra: '' })
check(asyncRun.kind === 'success', '异步流程结算为 success')
if (asyncRun.kind === 'success') {
  const payload = JSON.parse(asyncRun.text)
  check(payload.modeUsed === 'async', `回报实际形态（${payload.modeUsed}）`)
  check(payload.files?.length === 1, '产出 1 个文件')
  const bytes = await fsp.readFile(payload.files[0].path)
  check(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '落盘文件是合法 PNG')
}
const create = seen.find((request) => request.path === '/v1/images/edits/async')
check(Boolean(create), '发出过 /v1/images/edits/async')
check(String(create?.contentType).startsWith('multipart/form-data'), '创建请求是 multipart')
check(String(create?.text).includes('name="source_images"'), '参考图字段名是 source_images')
check(String(create?.text).split('name="source_images"').length - 1 === 2, '两张图都进了 source_images')
check(String(create?.text).includes('name="mode"'), '带 mode 字段')
check(String(create?.text).includes('name="model"') && String(create?.text).includes('name="prompt"'), '带 model 与 prompt')
check(pollCount >= 2, `轮询到了 processing 再 completed（共查了 ${pollCount} 次）`)

// ---------------------------------------------------- 3. 任务失败 → 不得重试

console.log('\n== 3. 任务已创建但失败：绝不换形态重试（防重复扣费）==')
asyncBehaviour = 'fail'
pollCount = 0
seen.length = 0
const taskFail = await invoke({ provider: 'openai', count: 1, promptExtra: '' })
check(taskFail.kind === 'error', '任务失败时结算为 error')
check(String(taskFail.text).includes('upstream exploded'), '错误里带上游原因')
check(String(taskFail.text).includes('temp_linkai_img_'), '错误里带 task_id，便于人工查回')
const afterCreate = seen.filter((request) => !request.path.startsWith('/v1/images/tasks/'))
check(afterCreate.length === 1, `创建之后再没发过别的创建请求（实际 ${afterCreate.length} 个）`)

// ---------------------------------------------------- 4. 同步 edits 构造

console.log('\n== 4. 同步 /v1/images/edits 的 multipart 构造 ==')
await writeSettings({
  openaiBaseUrl: baseUrl,
  openaiApiKey: 'fake-relay-key',
  openaiMode: 'edits',
  openaiModel: 'gpt-image-2',
  openaiImageField: 'image',
})
asyncBehaviour = 'none'
seen.length = 0
await invoke({ provider: 'openai', count: 1, promptExtra: '' })
const editsRequest = seen.find((request) => request.path === '/v1/images/edits')
check(Boolean(editsRequest), '发出过 /v1/images/edits')
check(String(editsRequest?.contentType).startsWith('multipart/form-data'), 'Content-Type 是 multipart/form-data')
check(String(editsRequest?.text).split('name="image"').length - 1 === 2, 'openaiImageField=image 时两张图都进 image 字段')
check(String(editsRequest?.text).includes('name="prompt"'), '带 prompt 字段')

// ---------------------------------------------------- 5. 固定 chat 形态

console.log('\n== 5. 固定 chat 形态：base64 图片解析且不重复计数 ==')
await writeSettings({
  openaiBaseUrl: baseUrl,
  openaiApiKey: 'fake-relay-key',
  openaiMode: 'chat',
  openaiModel: 'gemini-2.5-flash-image',
})
asyncBehaviour = 'none'
chatSucceeds = true
seen.length = 0
const chatRun = await invoke({ provider: 'openai', count: 1, promptExtra: '' })
check(chatRun.kind === 'success', 'chat 返回图片时成功')
const chatRequest = seen.find((request) => request.path === '/v1/chat/completions')
const chatBody = JSON.parse(chatRequest?.text ?? '{}')
const parts = chatBody?.messages?.[0]?.content ?? []
check(parts.filter((part) => part.type === 'image_url').length === 2, 'chat 里带了两张 image_url')
if (chatRun.kind === 'success') {
  const payload = JSON.parse(chatRun.text)
  check(payload.files?.length === 1, 'chat 图片只算一次（不被重复计入）')
}

server.close()
// 插件按会话 cwd 出图，会落在 out/AI效果图/ —— 测试自己收尾
await fsp.rm(path.join(out, 'AI效果图'), { recursive: true, force: true })
await fsp.rm(fakeHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nRELAY MODES TEST PASSED' : `\nRELAY MODES TEST FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
