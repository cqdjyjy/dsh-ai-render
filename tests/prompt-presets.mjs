/**
 * 预设库与提示词组装器的离线测试。不联网、不花钱。
 *
 * 锁住的行为：
 *   1. 目录完整性（任务模式 / 风格预设 / 光影预设）
 *   2. 段落顺序与标签，且【补充要求】必须在最后
 *   3. 每个风格都能产出材质与光影描述，不留空段
 *   4. 限长裁剪：即梦 300 字预算下必须真的 ≤300，且保住结构锁死与材质
 *   5. 参考图编号（图2 / 图2~图3）、自定义预设、迭代改图、负向词
 *
 * 用法：node tests/prompt-presets.mjs
 */
import {
  TASK_MODES,
  STYLE_PRESETS,
  STYLE_SWATCHES,
  LIGHTING_PRESETS,
  CAMERA_PRESETS,
  CAMERA_AZIMUTH,
  CAMERA_ELEVATION,
  CAMERA_DISTANCE,
  CAMERA_COMBOS,
  CAD_READER_SYSTEM,
  cadReaderSystem,
  resolveImageMentions,
  RATIO_PRESETS,
  resolveRatio,
  sizeFromRatio,
  stylesOf,
  styleGroupsOf,
  styleIsFixedToBase,
  uiOf,
  qcSystem,
  resolveStyle,
  QC_SYSTEM,
  NEGATIVE_PROMPT,
  composePrompt,
  composeNegative,
} from '../presets.js'

let failures = 0
const check = (condition, label) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

const SECTION_ORDER = ['【结构锁死】', '【视角构图】', '【材质色彩】', '【光影】', '【清除】', '【画质】']

console.log('\n== 1. 目录完整性 ==')
check(TASK_MODES.length === 11, `操作 11 个（实为 ${TASK_MODES.length}）`)
check(STYLE_PRESETS.length === 30, `风格预设 30 个（实为 ${STYLE_PRESETS.length}）`)
check(LIGHTING_PRESETS.length === 5, `光影预设 5 个（实为 ${LIGHTING_PRESETS.length}）`)
check(
  new Set(STYLE_PRESETS.map((style) => style.id)).size === STYLE_PRESETS.length,
  '风格 id 无重复',
)
check(
  ['interior', 'flat', 'axon', 'diagram', 'concept'].every((group) =>
    STYLE_PRESETS.some((style) => style.group === group),
  ),
  '五个风格组都有内容',
)
check(
  STYLE_PRESETS.every((style) => TASK_MODES.some((mode) => styleGroupsOf(mode.id).includes(style.group))),
  '每个风格组都至少被一个操作用到（没有孤儿风格）',
)
check(stylesOf('plan').every((style) => style.group === 'flat'), '平面图只给彩平风格')
check(stylesOf('diagram').every((style) => style.group === 'diagram'), '分析图只给分析图风格')
check(stylesOf('plan-3d').every((style) => style.group === 'axon'), '平面→立体户型只给轴测风格')
check(stylesOf('elevation').every((style) => style.group === 'interior'), '立面渲染只给家居风格')
check(
  stylesOf('text2img').some((style) => style.group === 'concept'),
  '文生图额外提供概念风格',
)
check(
  ['elevation', 'photo', 'sketch'].every((id) => TASK_MODES.some((mode) => mode.id === id)),
  '三种任务模式齐备',
)
check(
  CAMERA_PRESETS === CAMERA_AZIMUTH && CAMERA_PRESETS[0].id === 'inherit',
  'camera 字段等价于水平角度，且首个是「原角度」',
)
check(
  STYLE_PRESETS.every((style) => Array.isArray(STYLE_SWATCHES[style.id]) && STYLE_SWATCHES[style.id].length === 2),
  '每个风格都有两色色卡（面板芯片用）',
)
check(CAD_READER_SYSTEM.includes('只读立面'), '读图提示词要求只读立面视图')
check(CAD_READER_SYSTEM.includes('未收到图片'), '读图提示词带自证指令')
check(/判定[:：]/.test(QC_SYSTEM) && QC_SYSTEM.includes('不在判定范围内'), '质检提示词只判结构、不判风格')

console.log('\n== 2. 段落顺序与标签 ==')
const full = composePrompt({
  taskMode: 'elevation',
  stylePreset: 'cream',
  lighting: 'dusk',
  referenceCount: 1,
  plain: '客户想亮一点',
})
const positions = SECTION_ORDER.map((label) => full.indexOf(label))
check(
  positions.every((position) => position >= 0),
  '必需段落标签都在',
)
check(
  positions.every((position, index) => index === 0 || position > positions[index - 1]),
  '段落顺序正确',
)
check(full.trimEnd().endsWith('客户想亮一点'), '【补充要求】在最后')
check(full.includes('黄昏的低角度暖光'), '光影预设覆盖风格自带光影')
check(!full.includes('{refs}'), '没有残留占位符')

