/**
 * 客户端 bundle 烟测：模拟 window.__ModuleLoader__ / react / ctx，
 * 验证「模块能加载 → apply 能注册两处界面 → Panel 能完整渲染 → 快捷按钮能开标签页」。
 *
 * 用法：node tests/client-smoke.mjs
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')
const bundle = `file://${clientPath.replaceAll('\\', '/')}`

let mod = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      mod = entry
    },
  },
}

const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
const React = {
  createElement: h,
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useEffect: () => {},
}

const seen = { slots: [], tabTypes: [], opened: [] }
const fakeCtx = {
  slots: {
    inject(key, callback) {
      seen.slots.push({ owner: key, result: callback() })
      return () => {}
    },
    register(options, component) {
      return { options, component }
    },
  },
  sidebarRightTabs: {
    register(definition) {
      seen.tabTypes.push(definition)
      return () => {}
    },
  },
  sidebarRight: {
    openTab(kind, options) {
      seen.opened.push({ kind, options })
      return {}
    },
  },
  remote: {
    commands: { async execute() { return { ok: true, value: { commandId: 'c', result: { kind: 'success', text: '{}' } } } } },
    workspaceFiles: { async readBytes() { return { ok: true, value: { data: new Uint8Array([1, 2, 3]) } } } },
  },
}

const assert = (condition, label) => {
  if (!condition) {
    console.error(`FAIL: ${label}`)
    process.exitCode = 1
    return false
  }
  console.log(`  ok  ${label}`)
  return true
}

await import(bundle)
assert(mod?.id === '@local/dsh-ai-render', '模块 id 正确')
assert(typeof mod?.factory === 'function', '导出 factory')

const plugin = mod.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
assert(Array.isArray(plugin.inject) && plugin.inject.includes('slots'), '声明 inject')
// 每个 Remote 命名空间都要单独 inject，否则访问 ctx.remote.X 会抛
// 「cannot get property "remote.X" without inject」。
assert(plugin.inject.includes('remote'), 'inject 声明了 remote')
assert(plugin.inject.includes('remote.commands'), 'inject 声明了 remote.commands')
assert(plugin.inject.includes('remote.workspaceFiles'), 'inject 声明了 remote.workspaceFiles')

plugin.apply(fakeCtx)
const tabType = seen.tabTypes[0]
assert(seen.tabTypes.length === 1 && tabType.kind === 'ai-render', '注册右栏 tab 类型')
assert(tabType.title() === 'AI 效果图', 'tab 标题')
const guide = tabType.guide?.[0]
assert(Boolean(guide) && guide.id === 'ai-render', '声明导引入口（右侧栏「+」里能列出来）')
assert(guide?.title() === 'AI 效果图' && typeof guide?.description() === 'string', '导引入口标题与说明')
assert(seen.slots.length === 2, '注册两处界面')
assert(seen.slots.some((entry) => entry.result.options.name === 'sidebar.right.pane.tab'), '注册面板主体')
assert(seen.slots.some((entry) => entry.result.options.name === 'conversation.input.right'), '注册快捷按钮')

/** 模拟 React：函数组件按 props 求值，一路展开到宿主元素。 */
const render = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { ...node, children: (node.children ?? []).map(render) }
}
const collectText = (node, out = []) => {
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (Array.isArray(node)) node.forEach((child) => collectText(child, out))
  else if (node && typeof node === 'object' && node.type !== 'style') collectText(node.children, out)
  return out
}
/** 按 className 收集元素，用来验证「图示卡片」这类结构真的渲染出来了。 */
const collectByClass = (node, className, out = []) => {
  if (Array.isArray(node)) node.forEach((child) => collectByClass(child, className, out))
  else if (node && typeof node === 'object') {
    const cls = node.props?.className ?? ''
    if (typeof cls === 'string' && cls.split(/\s+/).includes(className)) out.push(node)
    collectByClass(node.children, className, out)
  }
  return out
}

