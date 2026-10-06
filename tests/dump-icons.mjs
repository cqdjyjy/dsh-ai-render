/**
 * 把面板里的示意图（内联 SVG）导出成 JSON，交给 rasterize-icons.py 画成图片。
 *
 * 我（Agent）看不到真实面板，只能靠这个办法检查示意图画出来到底长什么样，
 * 否则「加了图标」这件事只验证了存在性、没验证可读性。
 *
 * 用法：node tests/dump-icons.mjs
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, 'out')
await fsp.mkdir(out, { recursive: true })

const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
const window = {
  __ModuleLoader__: { load: (definition) => (globalThis.__loaded = definition) },
  requestAnimationFrame: undefined,
}
globalThis.window = window

const bundle = `file://${path.join(here, '..', 'client.js').replaceAll('\\', '/')}`
await import(bundle)
const mod = globalThis.__loaded
const plugin = mod.factory((name) => {
  if (name === 'react') return { createElement: h, useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }), useCallback: (fn) => fn, useEffect: () => {} }
  throw new Error(`unexpected require: ${name}`)
})

const { STYLE_PRESETS, STYLE_SWATCHES, DIAGRAM_TYPES, LIGHTING_PRESETS, CAMERA_AZIMUTH, CAMERA_ELEVATION, CAMERA_DISTANCE, RATIO_PRESETS } =
  await import(`file://${path.join(here, '..', 'presets.js').replaceAll('\\', '/')}`)

// 面板里的风格来自宿主目录，色卡是宿主拼上去的；这里照做，否则导出的
// 风格卡片会退化成同一张灰图（离屏检查就失去意义了）。
const stylesWithSwatch = STYLE_PRESETS.map((style) => ({ ...style, swatch: STYLE_SWATCHES[style.id] }))

const icons = plugin.__test

/** 把元素树拍平成 {type, props} 列表，去掉嵌套数组。 */
const flatten = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((child) => flatten(child, out))
  else if (node && typeof node === 'object') {
    out.push({ type: node.type, props: node.props })
    flatten(node.children, out)
  }
  return out
}

const collect = (label, nodes) => ({
  label,
  items: nodes.map(({ name, node }) => ({ name, shapes: flatten(node).filter((n) => n.type !== 'svg') })),
})

const payload = [
  collect('出图比例', RATIO_PRESETS.map((r) => ({ name: r.label, node: icons.ratioIcon(r) }))),
  collect(
    '风格（家居 13）· 带色卡',
    stylesWithSwatch.filter((s) => (s.group ?? 'interior') === 'interior').map((s) => ({ name: s.label, node: icons.stylePreview(s) })),
  ),
  collect(
    '风格（家居 13）· 色卡缺失时的兜底',
    STYLE_PRESETS.filter((s) => (s.group ?? 'interior') === 'interior').map((s) => ({ name: s.label, node: icons.stylePreview(s) })),
  ),
  collect(
    '风格（彩平 / 轴测 / 分析图 / 概念）',
    stylesWithSwatch.filter((s) => ['flat', 'axon', 'diagram', 'concept'].includes(s.group)).map((s) => ({ name: s.label, node: icons.stylePreview(s) })),
  ),
  collect('分析图类型', DIAGRAM_TYPES.map((d) => ({ name: d.label, node: icons.diagramTypeIcon(d) }))),
  collect('光影', LIGHTING_PRESETS.map((l) => ({ name: l.label, node: icons.lightingIcon(l) }))),
  collect('机位·水平角度', CAMERA_AZIMUTH.map((c) => ({ name: c.label, node: icons.azimuthIcon(c) }))),
  collect('机位·垂直角度', CAMERA_ELEVATION.map((c) => ({ name: c.label, node: icons.elevationIcon(c) }))),
  collect('机位·取景距离', CAMERA_DISTANCE.map((c) => ({ name: c.label, node: icons.distanceIcon(c) }))),
]

const file = path.join(out, 'icons.json')
await fsp.writeFile(file, JSON.stringify(payload, null, 1), 'utf8')
console.log(`写出 ${file}（${payload.reduce((n, g) => n + g.items.length, 0)} 个示意图）`)