console.log('\n== 3. 每个风格都能产出可用提示词 ==')
let thin = []
for (const style of STYLE_PRESETS) {
  // 「沿用底图」本来就不提供材质，跳过（它单独在别处断言）。
  if (style.group === 'none') continue
  const prompt = composePrompt({ taskMode: 'elevation', stylePreset: style.id, referenceCount: 1 })
  if (style.id === 'custom') {
    if (!prompt.includes('完全参照图2')) thin.push(style.id)
    continue
  }
  if (!prompt.includes('【材质色彩】') || !prompt.includes('【光影】') || !prompt.includes('【氛围】')) thin.push(style.id)
  if (prompt.includes('【材质色彩】\n') || prompt.includes('【光影】\n')) thin.push(`${style.id}(空段)`)
}
check(thin.length === 0, `13 个风格都产出了材质/光影/氛围${thin.length ? `（异常：${thin.join(',')}）` : ''}`)

console.log('\n== 4. 即梦 300 字预算的裁剪 ==')
const tight = composePrompt({
  taskMode: 'elevation',
  stylePreset: 'lux',
  referenceCount: 2,
  plain: '这是用户写的很长的一段补充要求，需要保证它在有预算时不会被丢掉，但在预算紧张时可以被裁掉。',
  budget: 300,
})
check(tight.length <= 300, `裁剪后长度 ≤300（实为 ${tight.length}）`)
check(tight.includes('【结构锁死】'), '硬约束「结构锁死」被保住')
check(tight.includes('【材质色彩】'), '硬约束「材质色彩」被保住')
check(tight.includes('【清除】'), '【清除】施工图元素被保住')
check(tight.includes('不要复制其构图'), '限长版仍带反抄写句（防模型照抄参考图构图）')
check(!tight.includes('【空间环境】'), '低优先级的【空间环境】被裁掉')
check(!tight.includes('{refs}'), '裁剪后没有残留占位符')

console.log('\n== 5. 参考图编号 / 自定义预设 ==')
const noRef = composePrompt({ taskMode: 'elevation', stylePreset: 'custom', referenceCount: 0 })
check(!noRef.includes('图2'), '没有参考图时不提图2')
const oneRef = composePrompt({ taskMode: 'elevation', stylePreset: 'custom', referenceCount: 1 })
check(oneRef.includes('完全参照图2'), '1 张参考图 → 图2')
const twoRef = composePrompt({ taskMode: 'elevation', stylePreset: 'custom', referenceCount: 2 })
check(twoRef.includes('完全参照图2~图3'), '2 张参考图 → 图2~图3')

const custom = composePrompt({ taskMode: 'elevation', stylePreset: 'custom', referenceCount: 1 })
const styled = composePrompt({ taskMode: 'elevation', stylePreset: 'cream', referenceCount: 1 })
check(custom.includes('绝对不要复制其构图'), '自定义预设也带反抄写句')
check(styled.includes('绝对不要复制其构图'), '风格预设也带反抄写句')
check(!composePrompt({ taskMode: 'elevation', stylePreset: 'cream', referenceCount: 0 }).includes('不要复制其构图'), '没有参考图时不需要反抄写句')

console.log('\n== 6. 迭代改图 ==')
const refine = composePrompt({ instruction: '柜门改成浅色木纹格栅', stylePreset: 'cream', referenceCount: 1 })
check(refine.includes('【本次改动】柜门改成浅色木纹格栅'), '带出【本次改动】')
check(!refine.includes('CAD立面图'), '不再是「从 CAD 渲染」的任务帧')
check(refine.includes('不得重新设计'), '结构锁死改成「只改这一处」的措辞')
check(refine.includes('其余材质、颜色与表面工艺一律沿用图1'), '要求沿用上一版其余材质')
check(!refine.includes('奶油白'), '不复述风格材质（避免与【本次改动】自相矛盾）')
check(!refine.includes('【清除】'), '改图模式不再要求清除施工图元素')

console.log('\n== 7. 图纸规格注入（视觉模型读图的结果） ==')
const structureSpec = '1. 轮廓 1016x2410，竖高比 1:2.4\n2. 左 200 通高侧板，右 816 主柜\n3. 上部三层板，中部 650 开放区，一道横板，下段 644'
const withStructure = composePrompt({ taskMode: 'elevation', stylePreset: 'modern', referenceCount: 1, structure: structureSpec })
check(withStructure.includes('【图纸规定'), '注入了【图纸规定】段')
check(withStructure.includes('左 200 通高侧板'), '图纸规格原文进入提示词')
check(
  withStructure.indexOf('【结构锁死】') < withStructure.indexOf('【图纸规定') &&
    withStructure.indexOf('【图纸规定') < withStructure.indexOf('【材质色彩】'),
  '图纸规定排在结构锁死之后、材质之前',
)
check(
  composePrompt({ taskMode: 'elevation', stylePreset: 'modern', referenceCount: 1 }).includes('【图纸规定') === false,
  '没有结构清单时不出现空段',
)
// 有结构清单时不再套用即梦 300 字预算（清单本身就是内容）
const structureLong = composePrompt({ taskMode: 'elevation', stylePreset: 'lux', referenceCount: 2, structure: structureSpec, budget: 0 })
check(structureLong.includes('左 200 通高侧板'), '长清单在完整模式下保留')