const panelEntry = seen.slots.find((entry) => entry.result.options.name === 'sidebar.right.pane.tab')
const tree = render(panelEntry.result.component({ sessionId: 'session-1' }))
const texts = collectText(tree.children)
assert(tree.props.className === 'cr-root', '面板根元素')
for (const expected of [
  'AI 效果图',
  '1 · 导入底图',
  'AI 读图出结构',
  '2 · 参考图',
  '3 · 要做什么',
  '立面 / 施工图',
  '家居 / 室内风格',
  '现代简约',
  '光影',
  '跟随风格',
  '机位',
  '原角度',
  '原高度',
  '水平角度（围绕主体左右转）',
  '垂直角度（机位高低）',
  '取景距离（远近）',
  '大白话',
  'AI 润色提示词',
  '生成效果图',
  '等待导入底图',
  '参考图（可选）',
  '历史记录',
  '即梦 Seedream',
  '通义万相',
  'OpenAI 中转',
]) {
  assert(texts.includes(expected), `面板渲染「${expected}」`)
}
assert(
  texts.some((text) => typeof text === 'string' && text.includes('出图后自动质检')),
  '面板渲染自动质检开关',
)
assert(!texts.some((text) => text.includes('cr-')), '没有漏出 CSS 类名当文案')

// 子菜单一律做成「图示卡片」：卡片必须带 SVG 示意图，不是纯文字芯片。
const cardsOf = (node) => collectByClass(node, 'cr-card')
const withSvg = (node) => cardsOf(node).filter((card) => collectByClass(card, 'cr-card-svg').length > 0)
const styleCards = collectByClass(tree, 'cr-styles')[0]
assert(Boolean(styleCards), '风格是一组卡片（cr-styles）而不是文字芯片')
assert(cardsOf(styleCards).length >= 1, `风格渲染出卡片（${cardsOf(styleCards).length} 张）`)
assert(
  withSvg(styleCards).length === cardsOf(styleCards).length,
  '每张风格卡片都带 SVG 示意图',
)
const lightingGroup = collectByClass(tree, 'cr-camgroup').filter((group) =>
  JSON.stringify(collectText(group.children)).includes('跟随风格'),
)[0]
assert(Boolean(lightingGroup), '光影是一组卡片（cr-camgroup）而不是分段控件')
assert(
  cardsOf(lightingGroup).length >= 1 && withSvg(lightingGroup).length === cardsOf(lightingGroup).length,
  '光影卡片同样每张都带 SVG 示意图',
)
const cameraCards = collectByClass(tree, 'cr-cards')[0]
assert(Boolean(cameraCards) && withSvg(cameraCards).length === cardsOf(cameraCards).length, '机位卡片也带 SVG 示意图')
assert(
  collectByClass(tree, 'cr-card-svg').length === cardsOf(tree).length,
  `所有卡片都有示意图（卡片 ${cardsOf(tree).length} 张 / 示意图 ${collectByClass(tree, 'cr-card-svg').length} 个）`,
)

// 展开设置区，确认中转站字段存在
const settingsButton = tree.children.filter((child) => child?.type === 'div' && child.props.className === 'cr-head')[0]
assert(Boolean(settingsButton), '找到标题栏')
// DSH 的插件列表用的是它自己内置的图标，不渲染插件自带的 icon.svg，
// 所以图标内联到了面板标题栏 —— 这里锁住它，避免以后又被删掉。
const logos = collectByClass(settingsButton, 'cr-logo')
assert(logos.length === 1, `标题栏里有插件图标（找到 ${logos.length} 个）`)
// h('svg', props, children) 会把数组包一层，拍平后再数
const logoKids = (logos[0]?.children ?? []).flat()
assert(logoKids.length >= 4, `插件图标画出了图形（${logoKids.length} 个图元）`)

const buttonEntry = seen.slots.find((entry) => entry.result.options.name === 'conversation.input.right')
const button = render(buttonEntry.result.component({ sessionId: 'session-1' }))
assert(button.type === 'button', '快捷按钮是 button')
button.props.onClick()
assert(seen.opened[0]?.kind === 'ai-render', '点击后打开 ai-render 标签页')

// ---------------------------------------------------------------- 示意图渲染器
//
// 面板在测试环境里拿不到真实目录，所以直接测这些纯函数：
// 每一张卡片都必须能画出「跟别人不一样」的示意图，否则卡片就退化成了文字芯片。
const icons = plugin.__test
assert(Boolean(icons), '暴露示意图渲染器供测试使用')

