/**
 * 中转站诊断：分清「我们请求格式不对」还是「中转站上游挂了」。
 * 刻意用最小请求，命中的第一个成功就停（成功才计费）。
 * 密钥从设置文件读，不打印。
 *
 * 用法：node tests/relay-diagnose.mjs
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'

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

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

let succeeded = null

async function call(label, url, init) {
  const started = Date.now()
  try {
    const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${KEY}`, ...(init.headers ?? {}) } })
    const text = await response.text()
    const ms = Date.now() - started
    let json = null
    try { json = JSON.parse(text) } catch {}
    const images = json?.data?.length ?? 0
    console.log(`\n[${label}]`)
    console.log(`  ${init.method ?? 'GET'} ${url.replace(BASE, '')}  →  HTTP ${response.status}  (${ms}ms)`)
    if (json?.error) console.log(`  error: ${String(json.error.message ?? JSON.stringify(json.error)).slice(0, 300)}`)
    else if (json?.message && !json?.data) console.log(`  message: ${String(json.message).slice(0, 300)}`)
    else console.log(`  body: ${text.slice(0, 220).replace(/\s+/g, ' ')}`)
    if (response.ok && images > 0) {
      console.log(`  ✅ 成功，返回 ${images} 张图（格式：${json.data[0].b64_json ? 'b64_json' : 'url'}）`)
      succeeded = label
    }
    return { ok: response.ok, status: response.status, images }
  } catch (failure) {
    console.log(`\n[${label}]\n  请求异常：${failure.message}`)
    return { ok: false }
  }
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

console.log(`中转站: ${BASE}`)
console.log('模型列表:', (settings.openaiModel ?? '(未设)'))

// A. 故意不传 model —— 端点若正常校验，应回 400 而不是 502
await call('A. generations 故意缺 model（判断端点是否正常校验）', `${BASE}/images/generations`, json({ prompt: 'x' }))

// B. 最小合法 generations
const b = await call('B. generations · gpt-image-2 · 1024x1024', `${BASE}/images/generations`,
  json({ model: 'gpt-image-2', prompt: 'a red apple on a white table', n: 1, size: '1024x1024' }))

if (!succeeded) {
  const c = await call('C. generations · gpt-image-2.5 · 1024x1024', `${BASE}/images/generations`,
    json({ model: 'gpt-image-2.5', prompt: 'a red apple on a white table', n: 1, size: '1024x1024' }))

  if (!succeeded && b.status === 502) {
    console.log('\n（502 且两次都一样 → 先隔 5 秒重试一次，判断是不是瞬时抖动）')
    await new Promise((resolve) => setTimeout(resolve, 5000))
    await call('D. generations · gpt-image-2 · 重试', `${BASE}/images/generations`,
      json({ model: 'gpt-image-2', prompt: 'a red apple on a white table', n: 1, size: '1024x1024' }))
  }

  if (!succeeded) {
    const form = new FormData()
    form.append('model', 'gpt-image-2')
    form.append('prompt', 'make the left half blue')
    form.append('n', '1')
    form.append('size', '1024x1024')
    form.append('image', new Blob([PNG_1x1], { type: 'image/png' }), 'seed.png')
    await call('E. edits · gpt-image-2 · 单图 multipart', `${BASE}/images/edits`, { method: 'POST', body: form })
  }
}

console.log(succeeded ? `\n结论：${succeeded} 可用。` : '\n结论：所有尝试都没出图，看上面的状态码判断是上游故障还是参数问题。')