console.log('\n== 9. 机位三维度覆盖视角段 ==')
const threeQuarter = composePrompt({
  taskMode: 'elevation',
  stylePreset: 'modern',
  referenceCount: 1,
  camera: 'front-right',
  cameraElevation: 'eye',
  cameraDistance: 'medium',
})
check(threeQuarter.includes('水平角度 45°'), '注入水平角度 45°（右前）')
check(threeQuarter.includes('垂直角度 0°'), '注入垂直角度 0°（平视）')
check(threeQuarter.includes('取景距离 中景'), '注入取景距离中景')
check(!threeQuarter.includes('正面平视（一点透视），相机高度与中线齐平'), '原视角描述已被替换')
const inherit = composePrompt({ taskMode: 'elevation', stylePreset: 'modern', referenceCount: 1, camera: 'inherit' })
check(inherit.includes('正面平视（一点透视）'), '机位全「原样」时用任务模式自带视角')

console.log('\n== 9b. 机位模型完整性（对齐 8 水平 × 4 垂直 × 3 距离） ==')
check(CAMERA_AZIMUTH.length === 9, `水平角度含「原角度」共 9 档（实为 ${CAMERA_AZIMUTH.length}）`)
check(CAMERA_ELEVATION.length === 5, `垂直角度含「原高度」共 5 档（实为 ${CAMERA_ELEVATION.length}）`)
check(CAMERA_DISTANCE.length === 4, `取景距离含「不变」共 4 档（实为 ${CAMERA_DISTANCE.length}）`)
check(CAMERA_AZIMUTH.filter((item) => item.deg !== null).length === 8, '正好 8 个水平方位')
check(CAMERA_ELEVATION.filter((item) => item.deg !== null).length === 4, '正好 4 个垂直高度')
check(CAMERA_DISTANCE.filter((item) => item.level !== null).length === 3, '正好 3 档距离（特写/中景/广角）')
check(CAMERA_COMBOS.length >= 5, `常用机位组合至少 5 个（实为 ${CAMERA_COMBOS.length}）`)
check(
  CAMERA_COMBOS.every(
    (combo) =>
      CAMERA_AZIMUTH.some((item) => item.id === combo.azimuth) &&
      CAMERA_ELEVATION.some((item) => item.id === combo.elevation) &&
      CAMERA_DISTANCE.some((item) => item.id === combo.distance),
  ),
  '常用机位引用的三个维度 id 都真实存在',
)
const onlyElevation = composePrompt({
  taskMode: 'elevation',
  stylePreset: 'modern',
  referenceCount: 1,
  cameraElevation: 'low',
})
check(
  onlyElevation.includes('垂直角度 -30°') && !onlyElevation.includes('水平角度'),
  '只选垂直角度时不注入水平角度（三维度正交）',
)
check(
  !composePrompt({ taskMode: 'elevation', stylePreset: 'modern', referenceCount: 1 }).includes('按指定机位重新取景'),
  '机位全默认时不会冒出「按指定机位重新取景」',
)

console.log('\n== 11. @提及解析（让程序知道用户说的是哪张图） ==')
// 语义：图1=底图，图2=参考图1，图3=参考图2
check(resolveImageMentions('@底图 的结构别动', 2) === '图1 的结构别动', '@底图 → 图1')
check(resolveImageMentions('@原图 保持不变', 2) === '图1 保持不变', '@原图 → 图1')
check(resolveImageMentions('@参考图1 的木纹换成深色', 2) === '图2 的木纹换成深色', '@参考图1 → 图2')
check(resolveImageMentions('@参考2 的台面材质', 2) === '图3 的台面材质', '@参考2 → 图3')
check(resolveImageMentions('@图3 换成哑光', 2) === '图3 换成哑光', '@图3 保持图号')
check(
  resolveImageMentions('查一下 @参考图5 的材质', 2) === '查一下 @参考图5 的材质',
  '超出范围的 @参考图5 原样保留，不误改',
)
check(
  resolveImageMentions('@木纹板.jpg 的颜色照这个来', 2, ['木纹板.jpg', '大理石.png']) === '图2 的颜色照这个来',
  '按文件名 @木纹板.jpg → 图2',
)
check(
  resolveImageMentions('@大理石 的部分参考它', 2, ['木纹板.jpg', '大理石.png']) === '图3 的部分参考它',
  '按文件名去扩展名 @大理石 → 图3',
)
check(resolveImageMentions('', 2) === '', '空文本不报错')
check(resolveImageMentions('没有提及的普通句子', 2) === '没有提及的普通句子', '没有 @ 时原样返回')

