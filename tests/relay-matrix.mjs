/**
 * 受控矩阵测试：找出这个中转站「带参考图」的正确请求形态。
 * - 每次请求间隔 20 秒，避开限流
 * - 命中第一个成功就停（出图才计费）
 * - 密钥从设置文件读，不打印
 *
 * 用法：node tests/relay-matrix.mjs
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'out')
await fsp.mkdir(out, { recursive: true })

const dshHome =
  process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(process.env.USERPROFILE ?? '', '.dsh')
const settings = JSON.parse(
  (await fsp.readFile(path.join(dshHome, 'ai-render', 'settings.json'), 'utf8')).replace(/^\uFEFF/, ''),
)
const BASE = String(settings.openaiBaseUrl).replace(/\/+$/, '')
const KEY = settings.openaiApiKey
if (!KEY) {
  console.error('设置文件里没有 Key')
  process.exit(1)
}

const cad = await fsp.readFile(path.join(here, 'fixtures', 'cad-elevation.png'))
const ref = await fsp.readFile(path.join(here, 'fixtures', 'reference.png'))
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PROMPT = 'keep the layout of the cabinet drawing, apply the wood and stone materials from the reference photo'

let succeeded = null

async function attempt(label, url, init) {
  const started = Date.now()
  console.log(`\n[${label}]`)
  try {
    const response = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) },
    })
    const text = await response.text()
    const ms = Date.now() - started
    let json = null
    try { json = JSON.parse(text) } catch {}
    const first = json?.data?.[0]
    if (!response.ok) {
      console.log(`  ${init.method ?? 'GET'} …  HTTP ${response.status} (${ms}ms)`)
      console.log(`  原因：${String(json?.error?.message ?? json?.message ?? text).slice(0, 240)}`)
      return false
    }
    console.log(`  HTTP ${response.status} (${ms}ms)  ✅ 出图`)
    if (first) {
      const bytes = first.b64_json
        ? Buffer.from(first.b64_json, 'base64')
        : Buffer.from(await (await fetch(first.url)).arrayBuffer())
      const file = path.join(out, `${label}.png`)
      await fsp.writeFile(file, bytes)
      console.log(`  已存：${file}  (${(bytes.length / 1024).toFixed(0)} KB)`)
    }
    succeeded = label
    return true
  } catch (failure) {
    console.log(`  请求异常：${failure.message}`)
    return false
  }
}

const multipart = (fields, images) => {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.append(key, value)
  for (const [field, buf, name] of images) body.append(field, new Blob([buf], { type: 'image/png' }), name)
  return { method: 'POST', body }
}
const jsonInit = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const steps = [
  ['M1-edits-image-single-2.5', `${BASE}/images/edits`,
    () => multipart({ model: 'gpt-image-2.5', prompt: PROMPT, n: '1', size: '1024x1024' }, [['image', ref, 'reference.png']])],
  ['M2-edits-image[]-multi-2.5', `${BASE}/images/edits`,
    () => multipart({ model: 'gpt-image-2.5', prompt: PROMPT, n: '1', size: '1024x1024' },
      [['image[]', cad, 'cad.png'], ['image[]', ref, 'reference.png']])],
  ['M3-edits-image-single-2', `${BASE}/images/edits`,
    () => multipart({ model: 'gpt-image-2', prompt: PROMPT, n: '1', size: '1024x1024' }, [['image', ref, 'reference.png']])],
  ['M4-generations-image-string', `${BASE}/images/generations`,
    () => jsonInit({ model: 'gpt-image-2.5', prompt: PROMPT, n: 1, size: '1024x1024', image: dataUrl(ref) })],
  ['M5-edits-json-base64', `${BASE}/images/edits`,
    () => jsonInit({ model: 'gpt-image-2.5', prompt: PROMPT, n: 1, size: '1024x1024', image: dataUrl(ref) })],
]

console.log(`中转站 ${BASE}`)
console.log(`将依次尝试 ${steps.length} 种形态，每次间隔 20 秒。`)

for (const [index, [label, url, build]] of steps.entries()) {
  if (index > 0) await sleep(20000)
  await attempt(label, url, build())
  if (succeeded) break
}

console.log(succeeded ? `\n结论：可用形态 = ${succeeded}` : '\n结论：5 种形态都没成功。')