const { STYLE_PRESETS, DIAGRAM_TYPES, LIGHTING_PRESETS } = await import(
  `file://${path.join(here, '..', 'presets.js').replaceAll('\\', '/')}`
)
const fingerprint = (node) => JSON.stringify(node)
const svgOf = (node) => {
  const found = collectByClass(node, 'cr-card-svg')
  return found[0] ?? null
}
const shapeOf = (node) => {
  const svg = svgOf(node)
  if (!svg) return ''
  // children 里可能是嵌套数组（h('svg', props, children) 会包一层），先拍平
  const flat = []
  const walk = (list) => {
    for (const child of list ?? []) {
      if (Array.isArray(child)) walk(child)
      else if (child) flat.push(child)
    }
  }
  walk(svg.children)
  // 只看图形结构（标签 + 关键几何 + 透明度），忽略颜色，用来判断「像不像同一张图」
  return flat
    .map((child) => {
      const p = child.props ?? {}
      return [
        child.type,
        p.x ?? p.cx ?? p.d ?? p.points ?? '',
        p.y ?? p.cy ?? '',
        p.width ?? p.r ?? '',
        p.opacity ?? '',
      ].join(':')
    })
    .join('|')
}

console.log('\n== 风格卡片示意图 ==')
const styleShapes = new Set()
for (const style of STYLE_PRESETS) {
  const node = icons.stylePreview(style)
  const svg = svgOf(node)
  assert(Boolean(svg), `风格「${style.label}」画出示意图`)
  styleShapes.add(`${style.group ?? 'interior'}|${shapeOf(node)}`)
}
assert(
  STYLE_PRESETS.every((style) => svgOf(icons.stylePreview(style))),
  `全部 ${STYLE_PRESETS.length} 个风格都有示意图`,
)
// 同一组内结构相同是允许的（配色不同），但不同组必须画法不同
const groupShapes = new Set(
  ['interior', 'flat', 'axon', 'diagram', 'concept'].map((group) => {
    const sample = STYLE_PRESETS.find((style) => (style.group ?? 'interior') === group)
    return shapeOf(icons.stylePreview(sample))
  }),
)
assert(
  groupShapes.size === 5,
  `五个风格组各画各的示意图（${groupShapes.size} 种画法）`,
)
// 色卡缺失时必须按 id 派生出不同配色，否则所有风格卡片会长成同一张灰图
const swatchless = STYLE_PRESETS.filter((style) => (style.group ?? 'interior') === 'interior').slice(0, 6)
const swatchlessJson = swatchless.map((style) => JSON.stringify(icons.stylePreview(style)))
assert(
  new Set(swatchlessJson).size === swatchless.length,
  `色卡缺失时各风格示意图仍然不同（${new Set(swatchlessJson).size}/${swatchless.length}）`,
)
const swatchColors = swatchless.map((style) => {
  const flat = []
  const walk = (n) => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      if (n.props?.fill && String(n.props.fill).startsWith('#')) flat.push(n.props.fill)
      walk(n.children)
    }
  }
  walk(icons.stylePreview(style))
  return flat.join(',')
})
assert(new Set(swatchColors).size === swatchless.length, '兜底配色确实落在不同的色值上')

console.log('\n== 分析图类型示意图 ==')
const diagramShapes = new Set(DIAGRAM_TYPES.map((item) => shapeOf(icons.diagramTypeIcon(item))))
assert(
  DIAGRAM_TYPES.every((item) => svgOf(icons.diagramTypeIcon(item))),
  `全部 ${DIAGRAM_TYPES.length} 个分析图类型都有示意图`,
)
assert(
  diagramShapes.size === DIAGRAM_TYPES.length,
  `分析图类型示意图互不相同（${diagramShapes.size}/${DIAGRAM_TYPES.length}）`,
)

console.log('\n== 光影示意图 ==')
assert(
  LIGHTING_PRESETS.every((item) => svgOf(icons.lightingIcon(item))),
  `全部 ${LIGHTING_PRESETS.length} 个光影都有示意图`,
)
const lightingShapes = new Set(LIGHTING_PRESETS.map((item) => shapeOf(icons.lightingIcon(item))))
assert(
  lightingShapes.size === LIGHTING_PRESETS.length,
  `光影示意图互不相同（${lightingShapes.size}/${LIGHTING_PRESETS.length}）`,
)


