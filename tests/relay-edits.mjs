/**
 * 精确测出这个中转站支持哪种「带参考图」的请求形态。
 * 每个形态最多产 1 张图，结果存到 tests/out/。
 *
 * 用法：node tests/relay-edits.mjs
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
const MODEL = settings.openaiModel || 'gpt-image-2'

const cad = await fsp.readFile(path.join(here, 'fixtures', 'cad-elevation.png'))
const ref = await fsp.readFile(path.join(here, 'fixtures', 'reference.png'))
const tiny = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`

async function save(label, json) {
  const item = json?.data?.[0]
  if (!item) return false
  const bytes = item.b64_json ? Buffer.from(item.b64_json, 'base64') : Buffer.from(await (await fetch(item.url)).arrayBuffer())
  const file = path.join(out, `${label}.png`)
  await fsp.writeFile(file, bytes)
  const size = (await fsp.stat(file)).size
  console.log(`  ✅ 成功 → ${path.basename(file)} (${(size / 1024).toFixed(0)} KB)`)
  return true
}

async function attempt(label, url, init) {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) },
    })
    const text = await response.text()
    const ms = Date.now() - started
    let json = null
    try { json = JSON.parse(text) } catch {}
    process.stdout.write(`\n[${label}]  HTTP ${response.status}  (${ms}ms)  `)
    if (!response.ok) {
      console.log(`\n  失败：${String(json?.error?.message ?? json?.message ?? text).slice(0, 260)}`)
      return false
    }
    return await save(label, json)
  } catch (failure) {
    console.log(`\n[${label}]  请求异常：${failure.message}`)
    return false
  }
}

const form = (fields, images) => {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.append(key, value)
  for (const [field, buf, name] of images) body.append(field, new Blob([buf], { type: 'image/png' }), name)
  return { method: 'POST', body }
}

console.log(`中转站 ${BASE} · 模型 ${MODEL}`)

// E1：edits + 单图，字段 image
await attempt('E1-edits-single-image', `${BASE}/images/edits`,
  form({ model: MODEL, prompt: 'make this drawing photorealistic', n: '1', size: '1024x1024' },
    [['image', tiny, 'seed.png']]))

// E2：edits + 两图，字段 image[]
await attempt('E2-edits-multi-image[]', `${BASE}/images/edits`,
  form({ model: MODEL, prompt: 'keep the layout, apply the material from image 2', n: '1', size: '1536x1024' },
    [['image[]', cad, 'cad.png'], ['image[]', ref, 'ref.png']]))

// E3：edits + 两图，字段都叫 image（部分站点只认这个）
await attempt('E3-edits-multi-image', `${BASE}/images/edits`,
  form({ model: MODEL, prompt: 'keep the layout, apply the material from image 2', n: '1', size: '1536x1024' },
    [['image', cad, 'cad.png'], ['image', ref, 'ref.png']]))

// F：generations + image 字段带参考图（部分站点在文生图上支持参考）
await attempt('F-generations-image', `${BASE}/images/generations`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    prompt: 'keep the layout of the first image, apply the material of the second',
    n: 1,
    size: '1024x1024',
    image: [dataUrl(cad), dataUrl(ref)],
  }),
})

console.log('\n诊断结束，成功的形态见上面带 ✅ 的行。')
