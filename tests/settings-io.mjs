/**
 * 设置文件的读写行为测试。
 *
 * 覆盖这类「明明保存了却没生效」的真实场景：
 *   1. 记事本写出的 UTF-8 BOM 不能让 JSON 解析失败
 *   2. JSON 语法错必须报出来，而不是静默当成「没配置」
 *   3. 文件已损坏时拒绝写入，不能把用户手写的内容抹掉
 *
 * 用法：node tests/settings-io.mjs
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const fakeHome = path.join(here, '.fake-home')
const file = path.join(fakeHome, 'ai-render', 'settings.json')

process.env.DSH_HOME = fakeHome
await fsp.rm(fakeHome, { recursive: true, force: true })
await fsp.mkdir(path.dirname(file), { recursive: true })

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

let failures = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

const invoke = async (job, attachments = []) => {
  const result = await definition.handler({
    commandId: 't',
    agent: { id: 'settings-session' },
    rawInput: JSON.stringify(job),
    attachments,
    signal: new AbortController().signal,
  })
  return { kind: result.kind, text: result.text, json: result.kind === 'success' ? JSON.parse(result.text) : null }
}

// ---------------------------------------------------------- 1. BOM

console.log('== 1. 记事本写出的 UTF-8 BOM ==')
await fsp.writeFile(
  file,
  `\uFEFF${JSON.stringify({ openaiBaseUrl: 'https://relay.example.com/v1', openaiApiKey: 'sk-bom' }, null, 2)}\n`,
  'utf8',
)
const bomStatus = await invoke({ action: 'status' })
check(bomStatus.json?.openai?.configured === true, '带 BOM 的文件仍被正确读取')
check(bomStatus.json?.openai?.baseUrl === 'https://relay.example.com/v1', 'base URL 读到了')
check(!bomStatus.json?.settingsError, '没有误报语法错')

// ---------------------------------------------------------- 2. 语法错

console.log('\n== 2. JSON 语法错必须报出来 ==')
await fsp.writeFile(file, '{ "openaiApiKey": "sk-x", }', 'utf8')
const brokenStatus = await invoke({ action: 'status' })
check(Boolean(brokenStatus.json?.settingsError), 'status 里带出 settingsError')
check(brokenStatus.json?.openai?.configured === false, '坏文件不会被当成配置成功')

const brokenSave = await invoke({ action: 'configure', openaiApiKey: 'sk-new' })
check(brokenSave.kind === 'error', '坏文件时保存直接失败')
check(String(brokenSave.text).includes('设置文件有问题'), '失败信息指明是设置文件的问题')
const preserved = await fsp.readFile(file, 'utf8')
check(preserved.includes('sk-x'), '用户手写的内容没有被抹掉')

const brokenGenerate = await invoke({ provider: 'openai', count: 1 }, [])
check(String(brokenGenerate.text).includes('不是合法 JSON'), '出图时报的是文件语法错，而不是「还没配置 Key」')

// ---------------------------------------------------------- 3. 正常路径

console.log('\n== 3. 修好后正常保存 ==')
await fsp.writeFile(file, '{}\n', 'utf8')
const saved = await invoke({ action: 'configure', openaiBaseUrl: 'relay.example.com', openaiApiKey: 'sk-ok', openaiModel: 'gemini-2.5-flash-image' })
check(saved.kind === 'success' && saved.json?.saved === true, '保存成功')
check(saved.json?.openai?.configured === true, '保存后立刻生效')
check(saved.json?.openai?.baseUrl === 'https://relay.example.com/v1', '裸域名自动补全为 /v1 并补 https')
check(!saved.json?.settingsError, '没有 settingsError')
const written = JSON.parse(await fsp.readFile(file, 'utf8'))
check(written.openaiApiKey === 'sk-ok', '密钥确实落到了文件里')

// ---------------------------------------------------------- 4. 清除

console.log('\n== 4. 清除密钥 ==')
const cleared = await invoke({ action: 'configure', openaiApiKey: '' })
check(cleared.json?.openai?.configured === false, '空串 = 清除')
check(!('openaiApiKey' in JSON.parse(await fsp.readFile(file, 'utf8'))), '文件里不再有该键')

// ---------------------------------------------------------------- 401 要翻译成人话
//
// 用户报过「效果图生成失败：接口调用失败（HTTP 401）：The API key doesn't exist」。
// 实测确认过我们的请求格式是对的 —— 方舟**只有在读到 Key 时**才会说
// "doesn't exist"，没读到只会说 "missing or invalid"。所以这句话必须点明
// 「是 Key 本身失效」并给出下一步，而不是让用户以为插件坏了。
console.log('\n== 5. 401 鉴权错误要给出可执行的下一步 ==')
{
  const { httpErrorHint } = await import(`file://${path.join(here, '..', 'index.js').replaceAll('\\', '/')}`)

  const gone = httpErrorHint(401, "The API key doesn't exist. Request id: 021...", 'ark')
  check(/方舟/.test(gone), '说清是哪个通道（方舟）')
  check(/Key 不存在/.test(gone), '点明「这把 Key 不存在」，而不是笼统的调用失败')
  check(/重新复制/.test(gone) && /出图通道/.test(gone), '给出两个可执行动作：换 Key 或换通道')
  check(/它已经读到 Key 了/.test(gone), '说清「格式没问题」，省得用户去怀疑请求头')

  const generic = httpErrorHint(401, 'Unauthorized', 'openai')
  check(/OpenAI 兼容通道/.test(generic), '泛指 401 也带上通道名')
  check(!/不存在/.test(generic), '没读到 Key 的 401 不能误判成「Key 不存在」')

  check(httpErrorHint(500, "The API key doesn't exist", 'ark') === '', '非鉴权错误不加这段提示')
  check(httpErrorHint(429, 'rate limit', 'ark') === '', '限流不加鉴权提示')
}

await fsp.rm(fakeHome, { recursive: true, force: true })
console.log(failures === 0 ? '\nSETTINGS IO TEST PASSED' : `\nSETTINGS IO TEST FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
