/**
 * AI 效果图 · 浏览器端（Client half）
 *
 * 注册两处界面：
 *   1. 右侧边栏标签页「AI 效果图」——导入底图 + 参考图、设参数、出图、预览；
 *   2. 输入框工具行右侧的快捷按钮——一键打开上面的标签页。
 *
 * 与宿主端的通道全部走框架已鉴权的 Remote：
 *   ctx.remote.commands.execute(sessionId, '/cabinet-render <json>', 图片附件)
 *   ctx.remote.workspaceFiles.readBytes(sessionId, 绝对路径, {})  → Blob URL 预览
 * （两个方法的 signal 都由 Typert 传输层注入，调用方不传；返回值是 { ok, value } 信封。）
 * 因此不注册任何裸 HTTP 路由，也不往会话日志里灌图片字节。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-ai-render',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TAB_ID = '@local/dsh-ai-render'
    const TAB_KIND = 'ai-render'
    const TAB_TITLE = 'AI 效果图'
    const COMMAND = 'ai-render'
    const MAX_IMAGE_SIDE = 2048

    const PROVIDERS = [
      { id: 'gemini', label: 'Gemini', hint: '本机 agy（不用填 Key）', keyless: true },
      { id: 'ark', label: '即梦 Seedream', hint: '火山方舟' },
      { id: 'qwen', label: '通义万相', hint: '阿里云百炼' },
      { id: 'openai', label: 'OpenAI 中转', hint: '第三方中转站' },
    ]

    /**
     * 常用出图型号（可以手填别的）。
     *
     * 为什么不写死一个：方舟/百炼的型号 id 换得很勤（带日期后缀），
     * 写死迟早过期；但完全空着用户又不知道该填什么，所以给常用项 + 自由输入。
     */
    const MODEL_PRESETS = {
      ark: [
        { id: 'doubao-seedream-4-0-250828', hint: 'Seedream 4.0 · 文生图 / 图生图' },
        { id: 'doubao-seedream-3-0-t2i-250415', hint: 'Seedream 3.0 · 文生图' },
        { id: 'doubao-seededit-3-0-i2i-250628', hint: 'SeedEdit 3.0 · 图生图（按底图改）' },
      ],
      qwen: [
        { id: 'qwen-image-edit-plus', hint: '通义万相 · 图像编辑增强版' },
        { id: 'qwen-image-edit', hint: '通义万相 · 图像编辑' },
      ],
    }

    const OPENAI_MODES = [
      { id: 'auto', label: '智能', hint: '按模型名自动选：优先异步任务接口，失败再逐个试同步形态' },
      { id: 'async', label: '异步任务', hint: '/v1/images/edits/async + 轮询 /v1/images/tasks/{id}，AILink 类站的主力形态，参考图字段是 source_images' },
      { id: 'async-linkai', label: '异步(含Gemini)', hint: '/v1/linkai/images/edits/async，支持 OpenAI / Gemini / Grok 分组' },
      { id: 'edits', label: '同步多图编辑', hint: '/v1/images/edits，部分站的遗留通道' },
      { id: 'generations', label: '同步文生图', hint: '/v1/images/generations' },
      { id: 'chat', label: '对话出图', hint: '/v1/chat/completions，Gemini/即梦等图片在回复里' },
    ]

    /** 当前 provider 对应的状态块。 */
    function statusOfProvider(status, provider) {
      if (!status) return null
      // gemini 走本机 agy 的登录态，没有 Key 概念：可用性由「能不能跑起来」决定，
      // 面板这里不拦（真没装 agy 时出图会给出可操作的报错）。
      if (provider === 'gemini') return { configured: true, model: 'agy' }
      if (provider === 'qwen') return status.qwen
      if (provider === 'openai') return status.openai
      return status.ark
    }

    // ------------------------------------------------------------ 机位示意图
    //
    // 竞品的子菜单是「图示卡片」而不是文字芯片：每一项都能看出选了会得到什么。
    // 这里用内联 SVG 画示意图，不需要任何图片资源，也不依赖网络。

    const AZ = { cx: 20, cy: 17, r: 12 }

    /** 水平角度：俯视图，中间是主体，圆点是相机位置。0° 在正前方（图中下方）。 */
    function azimuthIcon(item) {
      const kids = [
        h('rect', { key: 'subject', x: 16, y: 13, width: 8, height: 8, rx: 1.5, fill: 'currentColor', opacity: 0.3 }),
      ]
      if (item.deg === null) {
        kids.push(
          h('circle', {
            key: 'ring',
            cx: AZ.cx,
            cy: AZ.cy,
            r: AZ.r,
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': 1,
            'stroke-dasharray': '2 3',
            opacity: 0.5,
          }),
        )
      } else {
        const rad = (item.deg * Math.PI) / 180
        const x = AZ.cx + Math.sin(rad) * AZ.r
        const y = AZ.cy + Math.cos(rad) * AZ.r
        kids.push(
          h('circle', {
            key: 'ring',
            cx: AZ.cx,
            cy: AZ.cy,
            r: AZ.r,
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': 1,
            opacity: 0.22,
          }),
          h('line', {
            key: 'beam',
            x1: x,
            y1: y,
            x2: AZ.cx,
            y2: AZ.cy,
            stroke: 'currentColor',
            'stroke-width': 1,
            opacity: 0.5,
          }),
          h('circle', { key: 'cam', cx: x, cy: y, r: 3.2, fill: 'currentColor' }),
        )
      }
      return h('svg', { className: 'cr-card-svg', viewBox: '0 0 40 34' }, kids)
    }

    /** 垂直角度：侧视图，地面 + 主体 + 相机位置与视线方向。 */
    function elevationIcon(item) {
      const kids = [
        h('line', { key: 'floor', x1: 3, y1: 29, x2: 37, y2: 29, stroke: 'currentColor', 'stroke-width': 1, opacity: 0.35 }),
        h('rect', { key: 'subject', x: 16, y: 9, width: 9, height: 20, rx: 1.5, fill: 'currentColor', opacity: 0.3 }),
      ]
      if (item.deg === null) {
        kids.push(
          h('line', {
            key: 'eye',
            x1: 5,
            y1: 19,
            x2: 14,
            y2: 19,
            stroke: 'currentColor',
            'stroke-width': 1,
            'stroke-dasharray': '2 2',
            opacity: 0.55,
          }),
        )
      } else {
        const rad = (item.deg * Math.PI) / 180
        const x = 18 - Math.cos(rad) * 15
        const y = 18 - Math.sin(rad) * 15
        kids.push(
          h('line', { key: 'beam', x1: x, y1: y, x2: 18, y2: 18, stroke: 'currentColor', 'stroke-width': 1, opacity: 0.5 }),
          h('circle', { key: 'cam', cx: x, cy: y, r: 3.2, fill: 'currentColor' }),
        )
      }
      return h('svg', { className: 'cr-card-svg', viewBox: '0 0 40 34' }, kids)
    }

    /** 取景距离：外框是画幅，内部方块是主体；主体越小说明取得越广。 */
    function distanceIcon(item) {
      const size = item.level === null ? 11 : item.level === 0 ? 20 : item.level === 1 ? 15 : 10
      const frame = {
        key: 'frame',
        x: 4,
        y: 6,
        width: 32,
        height: 22,
        rx: 2,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1,
        opacity: 0.4,
      }
      if (item.level === null) frame['stroke-dasharray'] = '2 2'
      return h('svg', { className: 'cr-card-svg', viewBox: '0 0 40 34' }, [
        h('rect', frame),
        h('rect', {
          key: 'subject',
          x: 20 - size / 2,
          y: 17 - size / 2,
          width: size,
          height: size,
          rx: 1.5,
          fill: 'currentColor',
          opacity: 0.3,
        }),
      ])
    }

    /** 一张图示卡片。 */
    function cameraCard(item, icon, active, onPick, disabled, keyPrefix) {
      return h(
        'button',
        {
          key: `${keyPrefix}-${item.id}`,
          className: 'cr-card',
          type: 'button',
          'data-active': active ? '1' : '0',
          title: item.hint || item.label,
          disabled,
          onClick: () => onPick(item.id),
        },
        icon,
        h('span', { className: 'cr-card-label' }, item.label),
      )
    }

    /** 一个机位维度分组（标题 + 卡片网格）。 */
    function cameraGroup(title, items, iconOf, activeId, onPick, disabled, keyPrefix) {
      return h(
        'div',
        { className: 'cr-camgroup', key: keyPrefix },
        h('div', { className: 'cr-camgroup-title' }, title),
        h(
          'div',
          { className: 'cr-cards' },
          items.map((item) => cameraCard(item, iconOf(item), activeId === item.id, onPick, disabled, keyPrefix)),
        ),
      )
    }

    // ------------------------------------------------------ 风格 / 分析图 / 光影示意图
    //
    // 同样是「图示卡片」的思路：风格卡片画出该风格配色下的迷你立面（或彩平/轴测/
    // 分析图形），分析图卡片画出五类分析图的图形语言，光影卡片画出光照方向。
    // 全部是内联 SVG，不依赖任何图片资源。

    const bigSvg = (children, key) => h('svg', { key, className: 'cr-card-svg cr-card-svg-lg', viewBox: '0 0 56 40' }, children)

    /** HSL → #rrggbb：离屏渲染工具不认识 hsl()，统一用 hex 更省事。 */
    function hslToHex(hue, sat, light) {
      const s = sat / 100
      const l = light / 100
      const c = (1 - Math.abs(2 * l - 1)) * s
      const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
      const m = l - c / 2
      const seg = Math.floor((hue % 360) / 60)
      const rgb = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x],
      ][seg] ?? [c, x, 0]
      return `#${rgb
        .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0'))
        .join('')}`
    }

    /**
     * 风格配色：优先用宿主下发的色卡。
     *
     * 色卡缺失时要按 id 派生一套稳定配色 —— 否则所有风格卡片会退化成同一张
     * 灰图，用户就分不出选哪个了（这不是假设：离屏渲染时就这样）。
     */
    function paletteOf(style) {
      if (Array.isArray(style?.swatch) && style.swatch.length >= 2) {
        return { light: style.swatch[0], dark: style.swatch[1] }
      }
      const seed = String(style?.id ?? 'x')
      let hash = 0
      for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 360
      return { light: hslToHex(hash, 32, 88), dark: hslToHex(hash, 34, 42) }
    }

    /**
     * 插件图标（与 icon.svg 同一套几何）。
     *
     * DSH 的插件清单用的是它自己内置的图标，**不渲染插件自带的 icon.svg**，
     * 所以把同一个图形内联到面板标题栏，用户才真的看得见。
     */
    function pluginIcon(key = 'plugin-icon') {
      const ink = '#5B6472'
      return h('svg', { key, className: 'cr-logo', viewBox: '0 0 32 32', 'aria-hidden': 'true' }, [
        h('rect', { key: 'frame', x: 3.5, y: 5.5, width: 25, height: 21, rx: 2.5, fill: 'none', stroke: ink, 'stroke-width': 1.6 }),
        h('path', { key: 'ground', d: 'M3.5 22.5 L28.5 22.5', stroke: ink, 'stroke-width': 1.3, opacity: 0.6 }),
        h('path', { key: 'mass1', d: 'M9 22.5 L9 13 L16 13 L16 22.5', fill: 'none', stroke: ink, 'stroke-width': 1.4 }),
        h('path', { key: 'mass2', d: 'M19 22.5 L19 16.5 L24 16.5 L24 22.5', fill: 'none', stroke: ink, 'stroke-width': 1.4, opacity: 0.8 }),
        h('path', {
          key: 'spark',
          d: 'M24.4 1.6 L25.35 3.9 L27.65 4.85 L25.35 5.8 L24.4 8.1 L23.45 5.8 L21.15 4.85 L23.45 3.9 Z',
          fill: '#C8A15A',
        }),
      ])
    }

    /** 家居风格：迷你柜体立面，用该风格的配色画门板、层板与五金。 */
    function interiorPreview(style, key) {
      const { light, dark } = paletteOf(style)
      return bigSvg(
        [
          h('rect', { key: 'bg', x: 0, y: 0, width: 56, height: 40, rx: 3, fill: light }),
          h('rect', { key: 'floor', x: 0, y: 33, width: 56, height: 7, rx: 2, fill: dark, opacity: 0.22 }),
          h('rect', { key: 'cab', x: 5, y: 4, width: 46, height: 30, rx: 2, fill: light, stroke: dark, 'stroke-width': 1.4 }),
          h('line', { key: 'div', x1: 16, y1: 4, x2: 16, y2: 34, stroke: dark, 'stroke-width': 1.2, opacity: 0.85 }),
          h('line', { key: 'sh1', x1: 16, y1: 13, x2: 51, y2: 13, stroke: dark, 'stroke-width': 1.2, opacity: 0.7 }),
          h('line', { key: 'sh2', x1: 16, y1: 22, x2: 51, y2: 22, stroke: dark, 'stroke-width': 1.2, opacity: 0.7 }),
          h('rect', { key: 'handle', x: 20, y: 28, width: 13, height: 2.4, rx: 1.2, fill: dark }),
          h('rect', { key: 'plinth', x: 5, y: 34, width: 46, height: 3, rx: 1, fill: dark, opacity: 0.6 }),
        ],
        key,
      )
    }

    /** 彩平风格：迷你平面——墙体实心、按房间铺色块。 */
    function flatPreview(style, key) {
      const { light, dark } = paletteOf(style)
      return bigSvg(
        [
          h('rect', { key: 'bg', x: 0, y: 0, width: 56, height: 40, rx: 3, fill: '#ffffff' }),
          h('rect', { key: 'wall', x: 4, y: 4, width: 48, height: 32, rx: 1, fill: 'none', stroke: dark, 'stroke-width': 2.5 }),
          h('line', { key: 'iw1', x1: 28, y1: 4, x2: 28, y2: 22, stroke: dark, 'stroke-width': 2.5 }),
          h('line', { key: 'iw2', x1: 4, y1: 24, x2: 20, y2: 24, stroke: dark, 'stroke-width': 2.5 }),
          h('rect', { key: 'r1', x: 6, y: 6, width: 20, height: 16, fill: light }),
          h('rect', { key: 'r2', x: 30, y: 6, width: 20, height: 28, fill: light, opacity: 0.72 }),
          h('rect', { key: 'r3', x: 6, y: 26, width: 20, height: 8, fill: light, opacity: 0.5 }),
          h('rect', { key: 'f1', x: 9, y: 9, width: 12, height: 4, rx: 1, fill: dark, opacity: 0.55 }),
          h('circle', { key: 'f2', cx: 40, cy: 20, r: 5, fill: 'none', stroke: dark, 'stroke-width': 1, opacity: 0.6 }),
        ],
        key,
      )
    }

    /** 轴测风格：迷你剖切轴测体块。 */
    function axonPreview(style, key) {
      const { light, dark } = paletteOf(style)
      const top = '28,6 50,14 28,22 6,14'
      const left = '6,14 28,22 28,38 6,30'
      const right = '50,14 28,22 28,38 50,30'
      return bigSvg(
        [
          h('rect', { key: 'bg', x: 0, y: 0, width: 56, height: 40, rx: 3, fill: light, opacity: 0.35 }),
          h('polygon', { key: 'top', points: top, fill: light, stroke: dark, 'stroke-width': 1 }),
          h('polygon', { key: 'left', points: left, fill: dark, opacity: 0.45, stroke: dark, 'stroke-width': 1 }),
          h('polygon', { key: 'right', points: right, fill: dark, opacity: 0.72, stroke: dark, 'stroke-width': 1 }),
        ],
        key,
      )
    }

    /** 分析图风格：色块分区 + 一条指示箭头。 */
    function diagramPreview(style, key) {
      const { light, dark } = paletteOf(style)
      return bigSvg(
        [
          h('rect', { key: 'bg', x: 0, y: 0, width: 56, height: 40, rx: 3, fill: light, opacity: 0.4 }),
          h('rect', { key: 'z1', x: 6, y: 6, width: 20, height: 13, rx: 2, fill: dark, opacity: 0.75 }),
          h('rect', { key: 'z2', x: 29, y: 6, width: 21, height: 13, rx: 2, fill: dark, opacity: 0.42 }),
          h('rect', { key: 'z3', x: 6, y: 22, width: 44, height: 12, rx: 2, fill: dark, opacity: 0.24 }),
          h('path', { key: 'arrow', d: 'M10 30 C 20 14, 34 34, 48 16', fill: 'none', stroke: dark, 'stroke-width': 1.6 }),
          h('circle', { key: 'dot', cx: 48, cy: 16, r: 2.4, fill: dark }),
        ],
        key,
      )
    }

    /** 概念/建筑风格：体块 + 地平线 + 绿植。 */
    function conceptPreview(style, key) {
      const { light, dark } = paletteOf(style)
      return bigSvg(
        [
          h('rect', { key: 'bg', x: 0, y: 0, width: 56, height: 40, rx: 3, fill: light, opacity: 0.5 }),
          h('rect', { key: 'mass', x: 8, y: 10, width: 30, height: 20, fill: dark, opacity: 0.7 }),
          h('rect', { key: 'mass2', x: 24, y: 16, width: 22, height: 14, fill: dark, opacity: 0.42 }),
          h('line', { key: 'ground', x1: 2, y1: 31, x2: 54, y2: 31, stroke: dark, 'stroke-width': 1, opacity: 0.5 }),
          h('circle', { key: 'plant', cx: 46, cy: 27, r: 4, fill: dark, opacity: 0.8 }),
        ],
        key,
      )
    }

    /** 跟随参考图 / 沿用底图：中性示意图。 */
    function neutralPreview(key) {
      return bigSvg(
        [
          h('rect', { key: 'bg', x: 0, y: 0, width: 56, height: 40, rx: 3, fill: '#f2f2f2' }),
          h('rect', {
            key: 'box',
            x: 12,
            y: 8,
            width: 32,
            height: 24,
            rx: 2,
            fill: 'none',
            stroke: '#b8b8b8',
            'stroke-width': 1,
            'stroke-dasharray': '3 3',
          }),
          h('path', { key: 'arrow', d: 'M22 26 L34 14', stroke: '#b8b8b8', 'stroke-width': 1.4, fill: 'none' }),
        ],
        key,
      )
    }

    /** 按风格组挑示意图。 */
    function stylePreview(style) {
      const key = `style-${style?.id ?? 'x'}`
      const group = style?.group ?? 'interior'
      if (group === 'none' || style?.id === 'custom') return neutralPreview(key)
      if (group === 'flat') return flatPreview(style, key)
      if (group === 'axon') return axonPreview(style, key)
      if (group === 'diagram') return diagramPreview(style, key)
      if (group === 'concept') return conceptPreview(style, key)
      return interiorPreview(style, key)
    }

    /** 出图比例示意图：按比例画一个小方框，一眼看出是横是竖。 */
    function ratioIcon(item) {
      const key = `ratio-${item?.id}`
      const box = 32
      const isFollow = !item?.w || !item?.h
      // 注意别用 h 当局部变量名 —— 会把 h（createElement）遮蔽掉
      const boxW = isFollow ? 2 : item.w
      const boxH = isFollow ? 3 : item.h
      const scale = Math.min(box / boxW, box / boxH)
      const rw = Math.max(8, Math.round(boxW * scale))
      const rh = Math.max(8, Math.round(boxH * scale))
      const x = (56 - rw) / 2
      const y = (40 - rh) / 2
      const frame = {
        key: 'frame',
        x,
        y,
        width: rw,
        height: rh,
        rx: 2,
        fill: 'currentColor',
        'fill-opacity': 0.12,
        stroke: 'currentColor',
        'stroke-width': 1.4,
      }
      if (isFollow) frame['stroke-dasharray'] = '3 3'
      const kids = [h('rect', frame)]
      if (isFollow) {
        // 跟随底图：框里画一个「自动」的箭头，跟固定比例区分开
        kids.push(
          h('path', { key: 'auto', d: `M${x + 5} ${y + rh - 5} L${x + rw - 5} ${y + 5}`, stroke: 'currentColor', 'stroke-width': 1.2, fill: 'none', opacity: 0.7 }),
        )
      }
      return bigSvg(kids, key)
    }

    /** 分析图类型示意图：五类分析图的图形语言。 */
    function diagramTypeIcon(item) {
      const key = `dg-${item?.id}`
      const ink = 'currentColor'
      const common = { fill: 'none', stroke: ink, 'stroke-width': 1 }
      if (item?.id === 'function') {
        // 功能分区：不同透明度的彩色区块
        return bigSvg(
          [
            h('rect', { key: 'a', x: 6, y: 6, width: 20, height: 13, rx: 2, fill: ink, opacity: 0.7 }),
            h('rect', { key: 'b', x: 29, y: 6, width: 21, height: 13, rx: 2, fill: ink, opacity: 0.45 }),
            h('rect', { key: 'c', x: 6, y: 22, width: 20, height: 12, rx: 2, fill: ink, opacity: 0.28 }),
            h('rect', { key: 'd', x: 29, y: 22, width: 21, height: 12, rx: 2, fill: ink, opacity: 0.55 }),
          ],
          key,
        )
      }
      if (item?.id === 'circulation') {
        // 流线：主次动线箭头
        return bigSvg(
          [
            h('path', { key: 'main', d: 'M7 32 C 18 30, 18 12, 30 12 S 44 20, 50 8', ...common, 'stroke-width': 2.6 }),
            h('path', { key: 'sub', d: 'M10 22 C 20 20, 24 24, 34 26', ...common, 'stroke-width': 1.2, opacity: 0.55 }),
            h('circle', { key: 'end', cx: 50, cy: 8, r: 2.8, fill: ink }),
            h('circle', { key: 'start', cx: 7, cy: 32, r: 2, fill: ink, opacity: 0.6 }),
          ],
          key,
        )
      }
      if (item?.id === 'planting') {
        // 植物配置：大小不同的树冠 + 地面
        const tree = (cx, cy, r, o) => [
          h('line', { key: `t${cx}`, x1: cx, y1: cy, x2: cx, y2: 33, stroke: ink, 'stroke-width': 1.2, opacity: 0.7 }),
          h('circle', { key: `c${cx}`, cx, cy, r, fill: ink, opacity: o }),
        ]
        return bigSvg(
          [
            h('line', { key: 'ground', x1: 3, y1: 33, x2: 53, y2: 33, ...common, opacity: 0.4 }),
            ...tree(15, 21, 9, 0.65),
            ...tree(30, 25, 6, 0.45),
            ...tree(43, 18, 8, 0.75),
          ],
          key,
        )
      }
      if (item?.id === 'furniture') {
        // 软装搭配：家具图形 + 材质色卡
        return bigSvg(
          [
            h('rect', { key: 'sofa', x: 6, y: 8, width: 26, height: 12, rx: 3, ...common }),
            h('line', { key: 'sofa2', x1: 6, y1: 14, x2: 32, y2: 14, ...common, opacity: 0.5 }),
            h('circle', { key: 'table', cx: 42, cy: 25, r: 6, ...common }),
            h('rect', { key: 'chip1', x: 6, y: 25, width: 8, height: 8, rx: 1.5, fill: ink, opacity: 0.7 }),
            h('rect', { key: 'chip2', x: 17, y: 25, width: 8, height: 8, rx: 1.5, fill: ink, opacity: 0.45 }),
            h('rect', { key: 'chip3', x: 28, y: 25, width: 8, height: 8, rx: 1.5, fill: ink, opacity: 0.25 }),
          ],
          key,
        )
      }
      // 体块分析（默认）
      return bigSvg(
        [
          h('rect', { key: 'b1', x: 6, y: 24, width: 44, height: 10, rx: 1.5, fill: ink, opacity: 0.35 }),
          h('rect', { key: 'b2', x: 12, y: 14, width: 30, height: 10, rx: 1.5, fill: ink, opacity: 0.6 }),
          h('rect', { key: 'b3', x: 20, y: 5, width: 18, height: 9, rx: 1.5, fill: ink, opacity: 0.85 }),
        ],
        key,
      )
    }

    /** 光影示意图：光源位置与色温。 */
    function lightingIcon(item) {
      const key = `lt-${item?.id}`
      const warm = '#e8a33d'
      const cool = '#7fa8d8'
      const glow = '#f7d08a'
      if (item?.id === 'daylight') {
        return bigSvg(
          [
            h('circle', { key: 'sun', cx: 42, cy: 10, r: 5, fill: warm }),
            h('path', { key: 'ray', d: 'M10 34 L 34 12', stroke: cool, 'stroke-width': 2, fill: 'none' }),
            h('rect', { key: 'room', x: 4, y: 30, width: 48, height: 6, rx: 2, fill: cool, opacity: 0.4 }),
          ],
          key,
        )
      }
      if (item?.id === 'dusk') {
        return bigSvg(
          [
            h('rect', { key: 'sky', x: 4, y: 4, width: 48, height: 22, rx: 2, fill: warm, opacity: 0.35 }),
            h('circle', { key: 'sun', cx: 20, cy: 22, r: 5, fill: warm }),
            h('path', { key: 'ray', d: 'M22 24 L 46 32', stroke: warm, 'stroke-width': 2, fill: 'none' }),
            h('rect', { key: 'ground', x: 4, y: 32, width: 48, height: 5, rx: 2, fill: warm, opacity: 0.5 }),
          ],
          key,
        )
      }
      if (item?.id === 'night') {
        return bigSvg(
          [
            h('rect', { key: 'dark', x: 4, y: 4, width: 48, height: 33, rx: 2, fill: '#1c2230' }),
            h('rect', { key: 'strip', x: 10, y: 14, width: 36, height: 2, rx: 1, fill: glow }),
            h('circle', { key: 'spot', cx: 42, cy: 26, r: 7, fill: glow, opacity: 0.45 }),
            h('circle', { key: 'lamp', cx: 42, cy: 26, r: 2.6, fill: glow }),
          ],
          key,
        )
      }
      if (item?.id === 'studio') {
        return bigSvg(
          [
            h('rect', { key: 'bg', x: 4, y: 4, width: 48, height: 33, rx: 2, fill: '#f4f4f4' }),
            h('rect', { key: 'softL', x: 4, y: 8, width: 6, height: 25, rx: 2, fill: '#ffffff', stroke: '#cfcfcf', 'stroke-width': 1 }),
            h('rect', { key: 'softR', x: 46, y: 8, width: 6, height: 25, rx: 2, fill: '#ffffff', stroke: '#cfcfcf', 'stroke-width': 1 }),
            h('rect', { key: 'obj', x: 22, y: 15, width: 12, height: 16, rx: 2, fill: '#d8d8d8' }),
          ],
          key,
        )
      }
      // 跟随风格（默认）：一半暖一半冷的色轮
      return bigSvg(
        [
          h('circle', { key: 'c1', cx: 28, cy: 20, r: 13, fill: warm, opacity: 0.55 }),
          h('path', { key: 'c2', d: 'M28 7 A 13 13 0 0 1 28 33 Z', fill: cool, opacity: 0.6 }),
        ],
        key,
      )
    }

    // ------------------------------------------------------------ 样式

    // 只引用 --dsw-* 主题 token，亮/暗两态自动跟随宿主。
    const CSS = `
.cr-root{display:flex;flex-direction:column;gap:14px;padding:14px 14px 28px;font-family:var(--dsw-font-family,inherit);
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;overflow-y:auto;height:100%;box-sizing:border-box}
.cr-root *{box-sizing:border-box}
.cr-head{display:flex;align-items:center;gap:8px}
.cr-head h2{margin:0;font-size:14px;font-weight:600}
.cr-logo{width:20px;height:20px;flex:0 0 auto;display:block}
.cr-refine-chip{display:inline-flex;align-items:center;gap:5px;max-width:190px;overflow:hidden;
  white-space:nowrap;text-overflow:ellipsis;font-size:11px;padding:3px 4px 3px 8px;border-radius:999px;
  background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-text-secondary);
  border:1px solid var(--dsw-alias-border-l2)}
.cr-refine-chip .cr-chip-x{border:0;background:none;cursor:pointer;color:inherit;font-size:13px;
  line-height:1;padding:0 3px;opacity:.7}
.cr-refine-chip .cr-chip-x:hover{opacity:1}
.cr-verdict{font-size:11px;padding:3px 8px;border-radius:999px;white-space:nowrap}
.cr-verdict[data-kind="ok"]{background:rgba(46,160,67,.14);color:#2ea043}
.cr-verdict[data-kind="fix"]{background:rgba(210,153,34,.16);color:#b8860b}
/* 大图浮层：不走浏览器新标签（Electron 里 target=_blank 会被拦） */
.cr-viewer{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
  padding:18px;cursor:zoom-out}
.cr-viewer-img{max-width:96vw;max-height:84vh;object-fit:contain;border-radius:6px;
  background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.5);cursor:default}
.cr-viewer-bar{display:flex;align-items:center;gap:8px;cursor:default}
.cr-viewer-name{color:#fff;font-size:12px;opacity:.85;max-width:56vw;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.cr-viewer-bar .cr-btn{background:rgba(255,255,255,.14);color:#fff;border-color:rgba(255,255,255,.25);
  text-decoration:none}
/* 滑动对比：两层严格重合，拖动竖线按比例揭示 */
.cr-slider{position:relative;width:100%;overflow:hidden;border-radius:6px;background:#111;
  cursor:ew-resize;touch-action:none;user-select:none;-webkit-user-select:none}
.cr-slider[data-dragging="1"]{cursor:grabbing}
.cr-slider-img{display:block;width:100%;height:auto}
.cr-slider-before{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.cr-slider-line{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#fff;
  box-shadow:0 0 0 1px rgba(0,0,0,.35);pointer-events:none}
.cr-slider-handle{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  width:36px;height:36px;border-radius:50%;background:#fff;color:#333;font-size:11px;
  line-height:1;display:flex;align-items:center;justify-content:center;
  box-shadow:0 2px 10px rgba(0,0,0,.4)}
.cr-slider-tag{position:absolute;top:8px;font-size:11px;line-height:1.5;padding:2px 9px;
  border-radius:999px;background:rgba(0,0,0,.55);color:#fff;pointer-events:none;
  backdrop-filter:blur(2px)}
.cr-slider-tag-left{left:8px}
.cr-slider-tag-right{right:8px}
.cr-slider-sources{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.cr-btn[data-active="1"]{border-color:var(--dsw-alias-text-brand);color:var(--dsw-alias-text-brand);
  font-weight:600}
.cr-cropratios{flex-wrap:wrap;gap:6px}
.cr-chip{padding:4px 10px;border-radius:999px;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-text-secondary)}
.cr-chip[data-active="1"]{background:var(--dsw-alias-bg-module-platform);
  border-color:var(--dsw-alias-text-brand);color:var(--dsw-alias-text-brand);font-weight:600}
.cr-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-idle-primary)}
.cr-dot[data-state="ready"]{background:var(--dsw-alias-state-success-primary)}
.cr-dot[data-state="missing"]{background:var(--dsw-alias-state-warn-primary)}
.cr-status{color:var(--dsw-alias-label-secondary);font-size:12px}
.cr-section{display:flex;flex-direction:column;gap:8px}
.cr-label{display:flex;align-items:baseline;gap:8px;font-weight:600;font-size:12.5px}
.cr-label span{font-weight:400;color:var(--dsw-alias-label-secondary)}
.cr-drop{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);
  padding:14px;display:flex;align-items:center;justify-content:center;text-align:center;cursor:pointer;
  color:var(--dsw-alias-label-secondary);min-height:88px;transition:border-color .15s,background .15s}
.cr-drop:hover,.cr-drop[data-over="1"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.cr-thumb{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);position:relative}
.cr-thumb img{display:block;width:100%;max-height:220px;object-fit:contain;background:var(--dsw-alias-bg-layer-2)}
.cr-thumb-foot{display:flex;align-items:center;gap:6px;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l1)}
.cr-thumb-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;
  color:var(--dsw-alias-label-secondary)}
.cr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:8px}
.cr-chips{display:flex;flex-wrap:wrap;gap:6px}
button.cr-chip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary);border-radius:999px;padding:4px 11px;font-size:12px;cursor:pointer;font-family:inherit}
button.cr-chip:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
button.cr-chip[data-active="1"]{background:var(--dsw-alias-brand-primary);border-color:transparent;
  color:var(--dsw-alias-label-primary-inverted,#fff);font-weight:600}
button.cr-chip:disabled{opacity:.5;cursor:default}
.cr-mini{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;position:relative;background:var(--dsw-alias-bg-layer-1)}
.cr-mini img{display:block;width:100%;height:76px;object-fit:cover}
.cr-mini button{position:absolute;top:3px;right:3px}
.cr-crop{display:flex;flex-direction:column;gap:8px}
.cr-cropstage{position:relative;display:block;line-height:0;border:1px solid var(--dsw-alias-border-l2);
  border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);cursor:crosshair;touch-action:none}
.cr-cropimg{display:block;width:100%;height:auto;user-select:none;pointer-events:none}
.cr-cropsel{position:absolute;border:2px solid var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 9999px rgba(0,0,0,.35);pointer-events:none}
.cr-check{display:flex;align-items:flex-start;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.cr-check input{margin:2px 0 0;flex:0 0 auto}
.cr-camgroup{display:flex;flex-direction:column;gap:5px}
.cr-camgroup-title{font-size:11.5px;font-weight:650;color:var(--dsw-alias-label-secondary)}
.cr-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(56px,1fr));gap:6px}
button.cr-card{display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 3px 4px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;transition:all .13s}
button.cr-card:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
button.cr-card[data-active="1"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
button.cr-card:disabled{opacity:.5;cursor:default}
.cr-card-svg{width:100%;height:26px;display:block;overflow:visible}
.cr-card-svg-lg{height:38px}
.cr-card-label{font-size:10.5px;line-height:1.25;text-align:center}
button.cr-card-lg{gap:3px;padding:5px 3px 5px}
button.cr-card-lg .cr-card-label{font-size:10.5px}
.cr-styles{display:grid;grid-template-columns:repeat(auto-fill,minmax(66px,1fr));gap:7px}
.cr-combo{display:inline-flex;align-items:center;gap:5px;border:1px dashed var(--dsw-alias-border-l2);
  border-radius:8px;padding:4px 9px;font-size:11.5px;color:var(--dsw-alias-label-primary)}
.cr-hist{display:flex;gap:9px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;
  background:var(--dsw-alias-bg-layer-2);align-items:flex-start}
.cr-hist-thumb{width:56px;height:56px;flex:0 0 auto;border-radius:7px;object-fit:cover;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.cr-hist-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.cr-hist-title{font-size:12.5px;font-weight:600}
.cr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cr-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.cr-seg button{border:0;border-radius:0;background:transparent;color:var(--dsw-alias-label-secondary);
  padding:5px 11px;font-size:12.5px;cursor:pointer;font-family:inherit}
.cr-seg button+button{border-left:1px solid var(--dsw-alias-border-l2)}
.cr-seg button[data-active="1"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted, #fff)}
.cr-seg button:disabled{opacity:.5;cursor:default}
button.cr-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 11px;font-size:12.5px;cursor:pointer;font-family:inherit}
button.cr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
button.cr-btn:disabled{opacity:.5;cursor:default}
button.cr-primary{border:1px solid transparent;background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary-inverted,#fff);border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;
  cursor:pointer;font-family:inherit}
button.cr-primary:disabled{opacity:.55;cursor:default}
button.cr-icon{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);
  color:var(--dsw-alias-label-secondary);border-radius:6px;width:20px;height:20px;line-height:1;padding:0;
  cursor:pointer;font-size:12px;font-family:inherit}
.cr-ta{width:100%;min-height:62px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:7px 9px;font-size:12.5px;
  font-family:inherit;line-height:1.5}
.cr-ta:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.cr-note{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.cr-error{border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;
  color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap;word-break:break-word}
.cr-ok{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;font-size:12px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);word-break:break-word}
.cr-result{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.cr-result img{display:block;width:100%;background:var(--dsw-alias-bg-layer-2)}
.cr-result-foot{display:flex;align-items:center;gap:8px;padding:7px 9px;border-top:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.cr-result-foot a{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px}
.cr-spin{display:inline-block;width:11px;height:11px;border:2px solid var(--dsw-alias-border-l2);
  border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:cr-spin .8s linear infinite}
@keyframes cr-spin{to{transform:rotate(360deg)}}
.cr-composer-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);
  background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:4px 9px;font-size:12px;
  cursor:pointer;font-family:inherit;white-space:nowrap}
.cr-composer-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));
  color:var(--dsw-alias-label-primary)}
`

    /**
     * 设计层：叠一套更完整的排版，不改上面的基础类名。
     * 目标是「卡片化 + 有层次 + 有反馈」，全部只用 --dsw-* 主题 token。
     */
    const CSS_DESIGN = `
.cr-root{--cr-gap:12px;gap:var(--cr-gap);padding:0 12px 132px}
.cr-head{position:sticky;top:0;z-index:6;padding:12px 2px 10px;background:var(--dsw-alias-bg-base);
  border-bottom:1px solid var(--dsw-alias-border-l1);margin:0 -12px;padding-left:14px;padding-right:14px}
.cr-head h2{font-size:14px;font-weight:650;letter-spacing:.2px}
.cr-status{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-section{padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;
  background:var(--dsw-alias-bg-layer-1);gap:9px}
.cr-label{font-weight:650;font-size:12.5px;align-items:center}
.cr-label span{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.cr-badge{flex:0 0 auto;width:18px;height:18px;border-radius:6px;display:inline-flex;align-items:center;
  justify-content:center;font-size:10.5px;font-weight:700;background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary)}
.cr-drop{flex-direction:column;gap:6px;padding:16px 12px;min-height:94px;border-radius:10px}
.cr-drop-icon{font-size:16px;opacity:.7;line-height:1}
.cr-chips{gap:6px}
button.cr-chip{gap:6px;padding:4px 11px 4px 6px;transition:all .15s}
.cr-swatch{width:15px;height:15px;border-radius:50%;flex:0 0 auto;border:1px solid rgba(0,0,0,.14)}
.cr-stages{display:flex;flex-direction:column;gap:3px}
.cr-stage{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.cr-stage[data-state="active"]{color:var(--dsw-alias-label-primary);font-weight:600}
.cr-stage[data-state="done"]{opacity:.65}
.cr-stage-mark{width:13px;text-align:center;flex:0 0 auto}
.cr-verdict{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:11px;
  font-weight:600;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.cr-verdict[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.cr-verdict[data-kind="fix"]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.cr-compare{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.cr-compare-item{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2);margin:0}
.cr-compare-item img{display:block;width:100%;height:98px;object-fit:contain}
.cr-compare-item figcaption{padding:4px 7px;font-size:11px;color:var(--dsw-alias-label-secondary);
  border-top:1px solid var(--dsw-alias-border-l1)}
.cr-result{border-radius:12px}
.cr-result-foot{background:var(--dsw-alias-bg-layer-1);padding:8px 10px}
.cr-sticky{position:sticky;bottom:0;z-index:6;display:flex;align-items:center;gap:9px;
  margin:0 -12px;padding:10px 14px 14px;background:var(--dsw-alias-bg-base);
  border-top:1px solid var(--dsw-alias-border-l1)}
button.cr-primary{padding:9px 16px;font-size:13px;font-weight:650}
button.cr-primary:hover:not(:disabled){filter:brightness(1.08)}
button.cr-btn{transition:background .15s}
button.cr-icon{width:21px;height:21px}
button.cr-icon:hover{color:var(--dsw-alias-label-primary)}
.cr-ta{transition:border-color .15s;padding:8px 10px}
.cr-ta:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.cr-ta::placeholder{opacity:.85}
.cr-check{line-height:1.45}
.cr-ok{white-space:pre-wrap}
.cr-error{background:var(--dsw-alias-bg-layer-1)}
`

    // ------------------------------------------------------------ 工具

    function readFileAsDataURL(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`))
        reader.readAsDataURL(file)
      })
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('这张图无法解码，请换一张（支持 PNG / JPG / WebP）。'))
        image.src = src
      })
    }

    /**
     * data URL → 按裁切框裁出目标区域 → 等比缩到 MAX_IMAGE_SIDE 以内
     * → 得到可直接当附件提交的 base64。
     *
     * 裁切这一步对「结构还原」的影响比任何提示词都大：
     *   - 只留底图里要出图的那一个视图，去掉图框、标题栏、其他视图、尺寸标注
     *   - 参考图只留材质/颜色区域，避免模型照抄参考图的构图
     * 所以原始 data URL 会一直留着（original），改裁切框时重新派生即可。
     */
    /**
     * CAD 图纸常见「黑底白线」，而图像模型对明暗极其敏感：黑底会把它带向
     * 深色画面，白细线也不构成「设计图」的语义。这里自动判断平均亮度，
     * 黑底就反相成白底黑线，并把线条压成纯黑、底压成纯白（两级映射保平滑）。
     *
     * 这一步实测对结构还原影响很大 —— 你给的黑底三视图 CAD 就是这样被救回来的。
     */
    function cleanCadCanvas(canvas) {
      const context = canvas.getContext('2d')
      const { width, height } = canvas
      if (!width || !height) return { inverted: false, mean: 255 }
      let image
      try {
        image = context.getImageData(0, 0, width, height)
      } catch {
        return { inverted: false, mean: 255 }
      }
      const pixels = image.data
      let sum = 0
      let count = 0
      for (let i = 0; i < pixels.length; i += 4 * 13) {
        sum += pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114
        count += 1
      }
      const mean = count ? sum / count : 255
      if (mean >= 110) return { inverted: false, mean }
      for (let i = 0; i < pixels.length; i += 4) {
        const luminance = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114
        const ink = 255 - luminance
        const value = ink < 70 ? 0 : ink > 170 ? 255 : Math.round(((ink - 70) * 255) / 100)
        pixels[i] = value
        pixels[i + 1] = value
        pixels[i + 2] = value
        pixels[i + 3] = 255
      }
      context.putImageData(image, 0, 0)
      return { inverted: true, mean }
    }

    async function prepareFromDataUrl(original, name, kind, crop, clean) {
      const image = await loadImage(original)
      const rect = crop ?? { x: 0, y: 0, w: 1, h: 1 }
      const sx = Math.max(0, Math.round(rect.x * image.naturalWidth))
      const sy = Math.max(0, Math.round(rect.y * image.naturalHeight))
      const sw = Math.max(1, Math.min(image.naturalWidth - sx, Math.round(rect.w * image.naturalWidth)))
      const sh = Math.max(1, Math.min(image.naturalHeight - sy, Math.round(rect.h * image.naturalHeight)))
      const longSide = Math.max(sw, sh)
      const scale = longSide > MAX_IMAGE_SIDE ? MAX_IMAGE_SIDE / longSide : 1
      const isCad = kind === 'cad'
      let submitted = original
      let cleaned = false
      // CAD 一律过一遍画布：既要缩到上限，也要判黑底反相。
      if (crop || scale < 1 || isCad) {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(sw * scale))
        canvas.height = Math.max(1, Math.round(sh * scale))
        const context = canvas.getContext('2d')
        context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
        if (isCad && clean !== false) cleaned = cleanCadCanvas(canvas).inverted
        // CAD 是线稿，PNG 不糊线；参考图是照片，JPEG 更省体积。
        submitted = isCad ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92)
      }
      const comma = submitted.indexOf(',')
      return {
        name,
        original,
        crop: crop ?? null,
        cleaned,
        mediaType: submitted.slice(5, submitted.indexOf(';')),
        data: submitted.slice(comma + 1),
        previewUrl: submitted,
        width: sw,
        height: sh,
      }
    }

    async function prepareFile(file, kind, clean) {
      return prepareFromDataUrl(await readFileAsDataURL(file), file.name, kind, null, clean)
    }

    /** Remote 传回来的字节可能是 Uint8Array / ArrayBuffer / 数字数组 / 数字键对象。 */
    function toBytes(value) {
      if (!value) return null
      if (value instanceof Uint8Array) return value
      if (value instanceof ArrayBuffer) return new Uint8Array(value)
      if (Array.isArray(value)) return new Uint8Array(value)
      if (typeof value === 'object') {
        if (Array.isArray(value.data)) return new Uint8Array(value.data)
        const keys = Object.keys(value)
        if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
          return new Uint8Array(keys.map((key) => value[key]))
        }
      }
      return null
    }

    /**
     * 读生成结果并转成可显示的 Blob URL。
     * wire 形状（来自 api-remotes 生成描述符）：readBytes(agentId, path, options)，
     * 第一个参数就是会话 id 字符串，signal 由传输层注入，不在这里传。
     */
    /**
     * 出图结果的会话级缓存键。
     *
     * 为什么要缓存：面板切走/刷新后会被重新挂载，useState 归零 —— 用户会看到
     * 「任务不见了」。keepMounted 能挡住切标签页，挡不住刷新页面和换会话，
     * 所以结果要落一份到 sessionStorage，挂载时再读回来。
     */
    function resultsCacheKey(sessionId) {
      return `ai-render:results:${sessionId || 'default'}`
    }

    async function fetchImageUrl(ctx, sessionId, file) {
      let lastError
      for (const target of [file.path, file.relativePath].filter(Boolean)) {
        try {
          const envelope = await ctx.remote.workspaceFiles.readBytes(sessionId, target, {})
          if (!envelope || envelope.ok !== true) {
            lastError = new Error(envelope?.error?.message ?? '读取文件失败。')
            continue
          }
          const bytes = toBytes(envelope.value?.data)
          if (bytes && bytes.length > 0) {
            return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
          }
          lastError = new Error('读到 0 字节。')
        } catch (error) {
          lastError = error
        }
      }
      throw lastError ?? new Error('读取生成结果失败。')
    }

    /** 调用宿主命令。Remote 返回 { ok, value } | { ok, error } 信封。 */
    /**
     * 把参数编码成 base64url 再塞进命令行。
     *
     * 这是踩坑换来的：原先直接 `JSON.stringify(job)` 拼进命令行，而命令行
     * 会过命令解析器（处理引号 / 反斜杠 / 空白 / 转义）。API Key 里只要出现
     * 这些字符就会被改写 —— 用户看到的现象就是「填了 Key 但没保存成功」。
     * base64url 只含 A-Za-z0-9-_，解析器不会再动它。宿主两种格式都认。
     */
    function encodeJob(job) {
      const bytes = new TextEncoder().encode(JSON.stringify(job))
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    async function callCommand(ctx, sessionId, job, attachments) {
      const envelope = await ctx.remote.commands.execute(
        sessionId,
        `/${COMMAND} ${encodeJob(job)}`,
        attachments,
      )
      if (!envelope || envelope.ok !== true) {
        throw new Error(envelope?.error?.message ?? 'Remote 调用失败（commands.execute）。')
      }
      const execution = envelope.value
      if (!execution) throw new Error('命令未注册或写法不合法（cabinet-render）。')
      const result = execution.result
      if (!result || result.kind === 'error') throw new Error(result?.text || '生成失败。')
      try {
        return JSON.parse(result.text ?? '{}')
      } catch {
        throw new Error(result.text || '生成结果无法解析。')
      }
    }

    /**
     * 拖拽框选裁切区域。rect 用 0~1 的比例表示，与图片像素无关。
     * 这是对「结构还原」影响最大的一步：
     *   只框住要出图的那个视图（去掉图框/标题栏/其他视图/尺寸标注），
     *   参考图只框材质颜色区域（避免模型照抄参考图的构图）。
     */
    /**
     * 裁切几何：纯函数，方便离线测试（坐标系换算最容易写错）。
     *
     * 拖拽发生在显示区域（分数 0~1），而比例是**像素**意义上的。
     * 显示区域宽高比 = 原图宽高比，所以：
     *   分数意义上的 w/h = 目标像素比例 ÷ 原图比例
     * 少了这一步，锁 1:1 会裁出一个长方形的像素结果。
     */
    const clamp01 = (value) => Math.min(1, Math.max(0, value))

    /** 把「目标像素比例 + 原图比例」换算成显示区域里的分数比例；0 表示不锁。 */
    function cropFractionRatio(pixelAr, imageAr) {
      if (!pixelAr || !imageAr) return 0
      return pixelAr / imageAr
    }

    /** 以 anchor 为固定角、point 为拖动角，算合法矩形（锁比例时按主方向推导另一边）。 */
    function fitCropRect(anchor, point, fracRatio) {
      const right = point.x >= anchor.x
      const down = point.y >= anchor.y
      let width = Math.abs(point.x - anchor.x)
      let height = Math.abs(point.y - anchor.y)
      if (!fracRatio) {
        return {
          x: clamp01(right ? anchor.x : anchor.x - width),
          y: clamp01(down ? anchor.y : anchor.y - height),
          w: clamp01(width),
          h: clamp01(height),
        }
      }
      if (width / Math.max(height, 1e-6) > fracRatio) height = width / fracRatio
      else width = height * fracRatio
      const maxWidth = right ? 1 - anchor.x : anchor.x
      const maxHeight = down ? 1 - anchor.y : anchor.y
      if (width > maxWidth) {
        width = maxWidth
        height = width / fracRatio
      }
      if (height > maxHeight) {
        height = maxHeight
        width = height * fracRatio
      }
      return {
        x: clamp01(right ? anchor.x : anchor.x - width),
        y: clamp01(down ? anchor.y : anchor.y - height),
        w: clamp01(width),
        h: clamp01(height),
      }
    }

    /** 能放进画面的最大目标比例矩形（居中）。不锁比例就是全图。 */
    function fitCropAll(fracRatio) {
      if (!fracRatio) return { x: 0, y: 0, w: 1, h: 1 }
      let width = 1
      let height = width / fracRatio
      if (height > 1) {
        height = 1
        width = height * fracRatio
      }
      return { x: (1 - width) / 2, y: (1 - height) / 2, w: width, h: height }
    }

    /** 切换比例时就地重排：以现有选区中心为锚，尽量不跑偏。 */
    function refitCropRect(rect, fracRatio) {
      if (!fracRatio || !rect) return rect
      const cx = rect.x + rect.w / 2
      const cy = rect.y + rect.h / 2
      let width = rect.w
      let height = width / fracRatio
      if (height > 1) {
        height = 1
        width = height * fracRatio
      }
      if (width > 1) {
        width = 1
        height = width / fracRatio
      }
      return {
        x: clamp01(Math.min(cx - width / 2, 1 - width)),
        y: clamp01(Math.min(cy - height / 2, 1 - height)),
        w: width,
        h: height,
      }
    }

    /**
     * 裁切框。
     *
     * 支持**按比例锁定**：出图尺寸是由底图长宽比决定的，所以裁切时就把比例锁好
     * 比事后拉伸有用得多 —— 裁歪了后面改不回来（只能靠出图比例去硬掰）。
     */
    // ------------------------------------------------------------ 滑动对比
    //
    // 两张图严格重合，拖动竖线按比例揭示：左侧看原图、右侧看效果图。
    // 几何部分做成纯函数，方便离线验证（越界、钳制、裁切字符串都测得到）。

    /** 指针横向位置 → 揭示比例（0~1，钳制在边界内）。 */
    function revealFromPointer(clientX, bounds) {
      if (!bounds || !(Number(bounds.width) > 0)) return 0.5
      const raw = (Number(clientX) - Number(bounds.left)) / Number(bounds.width)
      if (!Number.isFinite(raw)) return 0.5
      return Math.min(1, Math.max(0, raw))
    }

    /**
     * 上层（原图）的裁切样式：保留左侧 ratio 比例。
     *
     * 用 clip-path 而不是宽度，是为了让两层始终严丝合缝地重合 ——
     * 改宽度会把原图压扁，那样对比出来的形变是假的。
     */
    function clipInsetFor(ratio) {
      const safe = Number.isFinite(Number(ratio)) ? Number(ratio) : 0.5
      const clamped = Math.min(1, Math.max(0, safe))
      return `inset(0 ${((1 - clamped) * 100).toFixed(3)}% 0 0)`
    }

    /**
     * 滑动对比组件。
     *
     * 底层放「效果图」（整幅），上层放「原图」并按 clipInsetFor 裁掉右侧，
     * 所以竖线左边是原图、右边是效果图。拖动/点按都可以移动竖线。
     */
    function CompareSlider(props) {
      const boxRef = React.useRef(null)
      const [ratio, setRatio] = React.useState(0.5)
      const [dragging, setDragging] = React.useState(false)

      const update = (event) => {
        const element = boxRef.current
        if (!element || typeof element.getBoundingClientRect !== 'function') return
        setRatio(revealFromPointer(event.clientX, element.getBoundingClientRect()))
      }
      const down = (event) => {
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* 老浏览器不支持指针捕获也不影响拖拽 */
        }
        setDragging(true)
        update(event)
      }
      const move = (event) => {
        if (dragging) update(event)
      }
      const up = () => setDragging(false)

      return h(
        'div',
        {
          className: 'cr-slider',
          ref: boxRef,
          'data-dragging': dragging ? '1' : '0',
          onPointerDown: down,
          onPointerMove: move,
          onPointerUp: up,
          onPointerCancel: up,
        },
        h('img', { className: 'cr-slider-img', src: props.afterSrc, alt: '效果图', draggable: false }),
        h('img', {
          className: 'cr-slider-img cr-slider-before',
          src: props.beforeSrc,
          alt: '原图',
          draggable: false,
          style: { clipPath: clipInsetFor(ratio) },
        }),
        h(
          'div',
          { className: 'cr-slider-line', style: { left: `${(ratio * 100).toFixed(3)}%` } },
          h('span', { className: 'cr-slider-handle' }, '◀▶'),
        ),
        h('span', { className: 'cr-slider-tag cr-slider-tag-left' }, props.beforeLabel || '原图'),
        h('span', { className: 'cr-slider-tag cr-slider-tag-right' }, props.afterLabel || '效果图'),
      )
    }

    function CropBox(props) {
      const boxRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const rect = props.rect
      const imgW = Number(props.width) > 0 ? Number(props.width) : 0
      const imgH = Number(props.height) > 0 ? Number(props.height) : 0
      const imgAr = imgW > 0 && imgH > 0 ? imgW / imgH : 0
      const [ratioId, setRatioId] = React.useState('free')

      const options = [
        { id: 'free', label: '自由' },
        ...(imgAr ? [{ id: 'source', label: `原图 ${imgW}×${imgH}`, ar: imgAr }] : []),
        { id: '1:1', label: '1:1', ar: 1 },
        { id: '3:4', label: '3:4', ar: 3 / 4 },
        { id: '4:3', label: '4:3', ar: 4 / 3 },
        { id: '2:3', label: '2:3', ar: 2 / 3 },
        { id: '3:2', label: '3:2', ar: 3 / 2 },
        { id: '16:9', label: '16:9', ar: 16 / 9 },
        { id: '9:16', label: '9:16', ar: 9 / 16 },
      ]
      const active = options.find((item) => item.id === ratioId)
      const fracRatio = cropFractionRatio(active?.ar, imgAr)

      const toFraction = (event) => {
        const element = boxRef.current
        if (!element) return null
        const bounds = element.getBoundingClientRect()
        if (bounds.width <= 0 || bounds.height <= 0) return null
        return {
          x: clamp01((event.clientX - bounds.left) / bounds.width),
          y: clamp01((event.clientY - bounds.top) / bounds.height),
        }
      }

      const applyRatio = (nextId) => {
        setRatioId(nextId)
        const option = options.find((item) => item.id === nextId)
        const nextFrac = cropFractionRatio(option?.ar, imgAr)
        if (!nextFrac || !rect) return
        props.onChange(refitCropRect(rect, nextFrac))
      }

      const down = (event) => {
        const point = toFraction(event)
        if (!point) return
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* 老浏览器不支持指针捕获也不影响拖拽 */
        }
        dragRef.current = point
        // 锁比例时不能从 0.002 开始（会被比例放大成怪形状），给一个最小可用框
        props.onChange(
          fracRatio
            ? fitCropRect(point, {
                x: clamp01(point.x + (point.x > 0.5 ? -0.02 : 0.02)),
                y: clamp01(point.y + (point.y > 0.5 ? -0.02 : 0.02)),
              }, fracRatio)
            : { x: point.x, y: point.y, w: 0.002, h: 0.002 },
        )
      }
      const move = (event) => {
        const start = dragRef.current
        if (!start) return
        const point = toFraction(event)
        if (!point) return
        props.onChange(fitCropRect(start, point, fracRatio))
      }
      const up = () => {
        dragRef.current = null
      }

      const invalid = !rect || rect.w < 0.02 || rect.h < 0.02
      // 裁完的像素尺寸：直接给出，用户才知道这一刀下去出图比例是多少
      const pixelText =
        rect && imgW > 0
          ? `${Math.max(1, Math.round(rect.w * imgW))} × ${Math.max(1, Math.round(rect.h * imgH))}`
          : ''
      return h(
        'div',
        { className: 'cr-crop' },
        h(
          'div',
          {
            className: 'cr-cropstage',
            ref: boxRef,
            onPointerDown: down,
            onPointerMove: move,
            onPointerUp: up,
            onPointerCancel: up,
          },
          h('img', { src: props.src, className: 'cr-cropimg', alt: '裁切', draggable: false }),
          rect &&
            h('div', {
              className: 'cr-cropsel',
              style: {
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
              },
            }),
        ),
        h(
          'div',
          { className: 'cr-label', style: { marginTop: '6px' } },
          '裁切比例',
          h('span', null, pixelText ? `裁完约 ${pixelText} 像素` : '锁好比例再裁，出图长宽比就定了'),
        ),
        h(
          'div',
          { className: 'cr-row cr-cropratios' },
          options.map((item) =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'cr-chip',
                'data-active': ratioId === item.id ? '1' : '0',
                onClick: () => applyRatio(item.id),
              },
              item.label,
            ),
          ),
        ),
        h('div', { className: 'cr-note' }, props.hint),
        h(
          'div',
          { className: 'cr-row' },
          h('button', { className: 'cr-btn', onClick: () => props.onChange(fitCropAll(fracRatio)) }, fracRatio ? '按比例取最大' : '全图'),
          h('button', { className: 'cr-primary', disabled: invalid, onClick: props.onDone }, '应用裁切'),
          h('button', { className: 'cr-btn', onClick: props.onCancel }, '取消'),
        ),
      )
    }

    // ------------------------------------------------------------ 面板

    function Panel(props) {
      const sessionId = props?.sessionId ?? props?.tab?.sessionId
      const ctx = props?.ctx ?? props?.__ctx
      const [cad, setCad] = React.useState(null)
      const [refs, setRefs] = React.useState([])
      const [provider, setProvider] = React.useState('ark')
      // 用户是否手动选过通道：选过就不再自动切，免得把手动选择顶掉
      const providerTouchedRef = React.useRef(false)
      const [count, setCount] = React.useState(1)
      const [catalog, setCatalog] = React.useState(null)
      const [taskMode, setTaskMode] = React.useState('elevation')
      const [styleIds, setStyleIds] = React.useState(['modern'])
      const [lighting, setLighting] = React.useState('auto')
      const [plain, setPlain] = React.useState('')
      const [composed, setComposed] = React.useState('')
      // 润色到底是模型给的还是内置模板拼的 —— 必须让用户一眼看见，
      // 否则「每次结果都一样」时根本不知道是模型不给力还是压根没走模型。
      const [composeMeta, setComposeMeta] = React.useState(null)
      const [composing, setComposing] = React.useState(false)
      const [composeNote, setComposeNote] = React.useState('')
      const [refineFrom, setRefineFrom] = React.useState('')
      const [instruction, setInstruction] = React.useState('')
      const [cropping, setCropping] = React.useState(null)
      const [draftCrop, setDraftCrop] = React.useState(null)
      const [cleanCad, setCleanCad] = React.useState(true)
      const [structure, setStructure] = React.useState('')
      const [structureNote, setStructureNote] = React.useState('')
      const [reading, setReading] = React.useState(false)
      const [autoRead, setAutoRead] = React.useState(true)
      const [camera, setCamera] = React.useState('inherit')
      const [cameraElevation, setCameraElevation] = React.useState('inherit')
      const [cameraDistance, setCameraDistance] = React.useState('inherit')
      const [ratio, setRatio] = React.useState('follow')
      const [autoQc, setAutoQc] = React.useState(true)
      const [stages, setStages] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const [results, setResults] = React.useState([])
      /**
       * 应用内大图预览。
       *
       * 原先「看大图」是 <a target="_blank" href="blob:...">，在 DSH 这种
       * Electron/WebView 里会被拦截（用户反馈：点了没反应）。改成面板内浮层，
       * 不依赖浏览器新标签行为。
       */
      const [viewer, setViewer] = React.useState(null)
      /**
       * 滑动对比：哪一张结果正在对比（-1 = 没有），以及拿谁当「原图」。
       *   base = 底图（CAD / 线稿 / 照片）
       *   prev = 上一版效果图（质检自动修正时才有）
       */
      const [sliderIndex, setSliderIndex] = React.useState(-1)
      const [sliderSource, setSliderSource] = React.useState('base')
      // 结果落一份到 sessionStorage：面板重新挂载（刷新/换会话）后还能恢复出来。
      // 只存文件描述，不存预览 URL —— 那个是 objectURL，页面一换就失效，
      // 而且体积大（一张图几百 KB）会撑爆配额。
      React.useEffect(() => {
        if (!ctx || !sessionId || results.length === 0) return
        try {
          const compact = results.map(({ url, ...rest }) => rest)
          sessionStorage.setItem(resultsCacheKey(sessionId), JSON.stringify(compact))
        } catch {
          /* 超配额或隐私模式：放弃缓存，不影响出图本身 */
        }
      }, [ctx, sessionId, results])
      // 挂载时把上次的结果读回来，并重新取预览图
      React.useEffect(() => {
        if (!ctx || !sessionId) return undefined
        let alive = true
        let saved
        try {
          const raw = sessionStorage.getItem(resultsCacheKey(sessionId))
          if (!raw) return undefined
          saved = JSON.parse(raw)
        } catch {
          return undefined
        }
        if (!Array.isArray(saved) || saved.length === 0) return undefined
        ;(async () => {
          const restored = []
          for (const item of saved) {
            try {
              restored.push({ ...item, url: await fetchImageUrl(ctx, sessionId, item) })
            } catch {
              // 文件被删/搬走了：仍然列出这一条，只是没有缩略图
              restored.push({ ...item, url: '' })
            }
          }
          if (alive && restored.length > 0) {
            setResults(restored)
            setNote('已恢复上次的出图结果（文件仍在磁盘上）。')
          }
        })()
        return () => {
          alive = false
        }
      }, [ctx, sessionId])
      const [status, setStatus] = React.useState(null)
      const [over, setOver] = React.useState('')
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [arkKey, setArkKey] = React.useState('')
      const [qwenKey, setQwenKey] = React.useState('')
      // 各家模型的型号可以选（方舟/百炼的型号换得很勤，写死一个迟早过期）。
      const [arkModelInput, setArkModelInput] = React.useState('')
      const [qwenModelInput, setQwenModelInput] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [relayUrl, setRelayUrl] = React.useState('')
      // input_fidelity：'high' = 声明尽量保留输入图结构；'off' = 不发送该字段
      const [fidelity, setFidelity] = React.useState('high')
      const [relayKey, setRelayKey] = React.useState('')
      const [relayModel, setRelayModel] = React.useState('')
      const [relayMode, setRelayMode] = React.useState('auto')
      const [probing, setProbing] = React.useState(false)
      const [probe, setProbe] = React.useState(null)
      const runTokenRef = React.useRef(0)
      // loadHistory 定义在 run 之后（它要用 run 的内部状态无关的 ctx），
      // 用 ref 转发一下，避免在 run 的依赖数组里引用未初始化的绑定。
      const loadHistoryRef = React.useRef(null)
      const cadInput = React.useRef(null)
      const refInput = React.useRef(null)
      const plainRef = React.useRef(null)
      // 改图区在结果区「上方」：在底部点「改这张」如果不滚上去，用户会以为没反应。
      const refineRef = React.useRef(null)
      const [diagram, setDiagram] = React.useState('mass')
      const [history, setHistory] = React.useState([])
      const [historyOpen, setHistoryOpen] = React.useState(false)
      const [historyNote, setHistoryNote] = React.useState('')
      const [loadingHistory, setLoadingHistory] = React.useState(false)
      const operations = catalog?.taskModes ?? []
      // 文生图不需要底图；其余操作都要。
      const needBase = !operations.find((item) => item.id === taskMode)?.noBase
      // 风格按操作分组：平面图看彩平风格、分析图看分析图风格，不再是同一套家居风。
      const styleGroups = (catalog?.modeStyleGroups ?? {})[taskMode] ?? ['interior']
      const allStyles = catalog?.styles ?? [{ id: 'modern', label: '现代简约', hint: '', group: 'interior' }]
      const visibleStyles = allStyles.filter((item) => styleGroups.includes(item.group ?? 'interior'))
      const STYLE_GROUP_LABEL = {
        interior: '家居 / 室内风格',
        flat: '彩平风格',
        axon: '轴测风格',
        diagram: '分析图风格',
        concept: '概念风格',
      }
      const styleLabel =
        styleGroups.length === 1 ? (STYLE_GROUP_LABEL[styleGroups[0]] ?? '风格预设') : '风格预设'
      // 机位三维度：面板顶部的「当前机位」组合显示用。
      const cameraLabel = (catalog?.cameras ?? []).find((item) => item.id === camera)?.label ?? ''
      const elevationLabel =
        (catalog?.cameraElevations ?? []).find((item) => item.id === cameraElevation)?.label ?? ''
      const distanceLabel =
        (catalog?.cameraDistances ?? []).find((item) => item.id === cameraDistance)?.label ?? ''
      // 每个操作该显示哪些控件，由宿主下发（彩平图不该有光影/构图选择器）。
      const modeUi = operations.find((item) => item.id === taskMode)?.ui ?? {}
      const showLighting = modeUi.lighting !== false
      const showCamera = modeUi.camera !== false
      const showRead = modeUi.read !== false
      const showQc = modeUi.qc !== false
      // 「换视角 / 风格迁移」不选风格：材质要么沿用底图，要么完全来自参考图。
      const styleFixed = operations.find((item) => item.id === taskMode)?.styleFixed === true
      const STYLE_FIXED_NOTE = {
        'view-switch': '换视角不需要选风格——新角度的材质、颜色与家具会自动沿用底图，保证是同一个空间。',
        'style-transfer': '风格迁移的风格来自你的参考图，不需要再选风格预设。请务必上传 1 张参考图。',
      }

      /** 切换操作时，如果当前风格不属于新操作的组，自动换成该组第一个。 */
      function chooseOperation(nextMode) {
        setTaskMode(nextMode)
        const groups = (catalog?.modeStyleGroups ?? {})[nextMode] ?? ['interior']
        const allowed = (catalog?.styles ?? []).filter((item) => groups.includes(item.group ?? 'interior'))
        if (allowed.length > 0 && !allowed.some((item) => styleIds.includes(item.id))) {
          setStyleIds([allowed[0].id])
        }
      }

      /**
       * 在「大白话」的光标处插入 @提及。
       * 这样用户不用记编号：点一下 @参考图1，程序就知道他说的是哪张图。
       */
      function insertMention(token) {
        const element = plainRef.current
        if (!element) {
          setPlain((previous) => `${previous}${previous && !previous.endsWith(' ') ? ' ' : ''}${token} `)
          return
        }
        const start = typeof element.selectionStart === 'number' ? element.selectionStart : plain.length
        const end = typeof element.selectionEnd === 'number' ? element.selectionEnd : start
        const next = `${plain.slice(0, start)}${token} ${plain.slice(end)}`
        setPlain(next)
        const caret = start + token.length + 1
        const focus = () => {
          try {
            element.focus()
            element.setSelectionRange(caret, caret)
          } catch {
            /* 光标恢复失败不影响插入结果 */
          }
        }
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(focus)
        } else {
          focus()
        }
      }

      const run = React.useCallback(async (override) => {
        if (!ctx || !sessionId) {
          setError('面板还没拿到会话上下文，请重新打开这个标签页。')
          return
        }
        // 一键操作会传 override，直接把「改这张 + 指令」带进来，不必等 state 更新。
        const activeRefineFrom = override?.refineFrom ?? refineFrom
        const activeInstruction = override?.instruction ?? instruction
        if (!cad && needBase) {
          setError('请先导入底图（第 1 张）。')
          return
        }
        if (!cad && !needBase && !plain.trim()) {
          setError('文生图需要在「大白话」里写清要什么画面。')
          return
        }
        const refining = Boolean(activeRefineFrom)
        if (refining && !activeInstruction.trim()) {
          setError('迭代改图需要先写一句「想改什么」。')
          return
        }
        // 参考图是可选的：选了风格预设（非「跟随参考图」）就能出图。
        const chosenStyle = styleIds[0] ?? ''
        if (!refining && needBase && refs.length === 0 && (!chosenStyle || chosenStyle === 'custom')) {
          setError('当前是「跟随参考图」或没选风格，请再上传 1 张参考图，或改选一个风格预设。')
          return
        }
        // 多选风格 = 多方案：逐个出图（异步接口一个任务只出一张）。
        const stylesToRun = refining ? [styleIds[0] ?? 'modern'] : styleIds.length > 0 ? styleIds : ['custom']
        setError('')
        setResults((previous) => {
          previous.forEach((item) => item.url && URL.revokeObjectURL(item.url))
          return []
        })
        setBusy(true)
        const token = runTokenRef.current + 1
        runTokenRef.current = token
        try {
          const attachments = [cad, ...refs].map((item) => ({
            type: 'image',
            mediaType: item.mediaType,
            data: item.data,
            name: item.name,
          }))
          const collected = []
          const notes = []
          for (const [index, styleId] of stylesToRun.entries()) {
            const styleLabel = catalog?.styles?.find((item) => item.id === styleId)?.label ?? styleId
            setNote(
              stylesToRun.length > 1
                ? `正在出第 ${index + 1}/${stylesToRun.length} 张（${styleLabel}），通常 40~90 秒…`
                : refining
                  ? '正在按你的意见改这张图，通常 40~90 秒…'
                  : '正在出图，通常 40~90 秒…',
            )
            const job = {
              provider,
              count,
              stylePreset: styleId,
              taskMode,
              lighting,
              camera,
              cameraElevation,
              cameraDistance,
              ratio,
              diagram,
              plain,
              promptOverride: composed,
              structure,
              autoQc,
            }
            if (refining) {
              job.instruction = activeInstruction
              job.refineFrom = activeRefineFrom
            }
            setStages(
              autoQc && !refining
                ? [
                    { label: '生成效果图', state: 'active' },
                    { label: '视觉质检', state: 'idle' },
                    { label: '必要时自动重出', state: 'idle' },
                  ]
                : [{ label: refining ? '按修改意见重绘' : '生成效果图', state: 'active' }],
            )
            const payload = await callCommand(ctx, sessionId, job, attachments)
            if (runTokenRef.current !== token) return
            setStages([
              { label: '生成效果图', state: 'done' },
              ...(payload.qc
                ? [
                    {
                      label:
                        payload.qc.verdict === 'ok'
                          ? '视觉质检：结构通过'
                          : payload.qc.verdict === 'need-fix'
                            ? '视觉质检：发现结构差异'
                            : `视觉质检：${payload.qc.verdict ?? '未执行'}`,
                      state: 'done',
                    },
                  ]
                : []),
              ...(payload.autoFixed ? [{ label: '已按质检意见自动重出', state: 'done' }] : []),
            ])
            /** 质检结论映射成结果卡上的小徽标；无结论就不显示。 */
            const qcBadgeOf = (payload) => {
              const verdict = payload?.qc?.verdict
              if (verdict === 'ok') return 'ok'
              if (verdict === 'need-fix') return payload.autoFixed ? 'fixed' : 'fix'
              return ''
            }
            let compareFromUrl
            if (payload.autoFixed && Array.isArray(payload.firstFiles) && payload.firstFiles[0]) {
              try {
                compareFromUrl = await fetchImageUrl(ctx, sessionId, payload.firstFiles[0])
              } catch {
                compareFromUrl = undefined
              }
            }
            for (const file of payload.files ?? []) {
              try {
                const url = await fetchImageUrl(ctx, sessionId, file)
                collected.push({
                  ...file,
                  url,
                  styleLabel,
                  refined: Boolean(payload.refined),
                  qcVerdict: qcBadgeOf(payload),
                  compareFrom: compareFromUrl,
                })
              } catch (readError) {
                collected.push({ ...file, url: '', styleLabel, readError: String(readError?.message ?? readError) })
              }
            }
            setResults([...collected])
            const modeLabel = payload.modeUsed
              ? ` · ${OPENAI_MODES.find((item) => item.id === payload.modeUsed)?.label ?? payload.modeUsed}`
              : ''
            notes.push(
              `${styleLabel}: ${payload.providerLabel ?? payload.provider} · ${payload.model}${modeLabel} · ` +
                `${payload.size} · ${((payload.elapsedMs ?? 0) / 1000).toFixed(1)}s`,
            )
            // 比例被模型归过档时如实说明，别让用户以为设置没生效。
            if (payload.sizeNotice) notes.push(`⚠ ${payload.sizeNotice}`)
            setNote(notes.join('\n'))
          }
          // 出完图刷新历史（只在历史面板展开时读，避免白白读几十兆缩略图）。
          if (historyOpen) loadHistoryRef.current?.()
          if (refining) {
            setRefineFrom('')
            setInstruction('')
          }
        } catch (failure) {
          if (runTokenRef.current !== token) return
          setError(String(failure?.message ?? failure))
          setNote('')
        } finally {
          if (runTokenRef.current === token) setBusy(false)
        }
      }, [
        ctx,
        sessionId,
        cad,
        refs,
        provider,
        count,
        plain,
        composed,
        structure,
        taskMode,
        styleIds,
        lighting,
        camera,
        cameraElevation,
        cameraDistance,
        ratio,
        autoQc,
        catalog,
        refineFrom,
        instruction,
        diagram,
        needBase,
        historyOpen,
      ])

      /**
       * 结果上的一键操作（换光/换氛围/换材质/换视角/清杂物）。
       * 直接把「改这张 + 指令」带进 run，不必让用户先填表单。
       */
      function runQuick(action, item) {
        if (!item?.path || !action?.instruction) return
        setRefineFrom(item.path)
        setInstruction(action.instruction)
        run({ refineFrom: item.path, instruction: action.instruction })
      }

      /**
       * 选一张结果作为「改图对象」。
       *
       * 改图区渲染在结果区**上方**，所以在底部点了按钮如果不把视线带上去，
       * 界面看起来毫无变化（反馈：「点击改这张没反应」）。这里同时做三件事：
       * 填状态、给一句明确的提示、把改图区滚进视野。
       */
      function pickForRefine(filePath) {
        // 路径缺失时绝不静默 return —— 那正是「点了没反应」的另一种成因。
        if (!filePath) {
          setError('这张结果的文件路径找不到了（可能已被移动或删除），请重新生成后再改图。')
          return
        }
        setRefineFrom(filePath)
        setInstruction('')
        setError('')
        setNote(`已选中改图对象：${String(filePath).split(/[\\/]/).pop()}。请在上方「迭代改图」里写清楚要改什么，再点「应用修改」。`)
        // 面板自己的滚动容器：用 rAF 等这一帧渲染完再滚
        const scroll = () => {
          const node = refineRef.current
          if (node && typeof node.scrollIntoView === 'function') {
            node.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scroll)
        else scroll()
      }

      /**
       * 读历史记录。历史 JSON 只存参数与文件路径，缩略图按需从磁盘读回来，
       * 避免把历史文件撑大，也避免一次性占住几十兆内存。
       */
      const loadHistory = React.useCallback(
        async (limit = 12) => {
          if (!ctx || !sessionId) return
          setLoadingHistory(true)
          setHistoryNote('')
          try {
            const data = await callCommand(ctx, sessionId, { action: 'history', limit })
            const rows = []
            for (const record of data.records ?? []) {
              const first = Array.isArray(record.files) ? record.files[0] : ''
              let url = ''
              if (first) {
                try {
                  url = await fetchImageUrl(ctx, sessionId, { path: first })
                } catch {
                  url = ''
                }
              }
              rows.push({ ...record, url })
            }
            setHistory(rows)
            if (data.error) setHistoryNote(data.error)
            else if (rows.length === 0) setHistoryNote('还没有历史记录。出图后会自动记下这一次的参数。')
          } catch (failure) {
            setHistoryNote(String(failure?.message ?? failure))
          } finally {
            setLoadingHistory(false)
          }
        },
        [ctx, sessionId],
      )
      loadHistoryRef.current = loadHistory

      /** 把一条历史记录的参数整套还原到面板上，改完就能再来一张。 */
      function restoreParams(record) {
        if (!record) return
        if (record.provider) {
          // 从历史还原也算用户的明确选择，别再被自动挑选顶掉
          providerTouchedRef.current = true
          setProvider(record.provider)
        }
        if (record.taskMode) setTaskMode(record.taskMode)
        if (record.stylePreset) setStyleIds([record.stylePreset])
        if (record.lighting) setLighting(record.lighting)
        if (record.camera) setCamera(record.camera)
        if (record.diagram) setDiagram(record.diagram)
        if (record.ratio) setRatio(record.ratio)
        setStructure(typeof record.structure === 'string' ? record.structure : '')
        setPlain(typeof record.plain === 'string' ? record.plain : '')
        setComposed(typeof record.promptOverride === 'string' ? record.promptOverride : '')
        setRefineFrom('')
        setInstruction('')
        setNote(`已还原这张图的参数（${record.taskModeLabel ?? ''} · ${record.styleLabel ?? ''}）。改完直接点生成即可。`)
      }

      /**
       * 让多模态模型读 CAD 出结构清单。
       *
       * 这是「读懂图纸」的正解：图片模型只会模仿像素，而视觉模型能数门板、
       * 读分格；清单注进提示词后，出图就从「看着像」变成「照规格画」。
       * 用的是会话当前的默认模型（deepseek-flash 声明了 image 模态），
       * **不需要额外开 Key**。
       */
      const readCad = React.useCallback(
        async (target) => {
          const source = target ?? cad
          if (!ctx || !sessionId || !source) return
          setReading(true)
          setError('')
          setStructureNote('正在读图…')
          try {
            const info = await callCommand(ctx, sessionId, { action: 'read' }, [
              { type: 'image', mediaType: source.mediaType, data: source.data, name: source.name },
            ])
            setStructure(info.structure ?? '')
            setStructureNote(
              `已由 ${info.by ?? '模型'} 读出图纸规格（结构、材质颜色、五金；可直接在上面修改）。生成时会作为硬约束逐条注入提示词，**图纸写了什么就用什么**，风格预设只在图纸没写明处兜底。`,
            )
          } catch (failure) {
            setStructureNote('')
            setError(String(failure?.message ?? failure))
          } finally {
            setReading(false)
          }
        },
        [ctx, sessionId, cad],
      )

      /** 大白话 → 专业话术（调宿主的 llm 润色，失败会退回内置模板）。 */
      const polish = React.useCallback(async () => {
        if (!ctx || !sessionId) return
        if (!plain.trim()) {
          setError('先把你想说的写进「大白话」框里。')
          return
        }
        setComposing(true)
        setError('')
        setComposeNote('正在润色…')
        try {
          const info = await callCommand(ctx, sessionId, {
            action: 'compose',
            plain,
            taskMode,
            stylePreset: styleIds[0] ?? 'modern',
            lighting,
            referenceCount: refs.length,
          }, [])
          setComposed(info.prompt ?? '')
          setComposeMeta({ rewritten: Boolean(info.rewritten), by: info.by, reason: info.reason })
          setComposeNote(
            info.rewritten
              ? `已保留「基础框架」（结构 / 材质 / 光影 / 画质，保证出图效果），并由 ${info.by ?? '模型'} 把你的大白话整理成末尾的【本次要求】（保证符合你的要求），可直接编辑。`
              : `基础框架已保留，但没能润色（${info.reason ?? '未知原因'}）——已把你的原话直接附在末尾的【本次要求】里，要求不会丢。`,
          )
        } catch (failure) {
          setComposeNote('')
          setError(String(failure?.message ?? failure))
        } finally {
          setComposing(false)
        }
      }, [ctx, sessionId, plain, taskMode, styleIds, lighting, refs])

      // 挂载时问一次宿主：密钥状态 + 预设目录（预设的单一数据源在 presets.js）。
      React.useEffect(() => {
        if (!ctx || !sessionId) return undefined
        let alive = true
        callCommand(ctx, sessionId, { action: 'status' }, [])
          .then((info) => {
            if (!alive) return
            setStatus(info)
            // 把当前生效的型号回填到输入框（用户可能想换个型号）
            setArkModelInput(info.ark?.model ?? '')
            setQwenModelInput(info.qwen?.model ?? '')
            setRelayUrl(info.openai?.baseUrl ?? '')
            setRelayModel(info.openai?.model ?? '')
            setRelayMode(info.openai?.mode ?? 'auto')
            setFidelity(String(info.openai?.inputFidelity ?? '').trim() || 'high')

            // 面板初始 provider 写死是 'ark'，但用户常常只配了别家 ——
            // 那样一打开就选着「未配置」的通道，点生成必然报「还没配置…API Key」。
            // 所以状态回来时，只要用户还没手动选过，就自动切到第一个已配置的通道。
            if (!providerTouchedRef.current) {
              const configured = {
                openai: Boolean(info.openai?.configured),
                qwen: Boolean(info.qwen?.configured),
                ark: Boolean(info.ark?.configured),
              }
              const order = [info.defaultProvider, 'openai', 'qwen', 'ark'].filter(Boolean)
              const pick = order.find((id) => configured[id])
              if (pick) setProvider(pick)
            }
          })
          .catch(() => {})
        callCommand(ctx, sessionId, { action: 'presets' }, [])
          .then((info) => {
            if (!alive || !info?.styles) return
            setCatalog(info)
            if (!info.styles.some((item) => item.id === 'modern')) setStyleIds([info.styles[0]?.id ?? 'custom'])
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [ctx, sessionId])

      /** patch 里只放要改的键：缺省 = 不修改，空串 = 清除。 */
      const saveKeys = React.useCallback(
        async (patch) => {
          if (!ctx || !sessionId) return
          setSaving(true)
          setError('')
          try {
            const info = await callCommand(ctx, sessionId, { action: 'configure', ...patch }, [])
            setStatus(info)
            // 保存后必须说清楚「哪个通道现在能用」——否则用户填了 Key 却不知道
            // 到底存没存进去、为什么出图还报未配置（反馈过「填了实际没生效」）。
            const ready = [
              info.ark?.configured ? '火山方舟' : '',
              info.qwen?.configured ? '通义万相' : '',
              info.openai?.configured ? '中转站' : '',
            ].filter(Boolean)
            setNote(
              info.saved
                ? `已保存。当前可用通道：${ready.length > 0 ? ready.join(' / ') : '（无 —— 请确认 Key 已粘贴到输入框再点保存）'}`
                : '',
            )
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            setSaving(false)
          }
        },
        [ctx, sessionId],
      )

      /** 探测中转站：用面板里当前填的值（哪怕还没保存）去 GET /v1/models。 */
      const probeRelay = React.useCallback(async () => {
        if (!ctx || !sessionId) return
        setProbing(true)
        setError('')
        setProbe(null)
        try {
          const info = await callCommand(ctx, sessionId, {
            action: 'probe',
            openaiBaseUrl: relayUrl.trim() || undefined,
            openaiApiKey: relayKey.trim() || undefined,
            openaiModel: relayModel.trim() || undefined,
          }, [])
          setProbe(info)
          if (!relayModel.trim() && info.imageLike?.length > 0) setRelayModel(info.imageLike[0])
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setProbing(false)
        }
      }, [ctx, sessionId, relayUrl, relayKey, relayModel])

      React.useEffect(
        () => () => {
          results.forEach((item) => item.url && URL.revokeObjectURL(item.url))
        },
        [results],
      )

      async function takeFiles(fileList, kind) {
        setError('')
        const files = Array.from(fileList ?? []).filter((file) => file.type.startsWith('image/'))
        if (files.length === 0) {
          setError('只支持图片文件（PNG / JPG / WebP）。')
          return
        }
        try {
          if (kind === 'cad') {
            const prepared = await prepareFile(files[0], 'cad', cleanCad)
            setCad(prepared)
            setStructure('')
            setStructureNote('')
            // 上传后自动读一次结构：这一步决定出图像不像图纸。
            if (autoRead) readCad(prepared)
          } else {
            const prepared = []
            for (const file of files.slice(0, 2)) prepared.push(await prepareFile(file, 'ref'))
            setRefs((previous) => [...previous, ...prepared].slice(0, 2))
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      /** 打开裁切编辑器；已有裁切框就沿用。 */
      function startCrop(kind, index) {
        const target = kind === 'cad' ? cad : refs[index]
        if (!target) return
        setCropping({ kind, index })
        setDraftCrop(target.crop ?? { x: 0, y: 0, w: 1, h: 1 })
        setError('')
      }

      /** 应用裁切：从原始图重新派生，不损失画质。 */
      async function applyCrop() {
        if (!cropping || !draftCrop) return
        try {
          if (cropping.kind === 'cad' && cad) {
            setCad(await prepareFromDataUrl(cad.original, cad.name, 'cad', draftCrop, cleanCad))
          } else if (cropping.kind === 'ref') {
            const target = refs[cropping.index]
            if (target) {
              const next = await prepareFromDataUrl(target.original, target.name, 'ref', draftCrop)
              setRefs((previous) => previous.map((item, index) => (index === cropping.index ? next : item)))
            }
          }
          setCropping(null)
          setDraftCrop(null)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      /** 切换「黑底转白底」后立刻把已有 CAD 重新派生一遍。 */
      async function toggleCleanCad(next) {
        setCleanCad(next)
        if (!cad) return
        try {
          setCad(await prepareFromDataUrl(cad.original, cad.name, 'cad', cad.crop, next))
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      const active = statusOfProvider(status, provider)
      const configured = status ? active?.configured : null
      const dotState = configured === true ? 'ready' : configured === false ? 'missing' : ''

      const dropZone = (kind, label) =>
        h(
          'div',
          {
            className: 'cr-drop',
            'data-over': over === kind ? '1' : '0',
            role: 'button',
            tabIndex: 0,
            onClick: () => (kind === 'cad' ? cadInput.current : refInput.current)?.click(),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') (kind === 'cad' ? cadInput.current : refInput.current)?.click()
            },
            onDragOver: (event) => {
              event.preventDefault()
              setOver(kind)
            },
            onDragLeave: () => setOver(''),
            onDrop: (event) => {
              event.preventDefault()
              setOver('')
              takeFiles(event.dataTransfer?.files, kind)
            },
          },
          label,
        )

      return h(
        'div',
        { className: 'cr-root' },
        h('style', null, CSS + CSS_DESIGN),
        h(
          'div',
          { className: 'cr-head' },
          pluginIcon(),
          h('h2', null, TAB_TITLE),
          h('span', { className: 'cr-dot', 'data-state': dotState, title: 'API Key 状态' }),
          h(
            'span',
            { className: 'cr-status' },
            status
              ? configured
                ? `${active?.model ?? ''}`
                : `${PROVIDERS.find((item) => item.id === provider)?.hint} 未配置`
              : '读取配置中…',
          ),
          h('span', { style: { flex: '1 1 auto' } }),          h(
            'button',
            {
              className: 'cr-btn',
              onClick: () => setSettingsOpen((previous) => !previous),
              title: '配置 API Key 与出图目录',
            },
            settingsOpen ? '收起设置' : '设置',
          ),
        ),

        // 一句能力说明：让「通用效果图工具」的定位一眼可见，
        // 不然用户会以为只能出柜体图。
        h(
          'div',
          { className: 'cr-note' },
          '导入底图（立面施工图 / 手绘线稿 / 模型截图 / 实拍照片 / 平面图）+ 参考图，按参考图的材质、颜色与风格出写实效果图。',
        ),

        // 设置文件坏了要说清楚，否则用户只会看到「保存了却没生效」。
        status?.settingsError && h('div', { className: 'cr-error' }, status.settingsError),

        // 设置：密钥直接存到宿主设置文件，不写进会话日志。
        settingsOpen &&
          h(
            'div',
            { className: 'cr-section' },
            h('div', { className: 'cr-label' }, 'API Key', h('span', null, '用哪家就配哪家；只存在本机')),
            h('input', {
              className: 'cr-ta',
              style: { minHeight: 'auto', padding: '7px 9px' },
              type: 'password',
              autoComplete: 'off',
              placeholder: status?.ark?.configured ? '火山方舟 Key 已配置，留空表示不修改' : '粘贴火山方舟 API Key（即梦 Seedream）',
              value: arkKey,
              onChange: (event) => setArkKey(event.target.value),
            }),
            h('input', {
              className: 'cr-ta',
              style: { minHeight: 'auto', padding: '7px 9px' },
              type: 'password',
              autoComplete: 'off',
              placeholder: status?.qwen?.configured ? '百炼 Key 已配置，留空表示不修改' : '粘贴阿里云百炼 DashScope API Key（通义万相）',
              value: qwenKey,
              onChange: (event) => setQwenKey(event.target.value),
            }),
            // 模型：可手填，也可点常用型号
            ['ark', 'qwen'].map((id) => {
              const value = id === 'ark' ? arkModelInput : qwenModelInput
              const setValue = id === 'ark' ? setArkModelInput : setQwenModelInput
              const current = id === 'ark' ? status?.ark?.model : status?.qwen?.model
              return h(
                'div',
                { className: 'cr-slider-sources', key: `model-${id}`, style: { marginTop: '4px' } },
                h('span', { className: 'cr-note' }, id === 'ark' ? '方舟模型' : '百炼模型'),
                h('input', {
                  className: 'cr-ta',
                  style: { minHeight: 'auto', padding: '7px 9px', flex: '1 1 200px' },
                  type: 'text',
                  autoComplete: 'off',
                  placeholder: '模型 id（留空 = 用默认）',
                  value,
                  onChange: (event) => setValue(event.target.value),
                }),
                ...(MODEL_PRESETS[id] ?? []).map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      className: 'cr-chip',
                      type: 'button',
                      title: item.hint,
                      'data-active': (value || current) === item.id ? '1' : '0',
                      onClick: () => setValue(item.id),
                    },
                    (item.hint.split('·')[0] ?? item.id).trim(),
                  ),
                ),
              )
            }),

            // 第三方中转站（OpenAI 兼容）
            h('div', { className: 'cr-label', style: { marginTop: '6px' } }, 'OpenAI 兼容中转站'),
            h('input', {
              className: 'cr-ta',
              style: { minHeight: 'auto', padding: '7px 9px' },
              type: 'text',
              autoComplete: 'off',
              placeholder: 'base URL，例如 https://your-relay.com/v1',
              value: relayUrl,
              onChange: (event) => setRelayUrl(event.target.value),
            }),
            h('input', {
              className: 'cr-ta',
              style: { minHeight: 'auto', padding: '7px 9px' },
              type: 'password',
              autoComplete: 'off',
              placeholder: status?.openai?.configured ? '中转站 Key 已配置，留空表示不修改' : '粘贴中转站的 API Key（sk-...）',
              value: relayKey,
              onChange: (event) => setRelayKey(event.target.value),
            }),
            h(
              'div',
              { className: 'cr-row' },
              h('input', {
                className: 'cr-ta',
                style: { minHeight: 'auto', padding: '7px 9px', flex: '1 1 160px' },
                type: 'text',
                autoComplete: 'off',
                placeholder: '模型名，例如 gpt-image-1 / gemini-2.5-flash-image',
                value: relayModel,
                onChange: (event) => setRelayModel(event.target.value),
              }),
              h(
                'button',
                {
                  className: 'cr-btn',
                  disabled: probing,
                  onClick: probeRelay,
                  title: '用当前填的地址与 Key 调 GET /v1/models',
                },
                probing ? '探测中…' : '探测模型',
              ),
            ),
            h(
              'div',
              { className: 'cr-row' },
              h('span', { className: 'cr-note' }, '接口形态'),
              h(
                'div',
                { className: 'cr-seg' },
                OPENAI_MODES.map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      'data-active': relayMode === item.id ? '1' : '0',
                      title: item.hint,
                      onClick: () => setRelayMode(item.id),
                    },
                    item.label,
                  ),
                ),
              ),
            ),
            probe &&
              h(
                'div',
                { className: 'cr-ok' },
                `共 ${probe.total} 个模型；像图像模型的 ${probe.imageLike?.length ?? 0} 个：`,
                h(
                  'div',
                  { className: 'cr-row', style: { marginTop: '6px' } },
                  (probe.imageLike ?? []).slice(0, 24).map((id) =>
                    h(
                      'button',
                      {
                        key: id,
                        className: 'cr-btn',
                        title: '点一下填进模型名',
                        onClick: () => setRelayModel(id),
                      },
                      id,
                    ),
                  ),
                ),
              ),

            h(
              'div',
              { className: 'cr-row' },
              h(
                'button',
                {
                  className: 'cr-btn',
                  disabled:
                    saving || (!arkKey.trim() && !qwenKey.trim() && !relayKey.trim() && !relayUrl.trim() && !relayModel.trim() && !probe),
                  onClick: async () => {
                    const patch = {}
                    if (arkKey.trim()) patch.arkApiKey = arkKey.trim()
                    if (qwenKey.trim()) patch.dashscopeApiKey = qwenKey.trim()
                    if (relayKey.trim()) patch.openaiApiKey = relayKey.trim()
                    if (relayUrl.trim()) patch.openaiBaseUrl = relayUrl.trim()
                    if (relayModel.trim()) patch.openaiModel = relayModel.trim()
                    if (arkModelInput.trim()) patch.arkModel = arkModelInput.trim()
                    if (qwenModelInput.trim()) patch.dashscopeModel = qwenModelInput.trim()
                    patch.openaiMode = relayMode
                    await saveKeys(patch)
                    setArkKey('')
                    setQwenKey('')
                    setRelayKey('')
                  },
                },
                saving ? '保存中…' : '保存配置',
              ),
              (status?.ark?.configured || status?.qwen?.configured || status?.openai?.configured) &&
                h(
                  'button',
                  {
                    className: 'cr-btn',
                    disabled: saving,
                    onClick: () => saveKeys({ arkApiKey: '', dashscopeApiKey: '', openaiApiKey: '' }),
                  },
                  '清除全部密钥',
                ),
              h('span', { className: 'cr-note' }, status?.settingsFile ?? ''),
            ),
            // input_fidelity 是压住「结构被改」的官方开关，必须让用户能看见。
            h(
              'label',
              { className: 'cr-row', style: { alignItems: 'center', gap: '6px', marginTop: '6px' } },
              h('input', {
                type: 'checkbox',
                checked: fidelity !== 'off',
                onChange: (event) => {
                  const next = event.target.checked ? 'high' : 'off'
                  setFidelity(next)
                  saveKeys({ openaiInputFidelity: next === 'off' ? '' : 'high' })
                },
              }),
              h('span', null, '结构优先：向接口声明 input_fidelity=high（尽量不改原图结构）'),
            ),
            h(
              'div',
              { className: 'cr-note' },
              '关掉后出图更「自由」，但更容易改掉原图分格；中转站不支持该字段时会自动去掉重发一次，不会报错。',
            ),
          ),

        // 1. CAD 立面图
        h(
          'div',
          { className: 'cr-section' },
          h(
            'div',
            { className: 'cr-label' },
            '1 · 导入底图',
            h(
              'span',
              null,
              '结构依据。立面施工图 / 手绘线稿 / SU·3D 模型截图 / 现场实拍照片 / 平面图都可以；有多视图的先裁到只剩要出图的那一个',
            ),
          ),
          cad && cropping?.kind === 'cad'
            ? h(CropBox, {
                src: cad.original,
                width: cad.width,
                height: cad.height,
                rect: draftCrop,
                onChange: setDraftCrop,
                onDone: applyCrop,
                onCancel: () => setCropping(null),
                hint: '拖拽框出要出图的那个视图，去掉标题栏/图框/其他视图；尺寸标注不用特意避开，提示词里已要求清除。',
              })
            : cad
              ? h(
                  'div',
                  { className: 'cr-thumb' },
                  h('img', { src: cad.previewUrl, alt: 'CAD 立面图' }),
                  h(
                    'div',
                    { className: 'cr-thumb-foot' },
                    h(
                      'span',
                      { className: 'cr-thumb-name' },
                      `${cad.name} · ${cad.width}×${cad.height}${cad.crop ? ' · 已裁切' : ''}${
                        cad.cleaned ? ' · 已转白底' : ''
                      }`,
                    ),
                    h('button', { className: 'cr-btn', onClick: () => startCrop('cad') }, cad.crop ? '重裁' : '裁切'),
                    h('button', { className: 'cr-btn', onClick: () => cadInput.current?.click() }, '更换'),
                    h('button', { className: 'cr-btn', onClick: () => setCad(null) }, '移除'),
                  ),
                )
              : dropZone('cad', '点击选择，或把底图（立面 / 线稿 / 模型截图 / 照片 / 平面图）拖进来'),
          h(
            'label',
            { className: 'cr-check' },
            h('input', {
              type: 'checkbox',
              checked: cleanCad,
              disabled: busy,
              onChange: (event) => toggleCleanCad(event.target.checked),
            }),
            h('span', null, '线稿/黑底图自动转白底（实测对结构还原影响很大，建议保持勾选）'),
          ),
          h('input', {
            ref: cadInput,
            type: 'file',
            accept: 'image/*',
            style: { display: 'none' },
            onChange: (event) => {
              takeFiles(event.target.files, 'cad')
              event.target.value = ''
            },
          }),
        ),

        // 1.5 图纸规格（视觉模型读图）；文生图没有底图可读，整段隐藏
        showRead &&
          h(
            'div',
            { className: 'cr-section' },
            h(
              'div',
              { className: 'cr-label' },
              'AI 读图出规格',
            h('span', null, '读出图纸的结构、材质颜色与五金，作为硬约束写进基础框架——这一步最影响「像不像」'),
          ),
          h(
            'div',
            { className: 'cr-row' },
            h(
              'button',
              { className: 'cr-btn', disabled: busy || reading || !cad, onClick: () => readCad() },
              reading ? '读图中…' : structure ? '重新读图' : 'AI 读图出结构',
            ),
            structure && h('button', { className: 'cr-btn', disabled: busy || reading, onClick: () => setStructure('') }, '清空'),
            h(
              'label',
              { className: 'cr-check' },
              h('input', {
                type: 'checkbox',
                checked: autoRead,
                disabled: busy,
                onChange: (event) => setAutoRead(event.target.checked),
              }),
              h('span', null, '上传后自动读'),
            ),
          ),
          structureNote && h('div', { className: 'cr-note' }, structureNote),
          structure
            ? h('textarea', {
                className: 'cr-ta',
                style: { minHeight: '120px' },
                value: structure,
                disabled: busy,
                onChange: (event) => setStructure(event.target.value),
              })
            : h(
                'div',
                { className: 'cr-note' },
                cad
                  ? '还没读图。点上面按钮让模型看这张底图，读出分格、门板数量、图纸标注的材质颜色与五金；读出来的内容可以改。**不读图也能出图，但材质颜色只能靠风格模板猜。**'
                  : '先导入底图，再读结构。',
              ),
        ),

        h(
          'div',
          { className: 'cr-section' },
          h(
            'div',
            { className: 'cr-label' },
            '2 · 参考图',
            h('span', null, '裁到只剩材质/颜色，别把整间房照进去，否则模型会照抄参考图的构图'),
          ),
          refs.length > 0 &&
            cropping?.kind === 'ref' && refs[cropping.index]
            ? h(CropBox, {
                src: refs[cropping.index].original,
                width: refs[cropping.index].width,
                height: refs[cropping.index].height,
                rect: draftCrop,
                onChange: setDraftCrop,
                onDone: applyCrop,
                onCancel: () => setCropping(null),
                hint: '拖拽框出材质/颜色区域（样板、板材特写、色卡），把周边环境、家具、人物都裁掉。',
              })
            : refs.length > 0 &&
              h(
                'div',
                { className: 'cr-grid' },
                refs.map((item, index) =>
                  h(
                    'div',
                    { className: 'cr-mini', key: `${item.name}-${index}`, title: item.crop ? '已裁切' : item.name },
                    h('img', { src: item.previewUrl, alt: item.name }),
                    h(
                      'button',
                      {
                        className: 'cr-icon',
                        title: '移除',
                        onClick: () => setRefs((previous) => previous.filter((_, i) => i !== index)),
                      },
                      '×',
                    ),
                    h(
                      'button',
                      {
                        className: 'cr-icon',
                        style: { top: '3px', right: '26px' },
                        title: item.crop ? '重新裁切' : '裁切',
                        onClick: () => startCrop('ref', index),
                      },
                      '⌗',
                    ),
                  ),
                ),
              ),
          !(cropping?.kind === 'ref') && refs.length < 2 && dropZone('ref', '点击选择，或把参考图拖进来'),
          (cad || refs.length > 0) &&
            h(
              'div',
              { className: 'cr-row' },
              h('span', { className: 'cr-note' }, '在「大白话」里 @ 指定图片：'),
              cad &&
                h(
                  'button',
                  { className: 'cr-chip', type: 'button', onClick: () => insertMention('@底图'), title: '底图就是图1' },
                  '@底图',
                ),
              refs.map((item, index) =>
                h(
                  'button',
                  {
                    className: 'cr-chip',
                    type: 'button',
                    key: `${item.name}-mention-${index}`,
                    title: item.name,
                    onClick: () => insertMention(`@参考图${index + 1}`),
                  },
                  `@参考图${index + 1}`,
                ),
              ),
            ),
          h('input', {
            ref: refInput,
            type: 'file',
            accept: 'image/*',
            multiple: true,
            style: { display: 'none' },
            onChange: (event) => {
              takeFiles(event.target.files, 'ref')
              event.target.value = ''
            },
          }),
        ),

        // 3. 操作 + 分析图类型 + 风格 + 光影 + 构图 + 大白话
        h(
          'div',
          { className: 'cr-section' },
          h(
            'div',
            { className: 'cr-label' },
            '3 · 要做什么',
            h('span', null, needBase ? '按底图是什么来选；一个操作 = 一套专用提示词' : '不需要底图，直接按描述生成'),
          ),
          h(
            'div',
            { className: 'cr-chips' },
            (catalog?.taskModes ?? [{ id: 'elevation', label: '立面 / 施工图', hint: '' }]).map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  className: 'cr-chip',
                  'data-active': taskMode === item.id ? '1' : '0',
                  title: item.hint,
                  disabled: busy,
                  onClick: () => chooseOperation(item.id),
                },
                item.noBase ? '✦ ' : '',
                item.label,
              ),
            ),
          ),
          taskMode === 'diagram' &&
            h(
              'div',
              { className: 'cr-camgroup' },
              h('div', { className: 'cr-camgroup-title' }, '分析图类型'),
              h(
                'div',
                { className: 'cr-styles' },
                (catalog?.diagrams ?? []).map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      className: 'cr-card cr-card-lg',
                      type: 'button',
                      'data-active': diagram === item.id ? '1' : '0',
                      title: item.hint,
                      disabled: busy,
                      onClick: () => setDiagram(item.id),
                    },
                    diagramTypeIcon(item),
                    h('span', { className: 'cr-card-label' }, item.label),
                  ),
                ),
              ),
            ),
          !needBase &&
            h(
              'div',
              { className: 'cr-note' },
              '文生图不需要底图：把要的画面写进下面的「大白话」。也可以传 1~2 张参考图定风格，用 @参考图1 指定。',
            ),

          // 「换视角 / 风格迁移」不摆风格选择器：它只会误导用户去换风格。
          styleFixed
            ? h(
                'div',
                { className: 'cr-note' },
                STYLE_FIXED_NOTE[taskMode] ?? '这个操作不需要选风格，材质来源已由操作本身决定。',
              )
            : h(
                'div',
                { className: 'cr-label', style: { marginTop: '4px' } },
                styleLabel,
                h(
                  'span',
                  null,
                  `按「${operations.find((item) => item.id === taskMode)?.label ?? '当前操作'}」自动切换${
                    styleIds.length > 1 ? ' · 可多选 = 一次出多套方案' : ''
                  }`,
                ),
              ),
          !styleFixed &&
            h(
              'div',
              { className: 'cr-styles' },
              visibleStyles.map((item) => {
                const active = styleIds.includes(item.id)
                return h(
                  'button',
                  {
                    key: item.id,
                    className: 'cr-card cr-card-lg',
                    type: 'button',
                    'data-active': active ? '1' : '0',
                    title: item.hint,
                    disabled: busy,
                    onClick: () =>
                      setStyleIds((previous) =>
                        previous.includes(item.id)
                          ? previous.length > 1
                            ? previous.filter((id) => id !== item.id)
                            : previous
                          : [...previous, item.id],
                      ),
                  },
                  stylePreview(item),
                  h('span', { className: 'cr-card-label' }, item.label),
                )
              }),
            ),

          // 光影也做成图示卡片：一眼看出光源方向与色温。
          // 彩平图没有方向性光照，给它摆光影选择器只会误导 —— 按操作显示。
          showLighting &&
            h(
              'div',
              { className: 'cr-camgroup' },
              h('div', { className: 'cr-camgroup-title' }, '光影'),
              h(
                'div',
                { className: 'cr-styles' },
                (catalog?.lighting ?? [{ id: 'auto', label: '跟随风格', hint: '' }]).map((item) =>
                  h(
                    'button',
                    {
                      key: item.id,
                      className: 'cr-card cr-card-lg',
                      type: 'button',
                      'data-active': lighting === item.id ? '1' : '0',
                      title: item.hint,
                      disabled: busy,
                      onClick: () => setLighting(item.id),
                    },
                    lightingIcon(item),
                    h('span', { className: 'cr-card-label' }, item.label),
                  ),
                ),
              ),
            ),

          // 出图比例：默认跟随底图，也可以自己指定。
          h(
            'div',
            { className: 'cr-camgroup' },
            h(
              'div',
              { className: 'cr-camgroup-title' },
              '出图比例',
              h(
                'span',
                { className: 'cr-note', style: { marginLeft: '6px', fontWeight: 400 } },
                ratio === 'follow' ? '按底图长宽比出图' : `已指定 ${ratio}（实际尺寸看结果里的回报）`,
              ),
            ),
            h(
              'div',
              { className: 'cr-styles' },
              (catalog?.ratios ?? [{ id: 'follow', label: '跟随底图', hint: '', w: 0, h: 0 }]).map((item) =>
                h(
                  'button',
                  {
                    key: item.id,
                    className: 'cr-card cr-card-lg',
                    type: 'button',
                    'data-active': ratio === item.id ? '1' : '0',
                    title: item.hint,
                    disabled: busy,
                    onClick: () => setRatio(item.id),
                  },
                  ratioIcon(item),
                  h('span', { className: 'cr-card-label' }, item.label),
                ),
              ),
            ),
          ),

          h(
            'div',
            { className: 'cr-row' },
            h('span', { className: 'cr-note' }, '张数/任务'),
            h(
              'div',
              { className: 'cr-seg' },
              [1, 2, 3, 4].map((value) =>
                h(
                  'button',
                  {
                    key: value,
                    'data-active': count === value ? '1' : '0',
                    onClick: () => setCount(value),
                    disabled: busy,
                  },
                  String(value),
                ),
              ),
            ),
          ),

          // 机位＝水平角度 / 垂直角度 / 取景距离三个正交维度。
          // 每项都是图示卡片而不是文字芯片（学竞品子菜单）。
          showCamera &&
            h(
              'div',
              { className: 'cr-camgroup' },
              h(
                'div',
                { className: 'cr-label', style: { marginTop: '2px' } },
                '机位',
                h('span', null, '三个维度自由组合；全选「原样」就用底图视角'),
              ),
              h(
                'div',
                { className: 'cr-row', style: { gap: '6px' } },
                h(
                  'span',
                  { className: 'cr-combo' },
                  '当前机位：',
                  cameraLabel || elevationLabel || distanceLabel
                    ? [cameraLabel, elevationLabel, distanceLabel].filter(Boolean).join(' · ')
                    : '跟随底图',
                ),
              ),
              h(
                'div',
                { className: 'cr-chips' },
                (catalog?.cameraCombos ?? []).map((combo) => {
                  // 组合缺任一维度的 id 就禁用，绝不静默地把维度设成 undefined
                  //（这正是「这一排点不了」的原因：宿主端曾把三个 id 裁掉了）。
                  const usable = Boolean(combo.azimuth && combo.elevation && combo.distance)
                  return h(
                    'button',
                    {
                      key: combo.id,
                      className: 'cr-chip',
                      type: 'button',
                      title: usable ? combo.hint : '这个组合缺少维度信息，已禁用',
                      disabled: busy || !usable,
                      onClick: () => {
                        if (!usable) return
                        setCamera(combo.azimuth)
                        setCameraElevation(combo.elevation)
                        setCameraDistance(combo.distance)
                      },
                    },
                    combo.label,
                  )
                }),
              ),
              cameraGroup(
                '水平角度（围绕主体左右转）',
                catalog?.cameras ?? [{ id: 'inherit', label: '原角度', hint: '', deg: null }],
                azimuthIcon,
                camera,
                setCamera,
                busy,
                'az',
              ),
              cameraGroup(
                '垂直角度（机位高低）',
                catalog?.cameraElevations ?? [{ id: 'inherit', label: '原高度', hint: '', deg: null }],
                elevationIcon,
                cameraElevation,
                setCameraElevation,
                busy,
                'el',
              ),
              cameraGroup(
                '取景距离（远近）',
                catalog?.cameraDistances ?? [{ id: 'inherit', label: '不变', hint: '', level: null }],
                distanceIcon,
                cameraDistance,
                setCameraDistance,
                busy,
                'ds',
              ),
            ),
          // 文生图没有底图可以比对，质检无从下手 —— 按操作隐藏。
          showQc &&
            h(
              'label',
              { className: 'cr-check' },
              h('input', {
                type: 'checkbox',
                checked: autoQc,
                disabled: busy,
                onChange: (event) => setAutoQc(event.target.checked),
              }),
              h(
                'span',
                null,
                '出图后自动质检：让模型对照底图自查，结构不过关就带着修正意见重出一次（多花一次出图费用）',
              ),
            ),

          h(
            'div',
            { className: 'cr-label', style: { marginTop: '4px' } },
            '大白话',
            h('span', null, '说人话就行。会保留所选风格的基础框架，再把你的要求整理成【本次要求】接在后面'),
          ),
          h('textarea', {
            ref: plainRef,
            className: 'cr-ta',
            placeholder:
              '例如：客户想要奶油风，材质照 @参考图1，颜色以 @参考图2 为准（提示词里可以用 @底图 / @参考图1 / @参考图2 指定图片）',
            value: plain,
            disabled: busy,
            onChange: (event) => setPlain(event.target.value),
          }),
          h(
            'div',
            { className: 'cr-row' },
            h(
              'button',
              { className: 'cr-btn', disabled: busy || composing || !plain.trim(), onClick: polish },
              composing ? '润色中…' : composed ? '再润一版' : 'AI 润色提示词',
            ),
            composed &&
              h(
                'button',
                { className: 'cr-btn', disabled: busy, onClick: () => setComposed('') },
                '清空专业话术',
              ),
            composeMeta &&
              h(
                'span',
                { className: 'cr-verdict', 'data-kind': composeMeta.rewritten ? 'ok' : 'fix' },
                composeMeta.rewritten ? `模型润色 · ${composeMeta.by ?? ''}` : '内置模板（未走模型）',
              ),
          ),
          composeNote && h('div', { className: 'cr-note' }, composeNote),
          composed &&
            h('textarea', {
              className: 'cr-ta',
              style: { minHeight: '140px' },
              value: composed,
              disabled: busy,
              onChange: (event) => setComposed(event.target.value),
            }),

          h(
            'div',
            { className: 'cr-row' },
            h(
              'div',
              { className: 'cr-seg' },
              PROVIDERS.map((item) =>
                h(
                  'button',
                  {
                    key: item.id,
                    'data-active': provider === item.id ? '1' : '0',
                    onClick: () => {
                      providerTouchedRef.current = true
                      setProvider(item.id)
                    },
                    disabled: busy,
                    title: item.hint,
                  },
                  item.label,
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'cr-note' },
            '出图尺寸自动跟随 CAD 立面图的长宽比；结果保存到 ',
            status?.outputDir ?? '会话工作目录/AI效果图',
          ),
        ),

        // 3.5 迭代改图
        refineFrom &&
          h(
            'div',
            { className: 'cr-section', ref: refineRef },
            h('div', { className: 'cr-label' }, '迭代改图', h('span', null, '在上一版基础上只改你点名的地方')),
            h('div', { className: 'cr-note' }, refineFrom),
            h('textarea', {
              className: 'cr-ta',
              placeholder: '想改什么？例如「主体换成浅色木纹，其余不动」',
              value: instruction,
              disabled: busy,
              onChange: (event) => setInstruction(event.target.value),
            }),
            h(
              'div',
              { className: 'cr-row' },
              h('button', { className: 'cr-btn', disabled: busy, onClick: () => setRefineFrom('') }, '取消改图'),
            ),
          ),

        note && h('div', { className: 'cr-ok' }, note),
        error && h('div', { className: 'cr-error' }, error),

        // 底部固定操作条：始终能看到进度与主按钮
        h(
          'div',
          { className: 'cr-sticky' },
          h(
            'button',
            {
              className: 'cr-primary',
              disabled:
                busy ||
                (refineFrom ? !instruction.trim() : needBase ? !cad : !plain.trim()),
              onClick: () => run(),
            },
            busy
              ? '生成中…'
              : refineFrom
                ? '应用修改'
                : styleIds.length > 1
                  ? `生成 ${styleIds.length} 套方案`
                  : '生成效果图',
          ),
          busy && h('span', { className: 'cr-spin' }),
          // 改图态在底部也显示一次：用户是在结果区点「改这张」的，
          // 反馈必须出现在他眼睛所在的位置，而不是只在上面那块面板里。
          refineFrom &&
            h(
              'span',
              { className: 'cr-refine-chip' },
              `改图对象：${String(refineFrom).split(/[\\/]/).pop()}`,
              h('button', { type: 'button', className: 'cr-chip-x', onClick: () => setRefineFrom('') }, '×'),
            ),
          h(
            'div',
            { className: 'cr-stages', style: { flex: '1 1 auto', minWidth: 0 } },
            (busy || stages.length > 0
              ? stages
              : [
                  { label: needBase ? (cad ? '底图已就绪' : '等待导入底图') : '无需底图', state: !needBase || cad ? 'done' : 'idle' },
                  { label: refs.length > 0 ? '参考图已就绪' : '参考图（可选）', state: refs.length > 0 ? 'done' : 'idle' },
                ]
            ).map((stage, index) =>
              h(
                'div',
                { className: 'cr-stage', key: `${stage.label}-${index}`, 'data-state': stage.state },
                h(
                  'span',
                  { className: 'cr-stage-mark' },
                  stage.state === 'done' ? '✓' : stage.state === 'active' ? '●' : '○',
                ),
                h('span', null, stage.label),
              ),
            ),
          ),
          busy &&
            h(
              'button',
              {
                className: 'cr-btn',
                onClick: () => {
                  runTokenRef.current += 1
                  setBusy(false)
                  setStages([])
                  setNote('已停止等待（出图可能仍在后台完成，稍后可到出图目录取回）。')
                },
              },
              '停止',
            ),
        ),

        // 5. 结果
        results.length > 0 &&
          h(
            'div',
            { className: 'cr-section' },
            h(
              'div',
              { className: 'cr-label' },
              '效果图',
              h('span', null, `${results.length} 张 · 点「改这张」可以继续迭代`),
            ),
            results.map((item, index) =>
              h(
                'div',
                { className: 'cr-result', key: item.path ?? index },
                (() => {
                  // 可用的「原图」来源：底图，以及质检修正时的上一版
                  const baseSrc = cad?.previewUrl ?? ''
                  const source =
                    sliderSource === 'prev' && item.compareFrom ? item.compareFrom : baseSrc
                  const sourceLabel = sliderSource === 'prev' && item.compareFrom ? '上一版' : '底图'
                  if (sliderIndex === index && item.url && source) {
                    return h(CompareSlider, {
                      afterSrc: item.url,
                      beforeSrc: source,
                      beforeLabel: `${sourceLabel} · 原图`,
                      afterLabel: '效果图',
                    })
                  }
                  return item.url
                    ? h('img', { src: item.url, alt: item.name })
                    : h('div', { className: 'cr-error' }, `图片预览失败：${item.readError ?? ''}`)
                })(),
                h(
                  'div',
                  { className: 'cr-result-foot' },
                  h('span', { className: 'cr-note', style: { fontWeight: 600 } }, item.styleLabel ?? ''),
                  item.refined ? h('span', { className: 'cr-verdict', 'data-kind': 'muted' }, '迭代版') : null,
                  item.qcVerdict
                    ? h(
                        'span',
                        { className: 'cr-verdict', 'data-kind': item.qcVerdict === 'fix' ? 'fix' : 'ok' },
                        item.qcVerdict === 'ok'
                          ? '质检通过'
                          : item.qcVerdict === 'fixed'
                            ? '质检已修正'
                            : '质检有问题',
                      )
                    : null,
                  item.url &&
                    h('button', {
                      className: 'cr-btn',
                      disabled: busy,
                      onClick: () => pickForRefine(item.path),
                    }, '改这张'),
                  item.url &&
                    h('button', {
                      className: 'cr-btn',
                      type: 'button',
                      onClick: () => setViewer({ url: item.url, name: item.name, path: item.path }),
                    }, '看大图'),
                  item.url &&
                    (cad?.previewUrl || item.compareFrom) &&
                    h(
                      'button',
                      {
                        className: 'cr-btn',
                        type: 'button',
                        'data-active': sliderIndex === index ? '1' : '0',
                        onClick: () => {
                          // 再点一次收起，回到单图
                          setSliderIndex((previous) => (previous === index ? -1 : index))
                          setSliderSource('base')
                        },
                      },
                      sliderIndex === index ? '单图查看' : '滑动对比',
                    ),
                  item.url &&
                    h('a', { href: item.url, download: item.name }, '下载'),
                  h('span', { className: 'cr-note', style: { flex: '1 1 100%' } }, item.path ?? ''),
                ),
                // 对比来源切换：只在「滑动对比」开着、且确实有两种原图时出现
                sliderIndex === index && item.compareFrom && cad?.previewUrl
                  ? h(
                      'div',
                      { className: 'cr-slider-sources', style: { padding: '8px 10px 0' } },
                      h('span', { className: 'cr-note' }, '对比对象'),
                      ...[
                        { id: 'base', label: '底图' },
                        { id: 'prev', label: '上一版' },
                      ].map((option) =>
                        h(
                          'button',
                          {
                            key: option.id,
                            className: 'cr-chip',
                            type: 'button',
                            'data-active': sliderSource === option.id ? '1' : '0',
                            onClick: () => setSliderSource(option.id),
                          },
                          option.label,
                        ),
                      ),
                    )
                  : null,
                item.compareFrom
                  ? h(
                      'div',
                      { className: 'cr-compare', style: { padding: '0 10px 10px' } },
                      h(
                        'figure',
                        { className: 'cr-compare-item' },
                        h('img', { src: item.compareFrom, alt: '修改前' }),
                        h('figcaption', null, '修改前'),
                      ),
                      h(
                        'figure',
                        { className: 'cr-compare-item' },
                        h('img', { src: item.url, alt: '修改后' }),
                        h('figcaption', null, '修改后'),
                      ),
                    )
                  : null,
                // 一键操作：在结果上直接做定向修改，复用「改这张」通道
                (catalog?.quickActions ?? []).length > 0 &&
                  h(
                    'div',
                    { className: 'cr-row', style: { padding: '0 10px 10px' } },
                    h('span', { className: 'cr-note' }, '一键操作：'),
                    (catalog?.quickActions ?? []).map((action) =>
                      h(
                        'button',
                        {
                          className: 'cr-chip',
                          type: 'button',
                          key: `${action.id}-${index}`,
                          title: action.hint,
                          disabled: busy || !item.url || (action.needsReference && refs.length === 0),
                          onClick: () => runQuick(action, item),
                        },
                        action.label,
                      ),
                    ),
                  ),
              ),
            ),
          ),

        // 6. 历史记录
        h(
          'div',
          { className: 'cr-section' },
          h(
            'div',
            { className: 'cr-row' },
            h(
              'div',
              { className: 'cr-label', style: { flex: '1 1 auto' } },
              '历史记录',
              h('span', null, '参数整套可还原，下次不用重填'),
            ),
            h(
              'button',
              {
                className: 'cr-btn',
                disabled: busy || loadingHistory,
                onClick: () => {
                  const next = !historyOpen
                  setHistoryOpen(next)
                  if (next) loadHistory()
                },
              },
              loadingHistory ? '读取中…' : historyOpen ? '收起' : '展开',
            ),
            historyOpen && history.length > 0
              ? h(
                  'button',
                  {
                    className: 'cr-btn',
                    disabled: busy || loadingHistory,
                    onClick: async () => {
                      try {
                        await callCommand(ctx, sessionId, { action: 'history-clear' })
                        history.forEach((record) => record.url && URL.revokeObjectURL(record.url))
                        setHistory([])
                        setHistoryNote('历史已清空（已出的图片文件不会被删除）。')
                      } catch (failure) {
                        setHistoryNote(String(failure?.message ?? failure))
                      }
                    },
                  },
                  '清空',
                )
              : null,
          ),
          historyOpen && historyNote ? h('div', { className: 'cr-note' }, historyNote) : null,
          historyOpen &&
            history.map((record) =>
              h(
                'div',
                { className: 'cr-hist', key: record.id ?? record.at },
                record.url
                  ? h('img', { className: 'cr-hist-thumb', src: record.url, alt: record.taskModeLabel ?? '' })
                  : h('div', { className: 'cr-hist-thumb' }),
                h(
                  'div',
                  { className: 'cr-hist-body' },
                  h(
                    'div',
                    { className: 'cr-hist-title' },
                    `${record.taskModeLabel ?? record.taskMode ?? ''}${record.styleLabel ? ` · ${record.styleLabel}` : ''}`,
                  ),
                  h(
                    'div',
                    { className: 'cr-note' },
                    [
                      record.at ? new Date(record.at).toLocaleString() : '',
                      record.size ?? '',
                      record.model ?? '',
                      record.qcVerdict === 'ok' ? '质检通过' : record.qcVerdict ? '质检已修正' : '',
                      record.elapsedMs ? `${(record.elapsedMs / 1000).toFixed(0)}s` : '',
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  ),
                  h(
                    'div',
                    { className: 'cr-row' },
                    h('button', { className: 'cr-btn', disabled: busy, onClick: () => restoreParams(record) }, '还原参数'),
                    record.files?.[0]
                      ? h(
                          'button',
                          {
                            className: 'cr-btn',
                            disabled: busy,
                            onClick: () => pickForRefine(record.files[0]),
                          },
                          '改这张',
                        )
                      : null,
                  ),
                ),
              ),
            ),
        ),

        h(
          'div',
          { className: 'cr-note' },
          '提示：也可以直接在对话里用 /ai-render 调用（旧名 /cabinet-render 仍可用）；面板与 Agent 走同一条命令。',
        ),

        // 大图浮层：点「看大图」打开，点任意处关闭
        viewer &&
          h(
            'div',
            {
              className: 'cr-viewer',
              onClick: () => setViewer(null),
              title: '点击任意处关闭',
            },
            h('img', { className: 'cr-viewer-img', src: viewer.url, alt: viewer.name ?? '大图' }),
            h(
              'div',
              { className: 'cr-viewer-bar', onClick: (event) => event.stopPropagation() },
              h('span', { className: 'cr-viewer-name' }, viewer.name ?? ''),
              h(
                'a',
                { className: 'cr-btn', href: viewer.url, download: viewer.name },
                '下载',
              ),
              h('button', { className: 'cr-btn', type: 'button', onClick: () => setViewer(null) }, '关闭'),
            ),
          ),
      )
    }

    // 让面板组件拿到插件上下文：注册时用闭包注入，避免依赖框架的 props 约定。
    function BoundPanel(ctx) {
      return function PanelWithContext(props) {
        return h(Panel, { ...props, ctx })
      }
    }

    // ------------------------------------------------------------ 快捷按钮

    function OpenButton(props) {
      const open = props?.openCabinetRender
      if (typeof open !== 'function') return null
      return h(
        'button',
        {
          className: 'cr-composer-btn',
          type: 'button',
          title: '打开 AI 效果图面板',
          onClick: () => open(),
        },
        h(
          'svg',
          { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2, stroke: 'currentColor', strokeWidth: 1.8 }),
          h('path', { d: 'M9 3v18M9 9h12M9 15h12', stroke: 'currentColor', strokeWidth: 1.6 }),
        ),
        '效果图',
      )
    }

    function BoundOpenButton(ctx) {
      return function OpenButtonWithContext(props) {
        return h(OpenButton, {
          ...props,
          openCabinetRender: () => ctx.sidebarRight.openTab(TAB_KIND),
        })
      }
    }

    // ------------------------------------------------------------ 插件

    return {
      /**
       * 每个 Remote 命名空间都是独立的 Cordis 服务，键名是 `remote.<namespace>`
       * （见 api-gateway 的 remoteServiceKey()：`remote.${namespace}`），
       * 必须逐个 inject，否则访问 ctx.remote.commands 会直接抛
       * 「cannot get property "remote.commands" without inject」。
       *
       * 这里用到的两个命名空间：
       *   remote.commands        —— 面板 → 宿主（status / presets / compose / 出图）
       *   remote.workspaceFiles  —— 取回生成结果图片字节
       */
      inject: [
        'slots',
        'remote',
        'remote.commands',
        'remote.workspaceFiles',
        'sidebarRight',
        'sidebarRightTabs',
      ],
      apply(ctx) {
        ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => TAB_TITLE,
          // 必须保持挂载：切到别的标签页再切回来时，如果组件被卸载，
          // 所有 useState 都会重置 —— 出图结果、进行中的阶段、填好的表单全没了
          // （用户反馈过「切走再切回来任务就不见了」）。
          keepMounted: true,
          // 没有这一项，右侧栏的「+」和导引页里就列不出这个标签页，
          // 用户只能靠输入框那个小按钮找到它 —— 必须声明。
          guide: [
            {
              id: 'ai-render',
              order: 20,
              title: () => TAB_TITLE,
              description: () => 'CAD 立面图 + 参考图出写实效果图',
            },
          ],
        })

        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID },
            BoundPanel(ctx),
          ),
        )

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'cabinet-render-open', order: 30 },
            BoundOpenButton(ctx),
          ),
        )
      },
      /**
       * 只给离线测试用：把几个纯函数式的示意图渲染器暴露出来，
       * 这样测试能直接验证「每个风格/分析图/光影都能画出不一样的示意图」，
       * 而不必去跑真实面板（宿主环境里面板拿不到目录）。
       */
      __test: {
        stylePreview,
        diagramTypeIcon,
        lightingIcon,
        ratioIcon,
        azimuthIcon,
        elevationIcon,
        distanceIcon,
        cropFractionRatio,
        fitCropRect,
        fitCropAll,
        refitCropRect,
        revealFromPointer,
        clipInsetFor,
      },
    }
  },
})