console.log('\n== 12. 图号对照注入 ==')
const withLegend = composePrompt({ taskMode: 'model', stylePreset: 'modern', referenceCount: 2 })
check(withLegend.includes('【图号】'), '有两张参考图时注入【图号】对照')
check(
  withLegend.includes('图1 = 底图') && withLegend.includes('图2 = 参考图1') && withLegend.includes('图3 = 参考图2'),
  '【图号】内容正确',
)
check(
  !composePrompt({ taskMode: 'model', stylePreset: 'modern', referenceCount: 0 }).includes('【图号】'),
  '没有参考图时不注入',
)

console.log('\n== 13. 底图类型化任务模式 ==')
check(
  ['elevation', 'sketch', 'model', 'photo', 'plan', 'plan-3d', 'plan-perspective', 'diagram', 'style-transfer', 'view-switch', 'text2img'].every(
    (id) => TASK_MODES.some((mode) => mode.id === id),
  ),
  '十一种操作齐备',
)
check(TASK_MODES.filter((mode) => mode.noBase).length === 1, '只有文生图是不需要底图的操作')
check(cadReaderSystem('plan').includes('平面图'), '读图提示词随底图类型切换（平面）')
check(cadReaderSystem('model').includes('模型截图'), '读图提示词随底图类型切换（模型）')
check(!cadReaderSystem('elevation').includes('家具立面施工图'), '读图提示词不再硬写柜体立面')

console.log('\n== 15. 彩平 / 轴测 / 分析图风格不进「五金」段 ==')
const flatPrompt = composePrompt({ taskMode: 'plan', stylePreset: 'flat-lux' })
check(!flatPrompt.includes('【五金细节】'), '彩平风格不出现【五金细节】（平面图没有拉手）')
check(flatPrompt.includes('【细节处理】'), '彩平风格改用【细节处理】')
check(!flatPrompt.includes('拉手'), '彩平风格提示词里不含「拉手」')
const axonPrompt = composePrompt({ taskMode: 'plan-3d', stylePreset: 'axon-white' })
check(axonPrompt.includes('【细节处理】') && !axonPrompt.includes('【五金细节】'), '轴测风格同样走【细节处理】')
const dgPrompt = composePrompt({ taskMode: 'diagram', stylePreset: 'dg-bold' })
check(dgPrompt.includes('【细节处理】') && !dgPrompt.includes('【五金细节】'), '分析图风格同样走【细节处理】')
const cabPrompt = composePrompt({ taskMode: 'elevation', stylePreset: 'cream' })
check(cabPrompt.includes('【五金细节】'), '家居风格仍然保留【五金细节】')

