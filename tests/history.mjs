/**
 * 离线验证「历史记录 + 参数复用」。不联网、不花钱（本地假中转站）。
 *
 * 覆盖：
 *   1. 每次出图后自动记一条历史（参数 + 结果路径 + 提示词）
 *   2. 记录里带齐「还原参数」需要的字段
 *   3. 最新的排在最前
 *   4. history-clear 清空（但不动磁盘上的图片）
 *   5. 历史文件损坏时：出图照样成功，history 报错但返回空数组
 *   6. 记录条数有上限
 *
 * 用法：node tests/history.mjs
 */
import http from 'node:http'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const out = path.join(here, 'out')
const fakeHome = path.join(here, '.fake-home-hist')
const historyPath = path.join(fakeHome, 'ai-render', 'history.json')

process.env.AI_RENDER_POLL_MS = '60'
process.env.DSH_HOME = fakeHome

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

let failures = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

let taskCount = 0
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    if (req.url?.endsWith('.png')) {
      res.setHeader('content-type', 'image/png')
      return res.end(PNG)
    }
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
        result: { data: [{ url: `http://127.0.0.1:${server.address().port}/v1/fake.png` }] },
      })
    }
    send(404, { error: { message: `unhandled ${req.url}` } })
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`

await fsp.rm(fakeHome, { recursive: true, force: true })
await fsp.mkdir(path.join(fakeHome, 'ai-render'), { recursive: true })
const settings = { openaiBaseUrl: baseUrl, openaiApiKey: 'fake-key', openaiMode: 'auto', openaiModel: 'gpt-image-2' }
await fsp.writeFile(path.join(fakeHome, 'ai-render', 'settings.json'), JSON.stringify(settings), 'utf8')

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

const call = async (job, attachments = []) => {
  const result = await definition.handler({
    commandId: 'hist',
    agent: { id: 'hist-session' },
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

console.log('== 1. 出图后自动记历史 ==')
let blank = await call({ action: 'history' })
check(blank.records.length === 0, '一开始没有历史记录')

const first = await call(
  {
    taskMode: 'elevation',
    stylePreset: 'cream',
    lighting: 'dusk',
    camera: 'slight',
    plain: '柜门做无拉手，台面深色岩板',
    structure: '左 200 通高侧板；上部三层板',
    count: 1,
  },
  [cadBlock],
)
check(Boolean(first.historyId), '出图结果里带回了 historyId')

let history = await call({ action: 'history' })
check(history.records.length === 1, `记下 1 条（实为 ${history.records.length}）`)
const record = history.records[0]
check(record.taskMode === 'elevation', '记下了操作类型')
check(record.stylePreset === 'cream', '记下了风格预设')
check(record.lighting === 'dusk', '记下了光影')
check(record.camera === 'slight', '记下了构图')
check(record.plain === '柜门做无拉手，台面深色岩板', '记下了大白话原文')
check(record.structure.includes('上部三层板'), '记下了结构清单')
check(typeof record.prompt === 'string' && record.prompt.includes('【结构锁死】'), '记下了最终提示词（便于复现）')
check(Array.isArray(record.files) && record.files.length === 1, '记下了结果文件路径')
check(record.size === first.size, '记下的尺寸与实际一致')
check(record.taskModeLabel === '立面 / 施工图', '记下了可读的操作名')
check(record.styleLabel === '奶油风' || record.styleLabel.length > 0, '记下了可读的风格名')

console.log('\n== 2. 最新的排在最前 ==')
await call({ taskMode: 'text2img', stylePreset: 'wabisabi', plain: '侘寂茶室', count: 1 })
history = await call({ action: 'history' })
check(history.records.length === 2, `累计 2 条（实为 ${history.records.length}）`)
check(history.records[0].taskMode === 'text2img', '最新一条（文生图）排在最前')
check(history.records[1].taskMode === 'elevation', '上一条排在后面')

console.log('\n== 3. limit 生效 ==')
const limited = await call({ action: 'history', limit: 1 })
check(limited.count === 2 && limited.records.length === 1, 'count 是总数、records 受 limit 限制')

console.log('\n== 4. 清空历史 ==')
await call({ action: 'history-clear' })
history = await call({ action: 'history' })
check(history.records.length === 0, '清空后没有记录')
check(
  await fsp
    .stat(first.files[0].path)
    .then(() => true)
    .catch(() => false),
  '清空历史不会删除磁盘上的图片',
)

console.log('\n== 5. 历史文件损坏时的行为 ==')
await fsp.writeFile(historyPath, '{ 这不是合法 JSON', 'utf8')
const broken = await call({ action: 'history' })
check(broken.records.length === 0, '损坏时返回空列表而不是抛错')
check(String(broken.error).includes('历史记录文件无法读取'), '给出了明确的历史文件错误提示')

const afterCorrupt = await call({ taskMode: 'elevation', stylePreset: 'modern', count: 1 }, [cadBlock])
check(afterCorrupt.files?.length === 1, '历史文件坏了，出图仍然成功')
const healed = await call({ action: 'history' })
check(healed.records.length === 1 && !healed.error, '坏文件被自愈成合法历史（本次记录保留）')

console.log('\n== 6. 条数上限 ==')
const many = { version: 1, records: Array.from({ length: 200 }, (_, index) => ({ id: `r${index}`, at: '2026-01-01' })) }
await fsp.writeFile(historyPath, JSON.stringify(many), 'utf8')
await call({ taskMode: 'elevation', stylePreset: 'modern', count: 1 }, [cadBlock])
const capped = JSON.parse(await fsp.readFile(historyPath, 'utf8'))
check(capped.records.length === 80, `写入后裁到上限 80（实为 ${capped.records.length}）`)
check(capped.records[0].taskMode === 'elevation', '新记录仍然在最前')

console.log(`\n${failures === 0 ? 'HISTORY TEST PASSED' : `HISTORY TEST FAILED (${failures})`}`)
server.close()
await fsp.rm(fakeHome, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
