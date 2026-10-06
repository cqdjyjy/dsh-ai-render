/**
 * 通用设置改写：只动你指定的键，其它键（尤其密钥）原样保留。
 * 密钥不会出现在任何输出里。
 *
 * 用法：
 *   node tests/set-model.mjs openaiModel=gpt-image-2
 *   node tests/set-model.mjs openaiModel=gpt-image-2 openaiMode=edits openaiImageField=image
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'

const pairs = process.argv.slice(2).filter((arg) => arg.includes('='))
if (pairs.length === 0) {
  console.error('用法：node tests/set-model.mjs key=value [key=value ...]')
  console.error('可用键：openaiBaseUrl openaiApiKey openaiModel openaiMode openaiImageField openaiIncludeRefs defaultProvider outputDir')
  process.exit(1)
}

const dshHome =
  process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(process.env.USERPROFILE ?? '', '.dsh')
const target = path.join(dshHome, 'ai-render', 'settings.json')

const settings = JSON.parse((await fsp.readFile(target, 'utf8')).replace(/^\uFEFF/, ''))
for (const pair of pairs) {
  const index = pair.indexOf('=')
  const key = pair.slice(0, index)
  const value = pair.slice(index + 1)
  if (key === 'openaiApiKey') {
    settings[key] = value
    console.log(`openaiApiKey → 已设置（长度 ${value.length}）`)
    continue
  }
  const before = settings[key]
  settings[key] = value
  console.log(`${key}: ${before ?? '(未设)'} → ${value}`)
}
await fsp.writeFile(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
console.log(`\n已写入 ${target}`)
console.log(`密钥仍保留（长度 ${String(settings.openaiApiKey ?? '').length}）`)