console.log('\n== 17. 穷举：任何操作 × 任何风格的提示词都不许出现占位符 ==')
// 这一条是踩坑换来的：新增风格组时漏了 light 字段，提示词里就出现了
// 字面量「【光影】undefined」并被真的发给了模型。
let composed = 0
const bad = []
for (const mode of TASK_MODES) {
  for (const style of stylesOf(mode.id)) {
    for (const [task, options] of [
      ['完整', { referenceCount: 1 }],
      ['限长', { referenceCount: 2, budget: 300 }],
      ['改图', { referenceCount: 1, instruction: '柜门换成浅色木纹' }],
    ]) {
      const prompt = composePrompt({ taskMode: mode.id, stylePreset: style.id, structure: '左 200 通高侧板', ...options })
      composed += 1
      if (/undefined|\bnull\b|\{refs\}|\{/.test(prompt)) {
        bad.push(`${mode.id}/${style.id}/${task}`)
      }
      if (/\n\s*\n/.test(prompt) || prompt.split('\n').some((line) => line.endsWith('】'))) {
        bad.push(`${mode.id}/${style.id}/${task} 有空段`)
      }
    }
  }
}
const expectedCombos =
  TASK_MODES.reduce((sum, mode) => sum + stylesOf(mode.id).length, 0) * 3
check(composed === expectedCombos, `穷举了全部组合（${composed} 组，期望 ${expectedCombos}）`)
check(bad.length === 0, `没有占位符残留或空段（问题：${bad.slice(0, 5).join(' / ') || '无'}）`)
check(
  !composePrompt({ taskMode: 'plan', stylePreset: 'flat-lux' }).includes('undefined'),
  '缺 light 字段时会回落到默认光照描述',
)

console.log('\n== 18. 画质段按风格组切换（彩平图变丑的根因） ==')
// 摄影语言（「木纹毛孔」「浅景深背景虚化」「专业室内建筑摄影」）原先被所有操作
// 共用，结果彩平图被渲染成照片感的灰白俯视图 —— 提示词在要照片，模型就给照片。
const PHOTO_PHRASES = ['专业室内建筑摄影', '浅景深、背景轻微虚化', '木纹的走向与毛孔']
const hasPhotoLanguage = (text) => PHOTO_PHRASES.some((phrase) => text.includes(phrase))
const flatSoft = composePrompt({ taskMode: 'plan', stylePreset: 'flat-soft' })
check(!hasPhotoLanguage(flatSoft), '彩平图提示词不含摄影语言')
check(flatSoft.includes('矢量级清晰度'), '彩平图改用图形类画质段')
check(flatSoft.includes('无摄影景深与背景虚化'), '图形类画质段明确否定景深')
const dgMinimal = composePrompt({ taskMode: 'diagram', stylePreset: 'dg-minimal' })
check(!hasPhotoLanguage(dgMinimal) && dgMinimal.includes('矢量级清晰度'), '分析图同样用图形类画质段')
const axonReal = composePrompt({ taskMode: 'plan-3d', stylePreset: 'axon-real' })
check(
  !hasPhotoLanguage(axonReal) && axonReal.includes('形体转折与剖切面明确'),
  '轴测图用「形体清晰、材质简化」的中间档',
)
check(hasPhotoLanguage(cabPrompt), '立面渲染保留摄影类画质段（柜体要照片级真实感）')

console.log('\n== 19. 彩平图必须带制图规范（否则门窗只剩洞、家具只剩方块） ==')
for (const style of stylesOf('plan')) {
  const prompt = composePrompt({ taskMode: 'plan', stylePreset: style.id })
  check(prompt.includes('正投影'), `${style.label}：写明正投影俯视`)
  check(
    /平涂|实心/.test(prompt) && /不画|无材质纹理|不出现立体透视/.test(prompt),
    `${style.label}：写明平涂/实心且不画纹理`,
  )
  check(prompt.includes('【制图符号】'), `${style.label}：注入【制图符号】段`)
  check(!hasPhotoLanguage(prompt), `${style.label}：不含摄影语言`)
}
const symbolPrompt = composePrompt({ taskMode: 'plan', stylePreset: 'flat-soft' })
check(symbolPrompt.includes('3 条平行'), '制图符号写明窗=横跨墙厚的平行细线')
check(symbolPrompt.includes('门扇') && symbolPrompt.includes('弧线'), '制图符号写明平开门=门扇线+开启弧线')
check(symbolPrompt.includes('推拉门'), '制图符号写明推拉门')
check(symbolPrompt.includes('靠背') && symbolPrompt.includes('扶手'), '制图符号写明沙发要有靠背与扶手')
check(symbolPrompt.includes('坐垫'), '制图符号写明沙发坐垫分缝')
check(symbolPrompt.includes('枕头') && symbolPrompt.includes('被面'), '制图符号写明床要有枕头与被面翻折')
check(symbolPrompt.includes('水箱') && symbolPrompt.includes('台盆'), '制图符号写明洁具画法')
check(symbolPrompt.includes('地毯') && symbolPrompt.includes('绿植'), '制图符号写明地毯与绿植点缀')
check(
  symbolPrompt.includes('图形表达') && symbolPrompt.includes('重绘'),
  '结构锁死允许「位置不变但按符号重绘」，避免模型照抄方块',
)
check(
  composePrompt({ taskMode: 'plan', stylePreset: 'flat-soft' }).includes('墙体用深灰实心填充'),
  '柔光彩平写明墙体深灰实心填充（poché）',
)
check(
  composePrompt({ taskMode: 'plan', stylePreset: 'flat-color' }).includes('按房间功能区分地面色块'),
  '分色彩平写明按房间功能分色',
)
check(
  !composePrompt({ taskMode: 'plan-3d', stylePreset: 'axon-white' }).includes('【制图符号】'),
  '轴测图不该套用彩平的制图符号段',
)
check(
  !composePrompt({ taskMode: 'diagram', stylePreset: 'dg-flat' }).includes('【制图符号】'),
  '分析图不该套用彩平的制图符号段',
)

console.log('\n== 20. 彩平专属负向词 ==')
check(composeNegative('', resolveStyle('flat-soft')).includes('实景俯拍'), '彩平负向词含「实景俯拍」')
check(composeNegative('', resolveStyle('flat-soft')).includes('三维透视'), '彩平负向词含「三维透视」')
check(!composeNegative('', resolveStyle('cream')).includes('实景俯拍'), '家居风格不带彩平负向词')
check(composeNegative('自定义词', resolveStyle('cream')).includes('自定义词'), '用户自定义负向词仍会拼上')

console.log('\n== 21. 菜单与功能对应（用户反馈「换视角下面还是选风格」） ==')
// 不该选风格的操作：「换视角」要同空间换机位、「风格迁移」的风格来自参考图。
check(styleIsFixedToBase('view-switch'), '换视角不选风格（只有「沿用底图」）')
check(styleIsFixedToBase('style-transfer'), '风格迁移不选风格（风格来自参考图）')
check(!styleIsFixedToBase('elevation'), '立面渲染仍然要选风格')
check(stylesOf('view-switch').map((style) => style.id).join() === 'as-is', '换视角只给「沿用底图」')
check(stylesOf('photo')[0].id === 'as-is', '照片优化把「沿用底图」排在第一个（默认保持原样）')
check(stylesOf('photo').some((style) => style.group === 'interior'), '照片优化也允许主动改造风格')
const viewSwitch = composePrompt({ taskMode: 'view-switch', stylePreset: 'as-is' })
check(viewSwitch.includes('材质、颜色与表面工艺完全沿用图1'), '换视角提示词写明沿用底图材质')
check(!/奶油|轻奢|极简纯白|香槟金|彩平|轴测/.test(viewSwitch), '换视角提示词没有混进任何风格材质')
const transfer = composePrompt({ taskMode: 'style-transfer', stylePreset: 'as-is', referenceCount: 1 })
check(transfer.includes('完全参照图2'), '风格迁移的材质完全来自参考图')

console.log('\n== 22. 控件按操作显示（不该出现的菜单就得藏起来） ==')
const uiExpect = [
  ['elevation', { lighting: true, camera: true, read: true, qc: true }],
  ['plan', { lighting: false, camera: false, read: true, qc: true }],
  ['plan-3d', { lighting: false, camera: false, read: true, qc: true }],
  ['diagram', { lighting: false, camera: false, read: true, qc: true }],
  // 换视角的机位面板就是这个操作的核心控件，所以构图必须是开的
  ['view-switch', { lighting: true, camera: true, read: true, qc: true }],
  ['photo', { lighting: true, camera: false, read: true, qc: true }],
  ['text2img', { lighting: true, camera: true, read: false, qc: false }],
]
for (const [mode, want] of uiExpect) {
  const ui = uiOf(mode)
  const ok = Object.entries(want).every(([key, value]) => ui[key] === value)
  check(
    ok,
    `${mode} 控件可见性（光影${want.lighting ? '开' : '关'} / 构图${want.camera ? '开' : '关'} / 读图${want.read ? '开' : '关'} / 质检${want.qc ? '开' : '关'}）`,
  )
}
check(uiOf('unknown-mode').lighting === true, '未知操作默认全开（不会把控件藏没了）')

console.log('\n== 23. 质检判据随操作切换 ==')
check(
  qcSystem('elevation').includes('分格数量') && qcSystem('elevation').includes('门板与抽屉'),
  '柜体操作查分格与门板',
)
check(
  qcSystem('plan').includes('墙体位置') && qcSystem('plan').includes('有没有丢失任何一件家具'),
  '平面图查墙体与家具缺件',
)
check(qcSystem('plan-3d').includes('同一个户型'), '轴测查是否同一户型')
check(qcSystem('diagram').includes('分析元素'), '分析图查是否只叠加了分析元素')
check(!qcSystem('plan').includes('门板与抽屉'), '平面图的质检判据里不该出现柜体的「门板与抽屉」')

console.log('\n== 25. 出图比例（用户可以自己选） ==')
check(RATIO_PRESETS.length === 8, `比例预设 8 个（实为 ${RATIO_PRESETS.length}）`)
check(RATIO_PRESETS[0].id === 'follow', '第一个是「跟随底图」（默认）')
check(resolveRatio('follow') === undefined, 'follow 解析为「不指定比例」')
check(resolveRatio('nope') === undefined, '未知比例解析为「跟随底图」，不会报错')
check(
  RATIO_PRESETS.filter((item) => item.id !== 'follow').every((item) => item.w > 0 && item.h > 0),
  '每个固定比例都有正的 w/h',
)
for (const [id, want] of [
  ['1:1', 1],
  ['3:2', 1.5],
  ['2:3', 2 / 3],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
]) {
  const size = sizeFromRatio(resolveRatio(id), 2048)
  const actual = size.width / size.height
  check(Math.abs(actual - want) < 0.03, `${id} 像素比例正确（${size.width}x${size.height} = ${actual.toFixed(2)}）`)
}
check(sizeFromRatio(undefined, 2048) === null, '不指定比例时返回 null（交给跟随底图）')
check(
  [sizeFromRatio(resolveRatio('16:9'), 2048), sizeFromRatio(resolveRatio('9:16'), 2048)].every(
    (size) =>
      size.width >= 512 &&
      size.width <= 2048 &&
      size.height >= 512 &&
      size.height <= 2048 &&
      size.width % 16 === 0 &&
      size.height % 16 === 0,
  ),
  '尺寸落在 [512,2048] 且都是 16 的倍数',
)

console.log('\n== 26. 图纸规定压住风格模板（材质颜色五金看图纸，不看模板） ==')
// 反馈：「基础提示词不该是不变的，特别是材质颜色和五金细节，应该根据底图来」。
const drawingSpec = '6. 材质与颜色：门板为白色亚克力，台面为黑色岩板\n7. 五金与细节：明装黑色长拉手'
const withDrawing = composePrompt({
  taskMode: 'elevation',
  stylePreset: 'cream',
  lighting: 'auto',
  referenceCount: 0,
  structure: drawingSpec,
})
check(withDrawing.includes('【图纸规定'), '读图结果作为【图纸规定】进入框架')
check(withDrawing.includes('白色亚克力'), '图纸写的材质进了框架')
check(withDrawing.includes('明装黑色长拉手'), '图纸写的五金进了框架')
check(/【材质色彩】[^\n]*以【图纸规定】为准/.test(withDrawing), '材质段明确以【图纸规定】为准（不再是模板说了算）')
check(/【五金细节】[^\n]*以【图纸规定】为准/.test(withDrawing), '五金段明确以【图纸规定】为准')
// 反馈：「经常改结构和材质」。根因之一是两套材质同时出现，模型二选一。
// 图纸写了材质时，风格模板的材质原文必须**整段不再出现**。
check(!withDrawing.includes('奶油白与米杏色哑光烤漆'), '图纸写了材质时，风格模板的材质原文不再出现（否则两套材质打架）')
check(!withDrawing.includes('香槟金或奶白'), '图纸写了五金时，风格模板的拉手原文也不再出现')
check(withDrawing.includes('风格预设只体现在光影、氛围与陈设上'), '风格降级为「只管光影氛围陈设」，不再争材质')
check(withDrawing.includes('以图1画面为准'), '声明图1画面优先于文字清单（读错了也不至于照错的画）')
check(withDrawing.includes('不要用风格模板里的常见做法替换它'), '明确禁止用风格模板顶掉图纸做法')

// 画布比例与底图不一致时，必须禁止「为了填满画布而重排结构」
const canvasMismatch = composePrompt({
  taskMode: 'elevation',
  stylePreset: 'cream',
  lighting: 'auto',
  referenceCount: 0,
  canvasAr: 1,
  baseAr: 272 / 437,
})
check(canvasMismatch.includes('【画布与主体】'), '画布比例与底图不一致时加了【画布与主体】护栏')
check(
  canvasMismatch.includes('为了填满画布而横向拉伸') && canvasMismatch.includes('重新排布'),
  '护栏明确禁止拉伸与重排结构',
)
check(/相差约 \d+%/.test(canvasMismatch), '护栏里带上了具体偏差百分比')
const canvasSame = composePrompt({
  taskMode: 'elevation',
  stylePreset: 'cream',
  lighting: 'auto',
  referenceCount: 0,
  canvasAr: 0.625,
  baseAr: 272 / 437,
})
check(!canvasSame.includes('【画布与主体】'), '比例一致时不加多余护栏（不给模型添乱）')

console.log('\n== 27. 质检自动重出不能丢框架（否则会把漂移固化） ==')
// 反馈：「最近几轮经常改结构和材质」。根因之一：质检重出走的是「改图」分支，
// 那个分支不注入【图纸规定】，还说「其余一律沿用图1(上一版)」——
// 第一版漂移就被锁死了。现在必须始终以原始图纸为基准。
const qcPrompt = composePrompt({
  taskMode: 'elevation',
  stylePreset: 'cream',
  lighting: 'auto',
  referenceCount: 1,
  structure: drawingSpec,
  qcFix: '左下角少了一道横板，右侧分格偏宽',
})
check(qcPrompt.includes('【质检修正（必须执行）】'), '有【质检修正】段')
check(qcPrompt.includes('左下角少了一道横板'), '质检意见进了提示词')
check(qcPrompt.includes('【结构锁死】'), '质检重出仍然带结构锁死')
check(qcPrompt.includes('【图纸规定'), '质检重出仍然带【图纸规定】（图纸材质不会丢）')
check(qcPrompt.includes('【材质色彩】'), '质检重出仍然带材质段')
check(qcPrompt.includes('【视角构图】'), '质检重出仍然带视角段')
check(qcPrompt.includes('白色亚克力'), '质检重出仍然带图纸材质原文')
check(!qcPrompt.includes('在图1这张已有效果图的基础上做定向修改'), '质检重出不走「改图」分支（那是给用户手动迭代用的）')
check(
  qcPrompt.includes('不要因为这次修正而改动没被点名的任何东西'),
  '明确要求只改点名的问题，其余不动',
)
// 用户在结果上手点「改这张」时，仍然走改图分支（那条路径是对的：图1=上一版效果图）
const refinePrompt = composePrompt({
  taskMode: 'elevation',
  stylePreset: 'cream',
  lighting: 'auto',
  referenceCount: 1,
  instruction: '门板换成木纹',
})
check(
  refinePrompt.includes('在图1这张已有效果图的基础上做定向修改'),
  '手动迭代改图仍走「改图」分支（图1=上一版，语义正确）',
)

// 没读图时退回原来行为（结构仍在，材质用风格模板）
const noDrawing = composePrompt({ taskMode: 'elevation', stylePreset: 'cream', lighting: 'auto', referenceCount: 0 })
check(!noDrawing.includes('【图纸规定'), '没读图时不出现【图纸规定】段')
check(/【材质色彩】[^\n]*哑光烤漆/.test(noDrawing), '没读图时材质仍走风格模板（保证有输出）')
check(!noDrawing.includes('以【图纸规定】为准'), '没读图时不会指向一个不存在的图纸规定')

// 有参考图时：图纸管「种类/形式」，参考图管「观感」
const withBoth = composePrompt({
  taskMode: 'elevation',
  stylePreset: 'cream',
  lighting: 'auto',
  referenceCount: 1,
  structure: drawingSpec,
})
check(
  /材料种类、颜色与五金形式以【图纸规定】为准；具体纹理、光泽与色感以图2为准/.test(withBoth),
  '图纸与参考图分工明确（图纸管种类，参考图管观感）',
)

// 读图提示词必须要求读材质与五金
check(cadReaderSystem('elevation').includes('材质与颜色'), '读图提示词要求读出材质与颜色')
check(cadReaderSystem('elevation').includes('五金'), '读图提示词要求读出五金')
check(
  cadReaderSystem('elevation').includes('不要编造尺寸、数量、材质或五金'),
  '读图提示词明确禁止编造材质五金',
)

console.log('\n== 28. 结构不许改：首尾强化 + 负向词 ==')
// 反馈：「不光比例，把原图结构都改了」。模型把施工图当成了设计委托，
// 顺手把分格「美化」了。对策：开头点明任务性质（首因）、结尾给自检动作（近因）。
const locked = composePrompt({ taskMode: 'elevation', stylePreset: 'cream', lighting: 'auto', referenceCount: 1 })
const firstLine = locked.split('\n')[0]
check(firstLine.includes('施工图') && firstLine.includes('不是重新设计'), '首句点明「这是施工图，不是重新设计」')
check(locked.includes('不是重新设计'), '任务性质写在最前面（首因效应）')
check(locked.includes('【交付前自检】'), '结尾有【交付前自检】段（近因效应）')
check(
  locked.includes('分格的栏数与每栏宽度比例') && locked.includes('不要美化、不要对称化、不要简化'),
  '自检段给出了可执行的核对项',
)
check(locked.trim().endsWith('不要美化、不要对称化、不要简化。**'), '自检段确实在最后（末尾位置才有效）')
check(
  /【空间环境】[^\n]*绝不能因此改变主体的构图、分格或比例/.test(locked),
  '空间环境段不许它牵着主体走（背景只是背景）',
)
const negative = composeNegative('', null)
for (const term of ['重新设计', '分格错位', '对称化', '简化结构', '比例拉伸']) {
  check(negative.includes(term), `负向词里有结构漂移的具象说法「${term}」`)
}
// 手动改图分支不该带自检段（那条路径的图1是上一版效果图，语义不同）
const manual = composePrompt({ taskMode: 'elevation', stylePreset: 'cream', referenceCount: 1, instruction: '换成木纹' })
check(!manual.includes('【交付前自检】'), '手动改图分支不带交付自检段')
check(!manual.includes('不是重新设计'), '手动改图分支不带任务性质首句')
// 文生图没有图1，也不该带
const text2img = composePrompt({ taskMode: 'text2img', stylePreset: 'cream', referenceCount: 0 })
check(!text2img.includes('【交付前自检】'), '文生图没有底图，不带自检段')

console.log('\n== 24. 负向提示词 ==')
check(NEGATIVE_PROMPT.includes('结构改变') && NEGATIVE_PROMPT.includes('尺寸标注'), '内置负向词含关键项')
check(composeNegative('紫红色') === `${NEGATIVE_PROMPT}, 紫红色`, '自定义负向词追加在末尾')
check(composeNegative('') === NEGATIVE_PROMPT, '空的自定义负向词不产生多余逗号')

console.log(failures === 0 ? '\nPRESETS TEST PASSED' : `\nPRESETS TEST FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