console.log('\n== 「改这张」必须给反馈（改图区在结果区上方） ==')
// 用户反馈「点击改这张没反应」：状态设了，但改图区渲染在结果区上方，
// 底部点完屏幕上什么都没变。所以要滚进视野 + 底部芯片 + 提示三件套。
const clientSource = await fsp.readFile(clientPath, 'utf8')
assert(clientSource.includes('function pickForRefine'), '改这张走统一的 pickForRefine')
const pickBody = clientSource.slice(
  clientSource.indexOf('function pickForRefine'),
  clientSource.indexOf('function pickForRefine') + 900,
)
assert(pickBody.includes('setRefineFrom'), 'pickForRefine 选中了改图对象')
assert(pickBody.includes('setNote('), 'pickForRefine 给了明确提示文字')
assert(pickBody.includes('scrollIntoView'), 'pickForRefine 会把改图区滚进视野')
assert(
  (clientSource.match(/pickForRefine\(/g) ?? []).length >= 3,
  `两个「改这张」按钮都改用了 pickForRefine（引用 ${(clientSource.match(/pickForRefine\(/g) ?? []).length} 处）`,
)
assert(
  !/onClick: \(\) => \{\s*setRefineFrom\(/.test(clientSource),
  '没有残留「只设状态不反馈」的旧写法',
)
// 底部固定条上的改图象：用户视线就在那里
assert(clientSource.includes('cr-refine-chip'), '底部操作条上有改图对象芯片的样式')
assert(collectByClass(tree, 'cr-sticky').length === 1, '底部固定操作条存在（改图象挂在这里）')

console.log('\n== 按比例裁切（分数坐标 ↔ 像素比例的换算最容易错） ==')
// 竖构图底图：272×437。锁 1:1 时分数坐标里的框必须「更宽」才对，
// 因为显示区域高得多 —— 直接拿分数当像素比就会裁出长方形。
const IMG_W = 272
const IMG_H = 437
const imgAr = IMG_W / IMG_H
const pxAr = (r) => (r.w * IMG_W) / (r.h * IMG_H)
const inBounds = (r) =>
  r.x >= -1e-9 && r.y >= -1e-9 && r.w > 0 && r.h > 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9

const half = icons.cropFractionRatio(1, imgAr)
assert(Math.abs(half - 1 / imgAr) < 1e-9, `1:1 的分数比例 = 原图比例的倒数（${half.toFixed(3)}）`)
const square = icons.fitCropRect({ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, half)
assert(inBounds(square), '锁比例拖出来的框不越界')
assert(Math.abs(pxAr(square) - 1) < 0.02, `1:1 裁完真的是正方形（像素比 ${pxAr(square).toFixed(3)}）`)

// 逐个比例 × 多种拖法：像素比要对，且不能越界
const cases = [
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['2:3', 2 / 3],
  ['3:2', 3 / 2],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
]
let allOk = true
const detail = []
for (const [label, target] of cases) {
  const fr = icons.cropFractionRatio(target, imgAr)
  for (const [anchor, point] of [
    [{ x: 0.05, y: 0.05 }, { x: 0.95, y: 0.95 }],
    [{ x: 0.7, y: 0.8 }, { x: 0.1, y: 0.2 }], // 反向拖拽
    [{ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.99 }], // 极窄
    [{ x: 0.0, y: 0.0 }, { x: 1.0, y: 0.1 }],
  ]) {
    const r = icons.fitCropRect(anchor, point, fr)
    if (!inBounds(r)) {
      allOk = false
      detail.push(`${label} 越界`)
      continue
    }
    const got = pxAr(r)
    if (Math.abs(got - target) > 0.03) {
      allOk = false
      detail.push(`${label} 得到 ${got.toFixed(2)}`)
    }
  }
}
assert(allOk, `六种比例 × 四种拖法都得到正确像素比且不越界${detail.length ? `（${detail.join('；')}）` : ''}`)

// 反向拖拽时锚点应固定在起点方向
const back = icons.fitCropRect({ x: 0.8, y: 0.8 }, { x: 0.2, y: 0.2 }, icons.cropFractionRatio(1, imgAr))
assert(back.x + back.w <= 0.8 + 1e-9 && back.y + back.h <= 0.8 + 1e-9, '反向拖拽时框留在起点一侧')

// 「按比例取最大」
const maxAll = icons.fitCropAll(icons.cropFractionRatio(16 / 9, imgAr))
assert(inBounds(maxAll), '按比例取最大不越界')
assert(Math.abs(pxAr(maxAll) - 16 / 9) < 0.02, `按比例取最大得到 16:9（${pxAr(maxAll).toFixed(3)}）`)
assert(Math.abs(icons.fitCropAll(icons.cropFractionRatio(1, imgAr)).w - 1) < 0.02, '竖图取 1:1 最大时宽度应占满画面')

// 切换比例时就地重排（不越界、比例正确）
const refit = icons.refitCropRect({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, icons.cropFractionRatio(1, imgAr))
assert(inBounds(refit), '切换比例后不越界')
assert(Math.abs(pxAr(refit) - 1) < 0.02, `切换比例后像素比正确（${pxAr(refit).toFixed(3)}）`)

// 自由模式行为不变
const free = icons.fitCropRect({ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.6 }, 0)
assert(Math.abs(free.w - 0.3) < 1e-9 && Math.abs(free.h - 0.5) < 1e-9, '自由模式仍按拖拽范围给框（没被比例逻辑污染）')
assert(icons.cropFractionRatio(0, imgAr) === 0, '没选比例时返回 0（不锁）')

console.log('\n== 切走再切回来，出图任务不能丢 ==')
// 用户反馈：「切到其他界面再切回来，效果图任务就不见了」。
// 两个成因：① 面板被卸载 → useState 归零；② 刷新/换会话时结果没落盘。
assert(/keepMounted:\s*true/.test(clientSource), '标签页注册时 keepMounted: true（切走不卸载组件）')
assert(!/keepMounted:\s*false/.test(clientSource), '没有残留 keepMounted: false')
assert(clientSource.includes('function resultsCacheKey'), '有结果缓存键函数')
const cacheRefs = (clientSource.match(/resultsCacheKey\(/g) ?? []).length
assert(cacheRefs >= 3, `存入与恢复两处用同一个键（引用 ${cacheRefs} 处）`)
assert(clientSource.includes('sessionStorage.setItem'), '结果会写进 sessionStorage')
assert(clientSource.includes('sessionStorage.getItem'), '挂载时会从 sessionStorage 读回')
assert(
  /map\(\(\{ url, \.\.\.rest \}\) => rest\)/.test(clientSource),
  '缓存时剥掉预览 URL（objectURL 换页面就失效，且体积大）',
)
assert(
  clientSource.includes('await fetchImageUrl(ctx, sessionId, item)'),
  '恢复时重新取预览图（文件还在磁盘上）',
)

console.log('\n== 看大图必须能打开（不能依赖浏览器新标签） ==')
// 用户反馈「点看大图没反应」：原来是 <a target="_blank" href="blob:...">，
// 在 DSH 这种 Electron/WebView 里会被拦截。改成面板内浮层。
assert(!/target:\s*'_blank'/.test(clientSource), '没有 target=_blank 打开 blob 的写法（Electron 里点不动）')
assert(clientSource.includes('cr-viewer'), '有应用内大图浮层（cr-viewer）')
assert(clientSource.includes('setViewer({ url: item.url'), '「看大图」按钮改为打开浮层')
assert(/cr-viewer-img/.test(clientSource), '浮层里有大图元素')
assert(/setViewer\(null\)/.test(clientSource), '有关闭浮层的逻辑')

console.log('\n== 面板不能默认选一个「没配置」的通道 ==')
// 用户只配了中转站，但面板初始 provider 写死 'ark'（即梦，没 Key）——
// 一打开就点生成必然报「还没配置火山方舟 API Key」。
assert(clientSource.includes('providerTouchedRef'), '有「用户是否手动选过通道」的标记')
assert(/if \(!providerTouchedRef\.current\)/.test(clientSource), '状态回来后，用户没选过就自动切到已配置的通道')
assert(
  /const pick = order\.find\(\(id\) => configured\[id\]\)/.test(clientSource),
  '按「已配置」挑通道，而不是写死顺序',
)
assert(
  (clientSource.match(/providerTouchedRef\.current = true/g) ?? []).length >= 2,
  '手动点击 / 从历史还原都标记为「已选过」（不被自动挑选顶掉）',
)

console.log('\n== 滑动对比：指针换算与裁切（几何必须准） ==')
const bounds = { left: 100, width: 400 }
assert(icons.revealFromPointer(300, bounds) === 0.5, '正中间 → 0.5')
assert(icons.revealFromPointer(100, bounds) === 0, '最左 → 0')
assert(icons.revealFromPointer(500, bounds) === 1, '最右 → 1')
assert(icons.revealFromPointer(0, bounds) === 0, '拖到框外左侧被钳制到 0')
assert(icons.revealFromPointer(9999, bounds) === 1, '拖到框外右侧被钳制到 1')
assert(icons.revealFromPointer(200, bounds) === 0.25, '1/4 处 → 0.25')
// 坏输入不能崩，也不能给出越界值
for (const bad of [null, undefined, {}, { left: 0, width: 0 }, { left: 'x', width: 'y' }]) {
  const out = icons.revealFromPointer(123, bad)
  assert(Number.isFinite(out) && out >= 0 && out <= 1, `坏 bounds 也返回 0~1（得到 ${out}）`)
}
assert(icons.revealFromPointer(NaN, bounds) === 0.5, 'clientX 是 NaN → 回到 0.5，不崩')

assert(icons.clipInsetFor(0) === 'inset(0 100.000% 0 0)', '比例 0：原图完全裁掉')
assert(icons.clipInsetFor(1) === 'inset(0 0.000% 0 0)', '比例 1：原图完整显示')
assert(icons.clipInsetFor(0.25) === 'inset(0 75.000% 0 0)', '比例 0.25：右侧裁掉 75%')
assert(icons.clipInsetFor(0.5) === 'inset(0 50.000% 0 0)', '比例 0.5：右侧裁掉一半')
assert(icons.clipInsetFor(-3) === icons.clipInsetFor(0), '负比例被钳制到 0')
assert(icons.clipInsetFor(9) === icons.clipInsetFor(1), '超过 1 被钳制到 1')
assert(icons.clipInsetFor(NaN) === icons.clipInsetFor(0.5), 'NaN 回落到 0.5')

console.log('\n== 滑动对比：组件与接线 ==')
assert(clientSource.includes('function CompareSlider'), '有 CompareSlider 组件')
assert(/clipPath:\s*clipInsetFor\(ratio\)/.test(clientSource), '上层用 clipPath 裁切（改宽度会让对比形变）')
assert(clientSource.includes('cr-slider-before'), '有上层（原图）元素')
assert(clientSource.includes('cr-slider-line'), '有分割竖线')
assert(/onPointerDown: down/.test(clientSource) && /onPointerMove: move/.test(clientSource), '拖动由指针事件驱动')
assert(/setPointerCapture/.test(clientSource), '拖动时捕获指针（拖出组件也不断）')
assert(clientSource.includes('滑动对比'), '结果卡片上有「滑动对比」按钮')
assert(clientSource.includes('单图查看'), '再点一次可收起回单图')
assert(clientSource.includes('cr-slider-sources'), '有两种原图时可切换对比对象')
assert(clientSource.includes('cad?.previewUrl'), '底图可作为对比原图')
assert(clientSource.includes('item.compareFrom'), '上一版可作为对比原图')

console.log('\n== 「洗这张」一键洗图 ==')
// 洗图的用法就是「拿刚出的图再洗一遍」，让用户下载再上传一遍纯属折腾。
assert(clientSource.includes('async function pickForWash'), '有 pickForWash')
assert(clientSource.includes('洗这张'), '结果卡片有「洗这张」按钮')
assert(/setTaskMode\('wash'\)/.test(clientSource), '点击后自动切到洗图操作')
assert(/setStructure\(''\)/.test(clientSource), '点洗图会清掉已读出的结构说明（否则串味）')
assert(/prepareFile\(file, 'cad', false\)/.test(clientSource), '洗图不裁切、不清理，保留整幅画面')

console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED')
