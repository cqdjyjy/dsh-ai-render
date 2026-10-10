/**
 * 效果图预设库与提示词组装器。
 *
 * 结构学自 Evai建筑大师（openevai.com）「提示词大师」的专业话术范例与
 * 建筑学长AI（jianzhuxuezhang.com）按用途分智能体的功能划分：
 *
 *   1. 任务帧   —— 这张图要做什么（立面渲染 / 实拍优化 / 线稿白模）
 *   2. 结构锁死 —— 先把不可改的东西钉死，这是效果图能不能用的前提
 *   3. 视角构图 —— 一点透视、机位与图1一致
 *   4. 材质色彩 —— 风格预设的具体材料名与表面工艺
 *   5. 五金细节 —— 缝隙、收口、拉手
 *   6. 空间环境 —— 墙面、地面、留白
 *   7. 光影
 *   8. 画质
 *   9. 清除施工图元素
 *  10. 补充要求 —— 用户自己的话
 *
 * 各段文案为本人按该结构重写，非照搬上述站点原文。
 *
 * @module @local/dsh-ai-render/presets
 */

/** 这些操作画面里不一定有门板/台面，材质描述要按「对应位置的构件」去理解。 */
const GENERIC_MATERIAL_MODES = new Set(['text2img', 'plan', 'plan-3d', 'plan-perspective', 'diagram', 'view-switch'])

/** 任务模式：按「底图是什么」分。底图不一定是柜体立面，也可能是模型截图或平面图。 */
const TASK_MODES = [
  {
    id: 'elevation',
    label: '立面 / 施工图',
    hint: 'CAD 立面、施工图、节点图 → 实景效果图，结构严格不变',
    frame: '把图1的立面施工图渲染成照片级写实的实景效果图。',
    frameShort: '把图1的立面施工图渲染成写实实景效果图。',
    structure:
      '严格保持图1的几何关系不变：整体轮廓与长宽比例、分格结构、门板/抽屉/开放格的数量与位置、每一条分割线，一律不得增删、合并或改动。若无特别说明，图1中同类构件与同一立面必须保持相同材质与色彩，严禁擅自拼色或随意替换材质。',
    structureShort: '严格保持图1的轮廓、长宽比例、分格结构与构件数量位置不变，同类构件材质色彩统一，不得增删任何结构。',
    view: '正面平视（一点透视），相机高度与中线齐平，画面无透视畸变，构图与图1完全一致。',
    viewShort: '正面平视（一点透视），构图与图1完全一致。',
    cleanup:
      '彻底清除所有施工图元素：尺寸线、尺寸数字、文字标注、引线、剖面线、填充图案、图框与辅助线；画面中不得出现任何蓝图线条或工程图样。',
    cleanupShort: '清除所有尺寸线、数字、文字标注、引线、图框与辅助线。',
  },
  {
    id: 'sketch',
    label: '手绘线稿',
    hint: '手绘稿、线稿、白模截图 → 上材质出图',
    frame: '把图1的线稿渲染成照片级写实的实景效果图。',
    frameShort: '把图1的线稿渲染成写实实景效果图。',
    structure: '严格保持图1的几何轮廓与分格关系不变，不得增删结构、线条或开口。',
    structureShort: '严格保持图1的几何轮廓与分格关系不变。',
    view: '正面平视（一点透视），构图与图1一致，画面无畸变。',
    viewShort: '正面平视（一点透视），构图与图1一致。',
    cleanup: '清除全部线稿线条、辅助线与标注，只保留真实的材质与光影。',
    cleanupShort: '清除全部线稿线条与标注。',
  },
  {
    id: 'model',
    label: '模型图',
    hint: 'SU / 3D 模型截图、素模、白模 → 一键出效果图（保持机位与透视）',
    frame: '把图1的模型截图渲染成照片级写实的实景效果图。',
    frameShort: '把图1的模型截图渲染成写实实景效果图。',
    structure:
      '严格保持图1的体块关系与机位不变：体量轮廓、各面转折、开口与洞口位置、层数与比例，一律不得增删或改动。',
    structureShort: '严格保持图1的体量、开口位置、层数与比例不变。',
    view: '完全保持图1的机位、透视与构图不变，只从材质与光照层面提升，不要改变视角。',
    viewShort: '保持图1的机位与透视不变。',
    cleanup: '去除模型截图中的辅助线、网格、坐标轴、安全框与界面元素。',
    cleanupShort: '去除辅助线、网格、坐标轴与界面元素。',
  },
  {
    // 洗图：把「已经定稿的图」再喂回模型做一次高清重绘。
    //
    // 真 DLSS 是 GPU 超分，插件跑不了；这里是用图像模型做等价的事 ——
    // 低改动力度地重画一遍：去噪、去压缩伪影、修复边缘、还原材质细节。
    // 关键约束：**内容一律不动**。洗图失败最典型的样子就是「趁机重新设计」，
    // 所以 structure 段写得比别的模式更死。
    id: 'wash',
    label: '洗图 / 高清',
    hint: '把已出的效果图、成品图或网络图再洗一遍：去噪、去伪影、提清晰度与材质细节，构图与内容一律不动',
    frame: '把图1当成一张**已经定稿的成品图**，你的任务只是提升它的画质与细节，不是重做它。',
    frameShort: '把图1当成定稿成品图做高清重绘，只提画质不重做。',
    structure:
      '图1的一切内容必须**原样保留**：构图与视角、主体轮廓与长宽比例、分格结构、构件与五金的数量位置、材质与颜色、光影方向与明暗关系、背景元素，一律不得增删、移动、置换或重新设计。你只能改变「清晰度与细节表现」，不能改变「画的是什么」。若某处看不清，按合理的物理与材质逻辑补全细节，但不得改变它在原图中的形状、位置与颜色。',
    structureShort: '图1的构图、结构、材质、光影与配色必须 100% 原样保留，只提升清晰度与细节，不得重新设计。',
    view: '完全保持图1的机位、透视、焦段与构图不变，不要换角度、不要重新取景、不要裁切。',
    viewShort: '完全保持图1的机位、透视与构图不变。',
    cleanup:
      '清除放大与压缩留下的痕迹：噪点、色带、块状伪影、锯齿、摩尔纹、涂抹感、过度锐化的白边与光晕；同时消除 AI 生成常见的塑料感与糊面，让画面看起来像高分辨率原生渲染，而不是被放大过的图。',
    cleanupShort: '清除噪点、色带、块状伪影、锯齿、摩尔纹与过度锐化的光晕。',
  },
  {
    // 本地 GPU 超分（用户叫它「DLSS5 洗图」）。
    //
    // 这个操作**不走任何云通道**：宿主编直接用本机的 Real-ESRGAN ncnn Vulkan
    // 跑 GPU 超分，不联网、不花钱、也不需要 API Key —— 是这里唯一一个
    // 「运算全在本机完成」的操作。所以 ui 里把风格 / 光影 / 构图 / 读图 / 质检
    // 全关掉：超分不改画面内容，摆这些选择器只会误导。
    //
    // frame / structure 这些字段在本地路径下用不到，但保留一份合理文案：
    // 万一被当云操作调用（老面板、或用户手写命令），也不会组装出一个空提示词。
    id: 'superres',
    label: '本地超分',
    hint:
      '用本机 GPU（Real-ESRGAN Vulkan）把图放大并洗一遍：免 Key、不联网、不花钱。' +
      '需要一块能跑 Vulkan 的显卡；跑不动时会明确报错，不会给你一张废图',
    local: true,
    frame: '把图1无损放大并提升清晰度，画面内容一律不动。',
    frameShort: '把图1无损放大并提升清晰度。',
    structure:
      '图1的一切内容必须原样保留：构图与视角、轮廓与长宽比例、分格结构、构件数量位置、材质与颜色、光影关系，一律不得增删或重新设计，只提升分辨率与细节清晰度。',
    structureShort: '图1的构图、结构、材质、光影与配色必须 100% 原样保留，只提升分辨率。',
    view: '完全保持图1的机位、透视与构图不变，不换角度、不重新取景、不裁切。',
    viewShort: '完全保持图1的机位、透视与构图不变。',
    cleanup: '清除放大带来的噪点、振铃与过度锐化的白边，保持自然的细节过渡。',
    cleanupShort: '清除噪点、振铃与过度锐化的白边。',
  },
  {
    id: 'photo',
    label: '实拍照片',
    hint: '现场实拍照片 → 材质升级、去杂乱、提升画质',
    frame: '把图1这张实拍照片优化成专业级写实效果图。',
    frameShort: '把图1这张实拍照片优化成专业效果图。',
    structure: '严格保持图1的空间关系不变：不得改变主体数量、开启方向、层板位置、墙体与整体比例。',
    structureShort: '严格保持图1的空间关系不变，不得改变主体数量与整体比例。',
    view: '保持图1的机位、视角与构图不变，只从画质与材质层面提升。',
    viewShort: '保持图1的机位与构图不变。',
    cleanup: '去除画面中的杂物、临时物品、拍摄反光与瑕疵，画面干净整洁、无文字无水印。',
    cleanupShort: '去除杂物、反光与拍摄瑕疵。',
  },
  {
    id: 'plan',
    label: '平面图',
    hint: '平面布置图 / 户型图 → 专业彩色平面图（彩平图）',
    frame: '把图1的平面布置图渲染成一张专业的彩色平面图（彩平图）。',
    frameShort: '把图1的平面布置图渲染成专业彩色平面图。',
    structure:
      '严格保持图1的墙位、房间划分、门窗洞口的位置与宽度、家具的种类与摆放位置不变，不得增删或移动任何墙体、门窗或家具。注意：家具与门窗的「位置、朝向、种类、数量」必须不变，但它们的「图形表达」要按制图规范重绘成标准的俯视符号，不要照抄原图上的简单方块。',
    structureShort: '严格保持图1的墙位、房间划分、门窗洞口与家具的种类和位置不变，但按标准俯视符号重绘家具与门窗。',
    view: '正上方垂直俯视（正投影），画面无透视变形，构图与图1完全一致。',
    viewShort: '正上方垂直俯视（正投影），构图与图1一致。',
    cleanup: '清除图1中的尺寸标注、尺寸数字、引线、图例与图框；画面中不得出现任何文字、数字或工程标注。',
    cleanupShort: '清除尺寸标注、图例、图框与所有文字。',
  },
  {
    id: 'plan-3d',    label: '平面→立体户型',
    hint: '平面图 → 3D 立体户型轴测图（剖切轴测，能看房间关系）',
    frame: '把图1的平面布置图转成一张 3D 立体户型轴测图（剖切轴测鸟瞰）。',
    frameShort: '把图1的平面图转成 3D 立体户型轴测图。',
    structure:
      '严格保持图1的墙位、房间划分、门窗洞口与家具位置不变，只是把它立起来做成轴测投影，不得增删或移动任何墙体与家具。',
    structureShort: '严格保持图1的墙位、房间划分与家具布置不变，只做轴测立体化。',
    view: '45° 等轴测俯视（轴测投影，不带透视收缩），墙体按规定高度剖切，能看到各房间内部布置。',
    viewShort: '45° 等轴测俯视，墙体剖切，可见房间内部。',
    cleanup: '清除图1中的尺寸标注、尺寸数字、引线、图例与图框；画面中不得出现任何文字、数字或工程标注。',
    cleanupShort: '清除尺寸标注、图例、图框与所有文字。',
  },
  {
    id: 'plan-perspective',
    label: '平面→透视效果图',
    hint: '平面布置图 → 人眼视角的室内实拍效果图',
    frame: '根据图1的平面布置图，生成这张户型主要空间的室内实景效果图（人眼视角）。',
    frameShort: '按图1的平面布置生成室内实景效果图。',
    structure:
      '严格按图1的墙位、空间尺寸、门窗位置与家具布置生成，空间比例与进深关系必须与图1一致。',
    structureShort: '严格按图1的墙位、尺寸与家具布置生成，比例一致。',
    view: '人眼高度（约 1.5 米）的平视透视，站在主要房间的入口向室内看，透视自然。',
    viewShort: '人眼高度平视透视，透视自然。',
    cleanup: '画面中不得出现任何平面图元素：家具平面符号、填充图案、尺寸线、文字与图框。',
    cleanupShort: '不得出现家具平面符号、尺寸线、文字与图框。',
  },
  {
    id: 'diagram',
    label: '分析图',
    hint: '把方案转成体块 / 功能 / 流线 / 植物 / 软装等分析图',
    frame: '把图1转成一张专业的设计分析图。',
    frameShort: '把图1转成专业设计分析图。',
    structure:
      '严格保持图1的体块、平面或空间关系不变，只叠加分析图所需的色块、箭头与图例元素，不得改动设计本身。',
    structureShort: '保持图1的设计关系不变，只叠加分析图元素。',
    view: '保持图1原有的视角与构图（平面就平面、透视就透视），不改变看图方式。',
    viewShort: '保持图1的视角与构图。',
    cleanup: '清除图1中的尺寸标注、图框与无关文字；不要在图上写字。',
    cleanupShort: '清除尺寸标注、图框与无关文字。',
  },
  {
    id: 'style-transfer',
    label: '风格迁移',
    hint: '白模 / 线稿 / 素模 + 参考图 → 把参考图的风格搬到你的方案上',
    frame: '把图2的设计风格完整迁移到图1的方案上，输出一张成品效果图。',
    frameShort: '把图2的风格迁移到图1的方案上。',
    structure:
      '严格保持图1的体块、轮廓、分格与开口关系不变，不得改动方案本身，只替换风格与材质表现。',
    structureShort: '严格保持图1的方案不变，只替换风格与材质。',
    view: '保持图1原有的机位与构图不变。',
    viewShort: '保持图1的机位与构图。',
    cleanup: '清除图1中的辅助线、网格、坐标轴与界面元素。',
    cleanupShort: '清除辅助线、网格与界面元素。',
  },
  {
    id: 'view-switch',
    label: '换视角',
    hint: '在同一空间内换到另一个视角（同一空间的其他角度）',
    frame: '根据图1推断同一空间的其他视角，生成同一空间另一个角度的效果图。',
    frameShort: '生成图1同一空间另一角度的效果图。',
    structure:
      '必须与图1是同一个空间：墙体位置、门窗、家具种类与数量、材质与色彩全部保持一致，只是机位不同。',
    structureShort: '必须与图1是同一空间，材质家具一致，只是机位不同。',
    view: '换到另一个合理的机位（例如从侧后方或反打），人眼高度、透视自然。',
    viewShort: '换到另一个机位，人眼高度、透视自然。',
    cleanup: '画面中不得出现任何文字、标注或界面元素。',
    cleanupShort: '不得出现文字与标注。',
  },
  {
    id: 'text2img',
    label: '文生图 / 灵感图',
    hint: '不需要底图，直接按描述生成灵感意象图（可带参考图定风格）',
    noBase: true,
    frame: '按下面的描述生成一张专业级的设计效果图。',
    frameShort: '按描述生成设计效果图。',
    structure: '画面内容严格按描述来，各元素的种类、数量与相对位置都要对得上描述。',
    structureShort: '画面内容严格按描述来。',
    view: '选一个最能表达该描述的角度，透视自然、构图完整。',
    viewShort: '角度自然、构图完整。',
    cleanup: '画面中不得出现任何文字、标注、水印或界面元素。',
    cleanupShort: '不得出现文字、水印或界面元素。',
  },
]

/**
 * 分析图类型：只在「分析图」操作下显示，作为额外的一段注入提示词。
 */
const DIAGRAM_TYPES = [
  {
    id: 'mass',
    label: '体块分析',
    hint: '用体块与体量关系说明方案',
    prompt: '分析图类型：体块分析。用简洁的体块色块区分不同体量与层数关系，配少量尺寸标注线感，弱化材质细节，突出形体逻辑。',
  },
  {
    id: 'function',
    label: '功能分区',
    hint: '用色块区分功能分区',
    prompt: '分析图类型：功能分区。用不同颜色的半透明色块区分各功能区，色块边缘清晰，配图例位置，弱化材质与光影。',
  },
  {
    id: 'circulation',
    label: '流线分析',
    hint: '用箭头说明人流/动线',
    prompt: '分析图类型：流线分析。用清晰的箭头与路径线表示主要流线走向，箭头粗细区分主次动线，画面干净、对比明确。',
  },
  {
    id: 'planting',
    label: '植物配置',
    hint: '标注植物品种与位置',
    prompt: '分析图类型：植物配置。用图形化的树冠符号与色块标注不同植物品种与位置关系，风格简洁、色系统一。',
  },
  {
    id: 'furniture',
    label: '软装搭配',
    hint: '拆解软装与家具配置',
    prompt: '分析图类型：软装搭配。把画面中的家具与软装拆解成简洁的图形化表达，配以材质色卡式的色块，风格干净、排版感强。',
  },
]

/**
 * 结果上的一键操作：在已出的效果图上做定向修改，复用「改这张」通道。
 * 对应竞品功能墙里的「光影调整」「氛围优化」「材质替换」「视角转换」等。
 */
const QUICK_ACTIONS = [
  {
    id: 'light-day',
    label: '换日光',
    hint: '改成明亮自然日光',
    instruction: '把这张图的光影改成明亮的自然日光：侧窗进光、明暗交界清晰、投影柔和；主体结构、材质与构图完全不动。',
    group: '光影',
  },
  {
    id: 'light-dusk',
    label: '换黄昏',
    hint: '改成黄昏暖光',
    instruction: '把这张图的光影改成黄昏暖光：低角度斜射、色温约 2800K、投影拉长；主体结构、材质与构图完全不动。',
    group: '光影',
  },
  {
    id: 'light-night',
    label: '换夜景',
    hint: '改成夜间氛围灯',
    instruction: '把这张图改成夜间氛围：内部线性藏灯与射灯为主光、环境压暗、明暗对比强；主体结构、材质与构图完全不动。',
    group: '光影',
  },
  {
    id: 'light-studio',
    label: '影棚光',
    hint: '干净均匀的产品级布光',
    instruction: '把这张图改成影棚布光：大面积柔光、阴影极浅、背景干净；主体结构、材质与构图完全不动。',
    group: '光影',
  },
  {
    id: 'mood-warm',
    label: '氛围更暖',
    hint: '整体色调更暖更柔和',
    instruction: '把整体氛围调得更暖更柔和：色温偏暖、对比降低、材质光泽更柔；主体结构、材质种类与构图完全不动。',
    group: '氛围',
  },
  {
    id: 'material-ref',
    label: '按参考图换材质',
    hint: '把材质换成参考图里的材质',
    instruction: '把主体表面的材质换成参考图里的材质与颜色，其余部分（结构、分格、五金位置、机位）完全不动。',
    group: '材质',
    needsReference: true,
  },
  {
    id: 'view-3q',
    label: '换 3/4 视角',
    hint: '改成 3/4 侧视角',
    instruction: '把机位改成 3/4 侧视角，能看到主体正面与侧面；主体结构、材质与配色完全不动。',
    group: '视角',
  },
  {
    id: 'clean-up',
    label: '只清杂物',
    hint: '去掉杂物与瑕疵，别的都不动',
    instruction: '只清除画面里的杂物、临时物品与拍摄瑕疵，其余一切（结构、材质、光影、构图）完全不动。',
    group: '清理',
  },
]

/**
 * 家居风格预设（室内与家具空间用）。每个预设给出：
 * 材料与表面工艺、五金、空间环境、氛围；光影另由 LIGHTING_PRESETS 负责。
 * 参考图存在时，材质以参考图为准，预设作为风格方向。
 */
const INTERIOR_STYLES = [
  {
    id: 'modern',
    label: '现代简约',
    hint: '哑光肤感，利落克制',
    material:
      '门板为现代极简哑光肤感饰面板，表面无杂乱木纹，仅有极细的哑光肌理；若无特别说明，原图同一构件保持同色统一，严禁擅自拼色；台面为深灰细砂石英石；背板与主体同色。',
    hardware: '免拉手或极窄隐藏拉手，金属配件为哑光黑或拉丝镍。',
    metal: '金属件为哑光黑或拉丝镍。',
    scene: '背景为素色乳胶漆墙面与浅灰微水泥地面，画面干净留白。',
    light: '柔和的自然漫射光自左前方进入，饰面呈均匀哑光反射，投影柔和、层次分明。',
    mood: '整洁、克制、当代都市质感。',
  },
  {
    id: 'cream',
    label: '奶油风',
    hint: '奶油白哑光 + 微水泥，柔和蓬松',
    material:
      '门板为奶油白哑光烤漆，边角做小圆弧过渡，表面细腻无纹理；若无特别说明，原图同一构件保持同色统一，严禁擅自拼色；台面为同色系浅色岩板；内部可见暖白层板。',
    hardware: '同色系细长拉手或全隐藏式免拉手，金属件为香槟金或奶白。',
    metal: '金属件为香槟金或奶白。',
    scene: '背景为奶油色墙面与浅米色微水泥地面，配少量棉麻织物与绿植点缀。',
    light: '大面积柔和漫射光，色温偏暖（约3000K），无明显硬阴影，整体透着柔光。',
    mood: '柔软、蓬松、温暖治愈。',
  },
  {
    id: 'wood',
    label: '原木日式',
    hint: '白橡直纹 + 米白，自然温润',
    material:
      '门板为白橡木直纹木饰面，哑光清漆封边，木纹清晰连续且拼接对纹；内部为米白饰面；台面为浅色橡木或米白岩板。',
    hardware: '细长原木或哑光黑拉手，金属件尽量克制不外露。',
    metal: '金属件尽量克制不外露。',
    scene: '背景为米白乳胶漆墙面与浅色木地板，光线通透，陈设简单。',
    light: '清晨自然侧光透过窗纱洒入，木纹在斜射光下呈现温润的光泽与细腻的明暗过渡。',
    mood: '自然、宁静、东方生活感。',
  },
  {
    id: 'white',
    label: '极简纯白',
    hint: '纯白哑光 + 无缝免拉手，极致干净',
    material:
      '门板为纯白哑光烤漆或白色亚克力，表面无任何纹理与拼缝感；台面为白色石英石；墙面与主体几乎同色。',
    hardware: '完全免拉手（斜切指扣或按压开启），金属件尽量不外露或与门板同色。',
    metal: '金属件尽量不外露或与门板同色。',
    scene: '纯白墙面与浅灰自流平地面，画面大量留白，无多余陈设。',
    light: '均匀柔和的冷调漫射光，几乎无投影，强调形体与缝隙的精确。',
    mood: '极致、干净、近乎无物的秩序感。',
  },
  {
    id: 'lux',
    label: '轻奢',
    hint: '岩板 + 金属收边 + 藏灯，高级感',
    material:
      '门板为深灰高光或哑光岩板饰面，纹理连续大气；台面为整块鱼肚白或深色大理石纹岩板；层板为磨砂玻璃配金属边框。',
    hardware: '香槟金或哑光黄铜通体长拉手，内部嵌暖白线性灯带。',
    metal: '金属件为香槟金或哑光黄铜，内部嵌暖白线性灯带。',
    scene: '背景为深色木饰面或石材墙面，地面为抛光大理石，陈设克制但材质昂贵。',
    light: '暖色线性藏灯与重点射灯结合，主体表面出现细长高光，明暗对比强烈、层次丰富。',
    mood: '精致、克制的高级感与仪式感。',
  },
  {
    id: 'midcentury',
    label: '中古风',
    hint: '胡桃木深色 + 黄铜 + 暖黄光，复古温厚',
    material:
      '门板为胡桃木深色木饰面，纹理厚重，边角圆润；部分区域用长虹玻璃或藤编门芯；台面为深色木质或黄铜包边。',
    hardware: '黄铜圆头小拉手，随时间氧化的哑光质感。',
    metal: '金属件为随时间氧化的哑光黄铜。',
    scene: '背景为暖棕墙面、人字拼木地板，配复古单椅与暖色台灯。',
    light: '暖黄灯光（约2700K）从画面右后方斜射，木面呈油润的琥珀色反光，阴影浓重。',
    mood: '复古、沉静、有岁月感。',
  },
  {
    id: 'wabisabi',
    label: '侘寂',
    hint: '微水泥肌理 + 大地色，粗粝静谧',
    material:
      '门板为微水泥或硅藻泥肌理饰面，手作感明显，颜色为米灰、燕麦、陶土等大地色系；表面呈不均匀的哑光，刻意保留手工痕迹。',
    hardware: '近乎不可见的暗藏拉手或木楔式拉手，金属件做旧处理。',
    metal: '金属件做旧处理。',
    scene: '背景为同色系肌理墙面与夯土色地面，陈设极简，可放一件陶器或枯枝。',
    light: '自然光从侧上方斜射，在肌理表面留下柔和而缓慢的明暗过渡，静谧有呼吸感。',
    mood: '质朴、残缺美、安静。',
  },
  {
    id: 'french',
    label: '轻法式',
    hint: '回字造型门 + 黄铜 + 人字拼，优雅',
    material:
      '门板为白色模压回字形（shaker）门板，线条精致对称；台面为白色大理石纹岩板；内部为米白。',
    hardware: '细长黄铜拉手或贝壳质感圆钮，配石膏线脚与法式线条。',
    metal: '金属件为细长黄铜或贝壳质感。',
    scene: '背景为浅灰或米白墙面、人字拼木地板，可加拱形门洞与壁灯。',
    light: '明亮柔和的自然光，白墙与门板反射出通透的亮度，阴影浅而干净。',
    mood: '优雅、浪漫、精致。',
  },
  {
    id: 'newchinese',
    label: '新中式',
    hint: '深色格栅 + 亚麻 + 铜，东方留白',
    material:
      '门板为深色胡桃木格栅或亚麻质感饰面，留白处用米灰色；背板为绢丝或肌理漆；台面为深色石材配铜质收边。',
    hardware: '铜质细长拉手或暗藏铜条，比例克制。',
    metal: '金属配件为哑光铜质，比例克制。',
    scene: '背景为米灰肌理墙面与深色木地板，配一株松枝或水墨挂画，大量留白。',
    light: '暖白灯光从上方柔和洒落，格栅在墙面上投下细密而有节奏的影子。',
    mood: '东方、禅意、含蓄讲究。',
  },
  {
    id: 'italian',
    label: '意式极简',
    hint: '大板一体 + 无缝免拉手，雕塑感',
    material:
      '门板为大板岩板或哑光深色烤漆一体成型，纹理横向连贯贯通整面；台面与门板同材质无缝衔接，几乎看不到接缝。',
    hardware: '完全免拉手，以门板厚度差形成握持边；金属件仅出现在必要收口处。',
    metal: '金属件仅出现在必要收口处。',
    scene: '背景为深灰或墨绿单色墙面与哑光石材地面，陈设极少，强调体块关系。',
    light: '低角度侧光勾勒主体体块，表面呈大面积均匀哑光，暗部深沉，立体感强。',
    mood: '雕塑感、低调、昂贵。',
  },
  {
    id: 'industrial',
    label: '工业风',
    hint: '岩板 + 金属框架 + 黑铁，粗犷',
    material:
      '门板为深灰岩板或水泥质感饰面，配黑铁金属边框；部分为开放格，露出金属层板；台面为厚混凝土或深色岩板。',
    hardware: '黑色铁艺拉手与外露螺栓，金属件保留工艺痕迹。',
    metal: '金属件为黑色铁艺与外露螺栓。',
    scene: '背景为裸砖或水泥墙面、水泥地面，可见管线与金属结构。',
    light: '偏冷的工业照明，金属件出现硬朗高光，阴影边缘清晰。',
    mood: '粗犷、真实、空间感强。',
  },
  {
    id: 'nordic',
    label: '北欧',
    hint: '浅木纹 + 白 + 明亮自然光，简洁',
    material:
      '门板为浅色白蜡木或桦木木纹饰面，搭配白色哑光面板；台面为浅色复合石材；线条简洁，无多余装饰。',
    hardware: '细长哑光白或原木拉手，造型简单。',
    metal: '金属件为哑光白或原木色。',
    scene: '背景为白色与浅灰墙面、浅色木地板，配几何造型的小件家具与绿植。',
    light: '明亮通透的自然光充满画面，整体明度高、阴影浅、色彩清淡。',
    mood: '清爽、温暖、日常舒适。',
  },
  {
    id: 'custom',
    label: '跟随参考图',
    hint: '不加风格词，材质完全交给参考图',
    material: '',
    hardware: '',
    metal: '',
    scene: '',
    light: '',
    mood: '',
  },
]

/**
 * 彩平图的制图符号规范。
 *
 * 这一整段是用户反馈「窗户和门不太对、家具看不出是什么家具」之后补的。
 * 只写「用符号表达」没用 —— 必须把符号长什么样写出来，否则模型只会在原地
 * 摆几个方块（实测：沙发没有靠背扶手、床没有枕头被面、窗门只是一个洞）。
 *
 * 每条都是建筑制图的常规画法，属于通用规范，不涉及任何专有模板。
 */
const FLAT_SYMBOLS = [
  '【制图符号】门窗与家具一律按俯视制图规范重绘，线条纤细、线宽统一、风格一致：',
  '窗：在墙体开洞位置用 3 条平行的细直线横跨墙厚表示（外墙断开处由窗线补上），可再加一条中线；',
  '平开门：画出门扇线（一条细直线，长度等于门洞宽度）+ 90° 开启弧线，弧线细而圆滑，明确标出开启方向；',
  '推拉门：画两段互相错开的平行细线；垭口/通道只留洞口，不画门扇；',
  '沙发：主体为圆角矩形，后侧加一条加宽的靠背带，两端各加一个小方块作扶手，坐垫用 2~3 条分缝线切分（三人沙发分三段）；',
  '单人椅/餐椅：小圆角方块 + 靠背用一条略粗的短线；餐椅朝向桌面均匀分布；',
  '床：床体为大圆角矩形，床头一侧并排 2 个枕头（两个小圆角方块），被面用一条横向弧线表现翻折、枕头下方留出被沿；双人床两侧可加床头柜小方块；',
  '衣柜/橱柜：矩形 + 内部门板分缝线，台面外沿加一条细线表示台面出檐；',
  '洁具：马桶 = 椭圆 + 后侧小方水箱；台盆 = 圆角矩形 + 内椭圆；浴缸 = 圆角矩形 + 内沿双线；',
  '地毯：圆角矩形或圆形的浅色平涂块，压在沙发或床下方并略微超出；',
  '绿植：俯视的星形或多边形叶片簇，2~3 处点缀即可。',
].join('')

/** 图形类操作要明确禁止的画法（写成负向词给支持的模型）。 */
const NEGATIVE_FLAT = [
  '实景俯拍', '照片', '三维透视', '立体', '景深', '材质纹理', '木纹特写', '阴影方向',
  '模糊', '文字', '数字', '尺寸标注', '水印',
].join(', ')

/**
 * 彩平风格：给「平面图」操作用。
 *
 * 每条都按真实彩平图的制图惯例来写：正投影俯视、墙体实心填充（poché）、
 * 地面按房间平涂色块、家具画成正投影俯视符号、家具下方极浅投影。
 * 「平涂、不画纹理」必须写死 —— 否则模型会画成实景俯拍照片。
 */
const FLAT_STYLES = [
  {
    id: 'flat-soft',
    group: 'flat',
    label: '柔光彩平',
    hint: '推荐。低饱和暖色平涂 + 家具符号 + 极浅投影，最像设计公司汇报用的彩平',
    material:
      '正投影俯视平面图，不出现立体透视与房间高度。墙体用深灰实心填充并压清晰墙线；地面按房间铺低饱和暖色平涂色块（客厅暖灰、卧室浅木色、厨卫冷灰），色块为纯平涂、不画木纹与瓷砖纹理；家具以正投影俯视图形符号表达（沙发分出坐垫与扶手、床分出枕头与被面、餐桌配椅、橱柜带台面），造型简洁可辨识；家具与固定物下方带极浅的柔和投影以增强层次；点缀少量绿植与地毯色块提升完成度。整体配色统一、低饱和、干净通透。',
    detail:
      '线宽统一纤细，色块边界锐利干净，画面中不出现任何文字、尺寸、标注或指北针。',
    scene: '无环境背景，画面即为图面本身，四周留白均匀。',
    mood: '柔和、干净、像专业设计公司汇报用的彩平图。',
    light: '无方向性光照，仅家具下方有极浅的柔和投影，保持平面图纸属性。',
  },
  {
    id: 'flat-wood',
    group: 'flat',
    label: '木色彩平',
    hint: '全屋暖木色平涂 + 浅色家具，温暖清爽',
    material:
      '正投影俯视平面图。墙体深灰实心填充并压清晰墙线；全屋地面统一为暖木色平涂色块（纯平涂、不画木纹），墙内侧留浅白；家具以白色或浅灰的正投影俯视符号表达，木质家具用原木色平涂；家具下方带浅投影；点缀绿植与地毯色块。整体以木色与白为主，温暖清爽。',
    detail: '线宽统一，色块边缘干净，不出现任何文字、尺寸或标注。',
    scene: '无环境背景，画面即为图面本身，四周留白均匀。',
    mood: '温暖、自然、清爽。',
    light: '无方向性光照，仅家具下方极浅柔和投影。',
  },
  {
    id: 'flat-color',
    group: 'flat',
    label: '分色彩平',
    hint: '按房间功能分色，讲解功能分区最好用',
    material:
      '正投影俯视平面图。墙体深灰实心填充；按房间功能区分地面色块——客厅与餐厅暖灰、卧室暖木、厨房冷灰、卫生间浅蓝灰、阳台浅绿，每种色块纯平涂且边界清晰；家具以简洁正投影符号表达并带浅投影；公共区可加圆形或方形地毯色块。配色分区明确、层次分明。',
    detail: '色块饱和适中、互相协调不刺眼，线宽统一，不出现任何文字、尺寸或标注。',
    scene: '无环境背景，画面即为图面本身，四周留白均匀。',
    mood: '清晰、有条理、适合向客户讲解功能分区。',
    light: '无方向性光照，仅家具下方极浅柔和投影。',
  },
  {
    id: 'flat-water',
    group: 'flat',
    label: '水彩彩平',
    hint: '水彩晕染质感，轻盈有艺术感',
    material:
      '正投影俯视平面图，水彩晕染质感：墙体用深灰实心；地面色块为水彩平涂，边缘略有自然晕开与叠色；家具以纤细线条勾勒并淡淡上色；纸面有轻微水彩纸纹理。整体轻盈通透、艺术感强。',
    detail: '保留水彩的边缘晕染与局部留白，线稿纤细干净，不出现任何文字、尺寸或标注。',
    scene: '无环境背景，画面即为水彩纸面，四周留白均匀。',
    mood: '轻盈、通透、有艺术感。',
    light: '无实体光照，以水彩浓淡表现层次，纸面均匀受光。',
  },
  {
    id: 'flat-lux',
    group: 'flat',
    label: '深色彩平',
    hint: '深色底 + 金色细线点缀，高端商务汇报',
    material:
      '正投影俯视平面图。深色底（墨蓝或深炭灰）搭配浅色地面平涂色块；墙体用更深的实心填充并压亮边；家具以浅色正投影符号表达并带柔和投影；重点区域与家具轮廓用香槟金细线点缀。整体高级稳重、对比清晰。',
    detail: '金色点缀克制、只用于细线与重点轮廓，不在色块上铺金；不出现任何文字、尺寸或标注。',
    scene: '无环境背景，画面即为图面本身，四周留白均匀。',
    mood: '高级、稳重、有档次。',
    light: '无方向性光照，仅家具下方极浅柔和投影，重点区域略亮。',
  },
]

/** 轴测风格：给「平面→立体户型」操作用。 */
const AXON_STYLES = [
  {
    id: 'axon-white',
    group: 'axon',
    label: '白模轴测',
    hint: '纯白纸模，突出空间关系',
    material: '整体为纯白纸模质感，仅在转折处有极浅的灰色明暗区分，无任何材质纹理。',
    detail: '墙体按规定高度剖切，切面干净，阴影极浅而柔和，突出空间关系。',
    scene: '纯白或极浅灰背景，无环境陈设，可保留必要的家具白模体块。',
    mood: '干净、理性、方案感强。',
    light: '光照极柔、几乎无投影，仅靠转折处的浅灰明暗区分面。',
  },
  {
    id: 'axon-clay',
    group: 'axon',
    label: '陶土轴测',
    hint: '统一陶土单色，像一组模型',
    material: '整体统一为陶土色（赤陶）单色，表面亚光细腻，靠明暗塑造形体，无花纹。',
    detail: '剖切面清晰，阴影柔和均匀，整体像一组陶土模型。',
    scene: '浅米色背景，无多余陈设。',
    mood: '温润、有手作模型感。',
    light: '柔和顶光，阴影浅而均匀，靠明暗塑造形体体积。',
  },
  {
    id: 'axon-real',
    group: 'axon',
    label: '写实轴测',
    hint: '带真实材质，易读精致',
    material: '带真实材质：木地板、瓷砖、乳胶漆墙面与布艺家具，颜色自然，光影柔和。',
    detail: '墙体剖切高度一致，切面用深色描边强调，家具细节适度简化。',
    scene: '浅色背景，无环境陈设。',
    mood: '真实、精致、易读。',
    light: '俯视柔和日光，投影方向统一、边缘柔和，材质反光真实。',
  },
  {
    id: 'axon-wood',
    group: 'axon',
    label: '木色轴测',
    hint: '白墙 + 原木家具，清爽',
    material: '白色墙体与浅灰地面为底，家具统一为原木色（橡木/白蜡木），木纹细腻。',
    detail: '剖切面清晰，阴影柔和，整幅配色不超过三种主色。',
    scene: '浅米白背景，无多余陈设。',
    mood: '清爽、温和、有生活感。',
    light: '明亮柔和的顶光，投影浅淡，木色显得清爽自然。',
  },
]

/** 分析图风格：给「分析图」操作用。 */
const DIAGRAM_STYLES = [
  {
    id: 'dg-minimal',
    group: 'diagram',
    label: '极简线稿',
    hint: '黑白线稿 + 单一强调色',
    material: '以黑白线稿为主，仅用单一强调色（如橙红）标出重点区域，其余全部留白。',
    detail: '线宽统一、箭头简洁，色块面积小而精，画面留白充足。',
    scene: '纯白背景，画面即为图面本身。',
    mood: '克制、专业、汇报感强。',
    light: '无光照与投影，纯平面图形表达。',
  },
  {
    id: 'dg-flat',
    group: 'diagram',
    label: '扁平色块',
    hint: '低饱和多色分区，清晰易读',
    material: '用低饱和度的多色半透明色块区分不同区域或系统，色块叠加处自然混合。',
    detail: '色块边缘清晰，配合细箭头与图形化符号，信息层级明确。',
    scene: '浅灰或白背景，画面即为图面本身。',
    mood: '清晰、现代、易读。',
    light: '无光照与投影，靠色块区分层次。',
  },
  {
    id: 'dg-bold',
    group: 'diagram',
    label: '高对比商务',
    hint: '深色底 + 荧光强调色，冲击力强',
    material: '深色底（深蓝或近黑）搭配高饱和荧光强调色（青绿、亮橙），对比强烈。',
    detail: '箭头与色块醒目，重点信息用高亮处理，画面干净不杂乱。',
    scene: '深色背景，画面即为图面本身。',
    mood: '有力、有冲击、汇报吸睛。',
    light: '深色底上的高亮点光强调重点，无实体投影。',
  },
  {
    id: 'dg-hand',
    group: 'diagram',
    label: '手绘分析',
    hint: '手绘线条 + 淡彩，有思考感',
    material: '手绘线条（略带抖动与出锋）搭配淡彩上色，纸面有轻微纹理，色彩轻薄。',
    detail: '箭头有手绘质感，重点用马克笔加重，保留少量草图辅助线。',
    scene: '纸面背景，画面即为图面本身。',
    mood: '生动、有推敲过程感。',
    light: '无实体光照，靠笔触与淡彩的浓淡表现层次。',
  },
]

/** 概念风格：给「文生图 / 灵感图」操作用（与家居风格一起展示）。 */
const CONCEPT_STYLES = [
  {
    id: 'ext-modern',
    group: 'concept',
    label: '现代建筑外观',
    hint: '混凝土 + 金属 + 玻璃，克制有力',
    material: '清水混凝土、深灰金属板、超白玻璃与暖色木格栅组合，材质对比清晰，接缝利落。',
    detail: '立面分缝整齐，玻璃有真实反射，金属为哑光拉丝。',
    scene: '简洁的硬质铺装与少量绿植，天空为柔和的浅灰蓝。',
    mood: '克制、现代、有力量。',
    light: '侧向自然光，建筑体量明暗分明，玻璃有天空与环境的真实反射。',
  },
  {
    id: 'land-garden',
    group: 'concept',
    label: '景观庭院',
    hint: '自然材质 + 植物层次',
    material: '自然石材铺装、原木平台、锈板与观赏草，材质自然粗粝。',
    detail: '植物层次分明，水景有真实反射，光影斑驳。',
    scene: '庭院或屋顶花园，周围有建筑界面围合。',
    mood: '自然、放松、有呼吸感。',
    light: '斑驳的树影与柔和的自然光，植物层次分明。',
  },
  {
    id: 'concept-mood',
    group: 'concept',
    label: '概念意象',
    hint: '重氛围不重写实，像灵感图',
    material: '材质自由组合（光滑与粗糙、透明与厚重对比），强调氛围而非写实。',
    detail: '构图有张力，光影强烈，允许适度超现实。',
    scene: '环境可简化或虚化，突出主体。',
    mood: '有概念性、有情绪、像一张灵感参考图。',
    light: '强对比的戏剧性光照，光源明确，明暗交界有力。',
  },
]

/**
 * 「沿用底图」：不指定风格。
 *
 * 换视角、风格迁移、实拍照片优化这几类操作**不该选风格**：
 *   - 换视角要的是「同一个空间换个机位」，选了风格就会顺手换材质，空间感就断了；
 *   - 风格迁移的风格完全来自参考图，再选一个预设只会互相干扰；
 *   - 照片优化的默认意图是「保持原样只提质」，而不是整体换风格。
 * 所以给它单独一个 'none' 组，只有明确列出的操作才允许选。
 */
const AS_IS_STYLE = {
  id: 'as-is',
  group: 'none',
  label: '沿用底图',
  hint: '不指定风格，材质与色彩沿用底图',
  material: '',
  detail: '',
  scene: '',
  mood: '',
  light: '',
}

/** 这些操作画面上有可继承的材质，允许「沿用底图」。 */
// wash（洗图）也必须在这里：洗图只提画质，材质/光影/配色一律以图1为准，
// 一旦让风格模板参与进来，就会把原图的材质换掉 —— 那就不是洗图了。
const MODE_INHERITS_STYLE = new Set(['view-switch', 'photo', 'wash', 'superres'])

/**
 * 风格按组划分，组再按操作分配。
 * 「平面图」不该看到「奶油风门板」，「分析图」也不该看到「香槟金拉手」。
 */
const STYLE_PRESETS = [
  AS_IS_STYLE,
  ...INTERIOR_STYLES.map((style) => ({ ...style, group: 'interior' })),
  ...FLAT_STYLES,
  ...AXON_STYLES,
  ...DIAGRAM_STYLES,
  ...CONCEPT_STYLES,
]

/** 操作 → 可选风格组。没列出的操作默认家居风格。 */
const MODE_STYLE_GROUPS = {
  elevation: ['interior'],
  sketch: ['interior'],
  model: ['interior'],
  // 照片优化默认「沿用底图」，想改造再选家居风格
  photo: ['none', 'interior'],
  plan: ['flat'],
  'plan-3d': ['axon'],
  'plan-perspective': ['interior'],
  diagram: ['diagram'],
  // 风格来自参考图，不该再选预设
  'style-transfer': ['none'],
  // 同空间换机位，材质色彩必须沿用底图
  'view-switch': ['none'],
  // 本地超分不改画面内容，没有「换个风格」这回事
  superres: ['none'],
  text2img: ['interior', 'concept'],
}

/**
 * 操作 → 界面上该显示哪些控件。
 *
 * 这里修的是「菜单和功能不对应」：彩平图没有方向性光照、正投影是固定的，
 * 给它摆「光影」「构图」两个选择器只会误导；文生图没有底图，「读结构」与
 * 「自动质检」都无从下手。默认全开，只对不合理的操作关掉。
 */
const MODE_UI = {
  plan: { lighting: false, camera: false },
  'plan-3d': { lighting: false, camera: false },
  diagram: { lighting: false, camera: false, diagramType: true },
  // 照片优化不该换机位（想换机位请用「换视角」）
  photo: { camera: false },
  'style-transfer': { camera: false },
  // 没有底图可以读，也没有底图可以比对
  text2img: { read: false, qc: false },
  // 本地超分：不走云通道，风格 / 光影 / 构图 / 读图 / 质检一个都不需要。
  // local 这个开关让面板改画「引擎状态 + 倍数 + 模型 + tile」那一套控件。
  superres: { local: true, style: false, lighting: false, camera: false, read: false, qc: false, quick: false },
}

const DEFAULT_UI = {
  lighting: true,
  camera: true,
  diagramType: false,
  read: true,
  qc: true,
  quick: true,
  style: true,
  local: false,
}

/** 取某个操作的界面开关（缺省全开）。 */
function uiOf(taskModeId) {
  return { ...DEFAULT_UI, ...(MODE_UI[taskModeId] ?? {}) }
}

/** 取某个操作可用的风格组。 */
function styleGroupsOf(taskModeId) {
  return MODE_STYLE_GROUPS[taskModeId] ?? ['interior']
}

/** 这个操作是不是「不该选风格」（只有「沿用底图」一个选项）。 */
function styleIsFixedToBase(taskModeId) {
  const styles = stylesOf(taskModeId)
  return styles.length === 1 && (styles[0].group ?? '') === 'none'
}

/** 这个操作是不是「材质色彩沿用底图」。 */
function modeInheritsStyle(taskModeId) {
  return MODE_INHERITS_STYLE.has(taskModeId)
}

/** 取某个操作可用的风格预设。 */
function stylesOf(taskModeId) {
  const groups = styleGroupsOf(taskModeId)
  return STYLE_PRESETS.filter((style) => groups.includes(style.group ?? 'interior'))
}

/** 光影预设；auto = 跟随所选风格。 */
const LIGHTING_PRESETS = [
  { id: 'auto', label: '跟随风格', hint: '用风格预设自带的光影描述', prompt: '' },
  {
    id: 'daylight',
    label: '自然日光',
    hint: '明亮通透，靠窗侧光',
    prompt: '明亮的自然光从画面侧窗射入，在主体上形成清晰的明暗交界，投影柔和、方向明确。',
  },
  {
    id: 'dusk',
    label: '黄昏暖光',
    hint: '低色温斜射，暖而绵长',
    prompt: '黄昏的低角度暖光透过窗户斜射进来，色温约2800K，饰面泛出温暖的琥珀色光泽，投影被拉长。',
  },
  {
    id: 'night',
    label: '夜间氛围灯',
    hint: '藏灯 + 射灯，明暗戏剧',
    prompt: '夜间场景：内部暖白线性藏灯与顶部射灯为主要光源，环境光压暗，明暗对比强烈、氛围安静。',
  },
  {
    id: 'studio',
    label: '影棚光',
    hint: '干净均匀，产品级呈现',
    prompt: '影棚式布光：大面积柔光箱从左前与右后包裹物体，材质细节均匀呈现，阴影极浅、背景干净。',
  },
]

/**
 * 风格色卡：只给面板上的预设芯片做视觉标识（两色渐变圆点），
 * 不参与提示词，纯装饰。
 */
const STYLE_SWATCHES = {
  modern: ['#e9e7e2', '#878d94'],
  cream: ['#f6ecdc', '#d9c4a6'],
  wood: ['#e5cba5', '#8b6b45'],
  white: ['#fcfcfa', '#dedcd7'],
  lux: ['#33363c', '#c9a961'],
  midcentury: ['#6f4c30', '#c08b4a'],
  wabisabi: ['#d1c9bc', '#8f8577'],
  french: ['#f8f4ef', '#c9b48a'],
  newchinese: ['#3a2f28', '#b08d57'],
  italian: ['#3b3f45', '#1f2226'],
  industrial: ['#7c7c7c', '#2b2b2b'],
  nordic: ['#f2efe9', '#c3b39a'],
  custom: ['#dfe3e8', '#9aa4b0'],
  'as-is': ['#f0f0f0', '#c8c8c8'],
  // 彩平
  'flat-soft': ['#f3ede4', '#c9a888'],
  'flat-wood': ['#e8cfa8', '#b98a55'],
  'flat-color': ['#e6d8c8', '#9fb6bd'],
  'flat-water': ['#fdf8ef', '#a8c4d8'],
  'flat-lux': ['#26303c', '#c9a961'],
  // 轴测
  'axon-white': ['#ffffff', '#dfe2e6'],
  'axon-clay': ['#e0a882', '#b7764f'],
  'axon-real': ['#e9e4dc', '#9a8b78'],
  'axon-wood': ['#f4f2ee', '#c8a273'],
  // 分析图
  'dg-minimal': ['#ffffff', '#f0562d'],
  'dg-flat': ['#8fc4e8', '#f2b06b'],
  'dg-bold': ['#131a2b', '#25e0c0'],
  'dg-hand': ['#fbf7ef', '#7fa8c9'],
  // 概念
  'ext-modern': ['#b9bcc0', '#3d4348'],
  'land-garden': ['#8fa87a', '#6d5236'],
  'concept-mood': ['#8a7f9c', '#e0c9a6'],
}

/**
 * 机位三维度。
 *
 * 对齐 Qwen-Image-Edit Multiple Angles 的机位模型（8 水平 × 4 垂直 × 3 距离
 * = 96 种机位），也是竞品子菜单的组织方式：**拆成三个正交维度分组**，
 * 而不是一个扁平列表。用户先选转到哪个方位，再选机位高低，再选取景远近。
 *
 * 每个选项带 `deg` / `level`，面板据此画出示意小图（像竞品的图示卡片）。
 */
const CAMERA_AZIMUTH = [
  { id: 'inherit', label: '原角度', hint: '保持底图原有朝向', deg: null },
  { id: 'front', label: '正面 0°', hint: '主体正对镜头', deg: 0 },
  { id: 'front-right', label: '右前 45°', hint: '3/4 侧面，最常用的立体视角', deg: 45 },
  { id: 'right', label: '右侧 90°', hint: '纯侧面轮廓', deg: 90 },
  { id: 'back-right', label: '右后 135°', hint: '背侧面视角', deg: 135 },
  { id: 'back', label: '背面 180°', hint: '反打机位', deg: 180 },
  { id: 'back-left', label: '左后 -135°', hint: '左后方视角', deg: -135 },
  { id: 'left', label: '左侧 -90°', hint: '左侧轮廓', deg: -90 },
  { id: 'front-left', label: '左前 -45°', hint: '反打 3/4 侧面', deg: -45 },
]

const CAMERA_ELEVATION = [
  { id: 'inherit', label: '原高度', hint: '保持底图的机位高度', deg: null },
  { id: 'eye', label: '平视', hint: '0° 镜头与主体平齐，自然日常', deg: 0 },
  { id: 'low', label: '仰视', hint: '-30° 从下往上，主体显高显气势', deg: -30 },
  { id: 'high', label: '俯视', hint: '35° 从上往下，交代布置关系', deg: 35 },
  { id: 'bird', label: '鸟瞰', hint: '75° 近乎垂直俯视，看全局', deg: 75 },
]

const CAMERA_DISTANCE = [
  { id: 'inherit', label: '不变', hint: '保持底图的取景范围', level: null },
  { id: 'close', label: '特写', hint: '收窄到局部，突出材质与细节', level: 0 },
  { id: 'medium', label: '中景', hint: '主体完整 + 少量环境', level: 1 },
  { id: 'wide', label: '广角', hint: '带更多环境，交代空间关系', level: 2 },
]

/** 常用机位组合：一键把三个维度设好（对应竞品的「常用组合速查」）。 */
const CAMERA_COMBOS = [
  { id: 'elevation', label: '正视图', hint: '与立面一致的正面平视', azimuth: 'front', elevation: 'eye', distance: 'medium' },
  { id: 'three-quarter', label: '3/4 侧视', hint: '最常用的立体视角', azimuth: 'front-right', elevation: 'eye', distance: 'medium' },
  { id: 'space', label: '空间感', hint: '略俯广角，交代空间关系', azimuth: 'front-left', elevation: 'high', distance: 'wide' },
  { id: 'detail', label: '局部特写', hint: '突出材质与五金细节', azimuth: 'front', elevation: 'eye', distance: 'close' },
  { id: 'hero', label: '高角度', hint: '俯视看整体布置', azimuth: 'front-right', elevation: 'high', distance: 'medium' },
  { id: 'reverse', label: '反打机位', hint: '换到对面看回来', azimuth: 'back', elevation: 'eye', distance: 'medium' },
]

/** 兼容旧字段：camera 现在就是「水平角度」。 */
const CAMERA_PRESETS = CAMERA_AZIMUTH

/** 画质段：强调材质区分度，这是效果图「像不像」的关键。 */
const QUALITY_SEGMENT =
  '8K 超高清画质。材质区分度必须明确：木纹的走向与毛孔、石材的纹理与反光、金属的拉丝方向、哑光漆面的细腻、玻璃的通透与反射，各自质感清晰可辨。专业室内建筑摄影，真实接触阴影，浅景深、背景轻微虚化，画面无文字、无水印、无品牌标识、无畸变。'

const QUALITY_SEGMENT_SHORT = '8K 超高清，材质区分度明确，专业室内建筑摄影，真实阴影，无文字无水印。'

/**
 * 图形类画质（彩平图 / 分析图）。
 *
 * 这个段位是踩坑换来的：原先所有操作共用上面的摄影段（「木纹毛孔」「浅景深」
 * 「专业室内建筑摄影」），结果彩平图被渲染成一张照片感的灰白俯视图 ——
 * 提示词在要照片，模型当然给照片。图形类必须换成图形语言。
 */
const QUALITY_GRAPHIC =
  '图面为矢量级清晰度：色块平涂均匀、无渐变噪点、无材质纹理，线条锐利不糊边，无摄影景深与背景虚化。整幅图干净利落、层次分明，输出高分辨率，画面中不出现任何文字、数字、尺寸标注或水印。'

const QUALITY_GRAPHIC_SHORT = '矢量级清晰：色块平涂、线条锐利、无材质纹理与景深，高清无文字。'

/** 轴测图画质：介于图形与照片之间 —— 形体清晰，材质适度简化。 */
const QUALITY_AXON =
  '图面清晰锐利：形体转折与剖切面明确，线条干净不糊边，材质表现适度简化而非照片级，无摄影景深与背景虚化。输出高分辨率，画面中不出现任何文字、数字或标注。'

const QUALITY_AXON_SHORT = '形体与剖切面清晰、线条干净、材质简化、无景深，高清无文字。'

/** 按风格组挑画质段：家居/概念走摄影，彩平与分析图走图形，轴测走中间。 */
const QUALITY_BY_GROUP = {
  interior: { text: QUALITY_SEGMENT, short: QUALITY_SEGMENT_SHORT },
  concept: { text: QUALITY_SEGMENT, short: QUALITY_SEGMENT_SHORT },
  flat: { text: QUALITY_GRAPHIC, short: QUALITY_GRAPHIC_SHORT },
  diagram: { text: QUALITY_GRAPHIC, short: QUALITY_GRAPHIC_SHORT },
  axon: { text: QUALITY_AXON, short: QUALITY_AXON_SHORT },
}

function qualityOf(style) {
  return QUALITY_BY_GROUP[style?.group ?? 'interior'] ?? QUALITY_BY_GROUP.interior
}

/** 通义万相等支持负向提示词的模型使用。 */
const NEGATIVE_PROMPT = [
  '施工图', '尺寸标注', '尺寸数字', '文字', '文字水印', 'logo', '引线', '剖面线', '图框', '辅助线',
  '线稿', '蓝图', '草图', '手绘', '卡通', '插画', '变形', '结构改变', '门板数量改变', '比例失调',
  '模糊', '低分辨率', '低质量', '噪点', '过曝', '过饱和', '重复线条', '重影',
  // 结构漂移的具象说法：模型更容易理解「重新设计/分格错位」这类描述，
  // 比抽象的一句「结构改变」管用（用户反馈结构经常被改）。
  '重新设计', '改设计', '重新排版', '分格错位', '分格数量改变', '增加分格', '减少分格',
  '对称化', '简化结构', '美化结构', '构件增减', '比例拉伸', '压扁', '加宽主体',
].join(', ')

/**
 * 让多模态模型「读」这张 CAD 立面图，输出结构化清单。
 *
 * 这是本插件唯一真正让模型「读懂图纸」的地方：图片模型只会模仿像素，
 * 而视觉模型能数出门板、读出分格关系；把结果写进提示词就成了「结构规格书」。
 *
 * 注意 DeepSeek 的视觉编码：图像最小按 544×544 上采、14px 对齐、3:1 下采样，
 * 单图上限 1024 tokens。所以送进去的 CAD 要够大够干净，小字细线才读得出来。
 */
/**
 * 按底图类型给读图模型换「看什么」的说明。
 * 底图不一定是立面图——可能是模型截图、实拍照片，甚至是平面图。
 */
const READER_TARGET = {
  elevation: '图里可能同时有俯视、立面、侧剖等多张视图；只读立面那一个（通常最高、最完整），忽略其他视图。',
  sketch: '这是一张线稿/手绘稿：只读它表达的那个视图，忽略图框、辅助线与涂改痕迹。',
  model: '这是一张模型截图：描述能看到的体量轮廓、面与面的转折、开口与洞口位置、层数与材质分区；看不到的背面不要臆测。',
  photo: '这是一张实拍照片：描述画面里实际的主体与空间结构、门板与抽屉数量、分格关系与固定物位置。',
  plan: '这是一张平面图：描述墙体走向、房间划分、门窗洞口位置与家具布置，不要按立面的方式去读。',
}

const CAD_READER_SYSTEM = cadReaderSystem('elevation')

/**
 * 把提示词里的 @提及 翻译成模型能理解的图号。
 *
 * 用户写「@参考图1 的木纹换成深色」时，模型并不知道「参考图1」是第几张图；
 * 翻译成「图2」之后就和 prompt 里的编号约定对上了（图1=底图，图2=参考图1…）。
 *
 * 支持：@底图 / @原图 / @图1 → 图1；@参考图N / @参考N / @图N → 图N+1；@文件名（含或不含扩展名）。
 *
 * @param text 用户原文
 * @param referenceCount 参考图张数（不含底图）
 * @param names 参考图文件名，按顺序
 */
function resolveImageMentions(text, referenceCount, names = [], hasBase = true) {
  if (typeof text !== 'string' || !text.trim()) return typeof text === 'string' ? text : ''
  const total = Number(referenceCount) || 0
  // 有底图时参考图从图2 开始；无底图（文生图）时从图1 开始。
  const shift = hasBase ? 1 : 0
  let out = text

  // @底图 / @原图 / @主图 → 图1（无底图时这个提及没有意义，原样留着让用户看见）
  if (hasBase) out = out.replace(/@\s*(?:底图|原图|主图)/g, '图1')
  // @参考图N / @参考N → 图(N+shift)
  out = out.replace(/@\s*(?:参考图|参考)\s*([1-9])/g, (matched, digit) => {
    const index = Number(digit)
    return index <= total ? `图${index + shift}` : matched
  })
  // @图N → 图N（用户已经按 prompt 编号说了）
  out = out.replace(/@\s*图\s*([1-9])/g, (matched, digit) => {
    const index = Number(digit)
    return index <= total + shift ? `图${index}` : matched
  })
  // 按文件名匹配：第 i 张参考图 → 图(i+1+shift)
  for (const [index, rawName] of (names ?? []).entries()) {
    if (typeof rawName !== 'string' || !rawName.trim()) continue
    const name = rawName.trim()
    const base = name.replace(/\.[^.]+$/, '')
    const target = `图${index + 1 + shift}`
    const tokens = new Set([`@${name}`])
    if (base.length >= 2) tokens.add(`@${base}`)
    for (const token of tokens) out = out.split(token).join(target)
  }
  return out
}

/**
 * 出图比例。
 *
 * 默认「跟随底图」按图纸长宽比出图（构图最稳）；但用户常常需要指定比例，
 * 例如做视频封面要 16:9、发朋友圈要 1:1、通顶高柜要 9:16。
 *
 * 注意：**比例最终能不能落地取决于模型**。gpt-image 系列只接受
 * 1024x1024 / 1536x1024 / 1024x1536 三种，其它比例会被归到最接近的一种；
 * 即梦 / 通义万相接受任意 WxH。面板会把「实际输出尺寸」回报出来。
 */
const RATIO_PRESETS = [
  { id: 'follow', label: '跟随底图', hint: '按底图长宽比出图，构图与图纸一致（推荐）', w: 0, h: 0 },
  { id: '1:1', label: '1:1', hint: '方形：产品图、封面、方版排版', w: 1, h: 1 },
  { id: '3:2', label: '3:2', hint: '相机横构图（gpt-image 原生支持）', w: 3, h: 2 },
  { id: '2:3', label: '2:3', hint: '相机竖构图，主体立面常用（gpt-image 原生支持）', w: 2, h: 3 },
  { id: '4:3', label: '4:3', hint: '经典横构图', w: 4, h: 3 },
  { id: '3:4', label: '3:4', hint: '经典竖构图', w: 3, h: 4 },
  { id: '16:9', label: '16:9', hint: '宽屏：视频封面、整墙全景', w: 16, h: 9 },
  { id: '9:16', label: '9:16', hint: '竖屏：手机全屏、通顶高柜', w: 9, h: 16 },
]

/** 取比例预设；follow / 缺省表示跟随底图。 */
function resolveRatio(id) {
  const ratio = RATIO_PRESETS.find((item) => item.id === id)
  return ratio && ratio.id !== 'follow' ? ratio : undefined
}

/**
 * 按比例算具体像素：长边取 maxSide，16 的倍数，落在 [512,2048]。
 * 与 fitSize 同一套约束，保证任何 provider 都不会收到离谱的尺寸。
 */
function sizeFromRatio(ratio, maxSide) {
  const cap = Math.min(2048, Math.max(768, Number(maxSide) || 2048))
  const snap = (value) => Math.max(512, Math.min(2048, Math.round(value / 16) * 16))
  if (!ratio || !ratio.w || !ratio.h) return null
  if (ratio.w >= ratio.h) return { width: snap(cap), height: snap((cap * ratio.h) / ratio.w) }
  return { width: snap((cap * ratio.w) / ratio.h), height: snap(cap) }
}

/** 图号对照说明：把「图1=底图，图2=参考图1」明确写给模型。无底图时编号前移。 */
function imageLegend(referenceCount, hasBase = true) {
  const total = Number(referenceCount) || 0
  if (total <= 0) return ''
  const parts = []
  if (hasBase) parts.push('图1 = 底图（结构依据）')
  for (let index = 1; index <= total; index += 1) {
    parts.push(`图${hasBase ? index + 1 : index} = 参考图${index}`)
  }
  return `【图号】${parts.join('；')}。所有对图片的引用只按这些编号理解。`
}

/**
 * 让多模态模型「读」这张底图，输出结构化清单。
 *
 * 这是本插件唯一真正让模型「读懂图纸」的地方：图片模型只会模仿像素，
 * 而视觉模型能数门板、读分格；把结果写进提示词就成了「结构规格书」。
 *
 * 注意 DeepSeek 的视觉编码：图像最小按 544×544 上采、14px 对齐、3:1 下采样，
 * 单图上限 1024 tokens。所以送进去的底图要够大够干净，小字细线才读得出来。
 *
 * @param taskModeId 任务模式 id；决定模型「看什么」（立面/线稿/模型/照片/平面）
 */
function cadReaderSystem(taskModeId) {
  const target = READER_TARGET[taskModeId] ?? READER_TARGET.elevation
  return [
    '你是建筑与室内图纸的识读工程师。看图后只输出这张图的规格清单。',
    target,
    '**结构之外，材质、颜色与五金也必须读**：图纸上标注了什么材料、什么颜色、什么拉手/五金，',
    '就是这张图的规定做法，逐字抄录进清单 —— 不要用你熟悉的做法替换它。',
    '按下面顺序输出，每条一行，用中文，不要 markdown、不要多余符号、不要任何解释或寒暄：',
    '1. 图面类型：这是什么图（立面 / 线稿 / 模型 / 照片 / 平面），以及整体宽高比例与外形',
    '2. 纵向分格：从左到右共几栏，各栏宽度的相对关系',
    '3. 横向分段：从上到下共几段，每段的功能（封闭门板 / 抽屉 / 开放格 / 台面 / 层板 / 踢脚 / 房间）与高度相对关系',
    '4. 层板与横板：各有几块、分别在什么位置',
    '5. 门板与抽屉（或门窗）：各有几扇/几个，开启方向如何',
    '6. 材质与颜色：图上标注的饰面材料、颜色、表面工艺（如「白色亚克力」「浅木纹」「岩板台面」）。',
    '   图上有引线标注/材料表/文字说明的，逐字抄录；只画了线条没写材质的，写「图上未标注材质」。',
    '   特别注明：图上哪些构件是同一材质/同种做法，是否存在局部不同做法。',
    '7. 五金与细节：拉手形式与型号、是否有灯带、玻璃、格栅等。图上有标注就抄录，没有就写「图上未标注五金」。',
    '8. 不可改动项：一句话总结「以上数量、相对位置与材质做法必须原样保留」',
    '只写你在图上真实看到的内容。看不清就写「不确定」，**绝对不要编造尺寸、数量、材质或五金**。',
    '如果你根本没有收到任何图片，只回答四个字：未收到图片。',
  ].join('\n')
}

/**
 * 视觉质检：把成品和底图对照，只判「结构是否忠实」，不合格就给出
 * 可执行的修正意见，供自动二次出图使用。
 *
 * opentai / 建筑学长这类平台「一键优化」的内核：出图 → 自查 → 修正重出。
 * 材质与光影不参与判定，否则模型会挑风格而不是挑结构。
 *
 * 判据必须跟着操作走：拿主体的「分格 / 门板 / 抽屉」去查平面图，
 * 模型只会胡报差异（实测会误判）。所以按操作给不同的判据。
 */
const QC_CRITERIA = {
  cabinet:
    '只判断两件事：1. 图2在结构上是否忠实于图1——分格数量、门板与抽屉的数量与位置、层板与横板的位置、整体比例；2. 材质一致性：除明确说明的改动外，原图上同类构件是否保持了材质与色彩的完全统一，有没有擅自拼色或乱改材质。',
  plan:
    '只判断一件事：图2在结构上是否忠实于图1——墙体位置与数量、房间划分、门窗洞口的位置与宽度、家具的种类与数量与摆放位置、整体比例。特别注意有没有丢失任何一件家具。',
  axon:
    '只判断一件事：图2是否与图1是同一个户型——墙体位置、房间划分、门窗洞口、家具的种类与数量与位置是否一致，有没有凭空增加或漏掉房间与家具。',
  diagram:
    '只判断一件事：图2是否保持了图1的设计关系（体块 / 墙位 / 家具位置），是否只叠加了分析元素而没有改动设计本身。',
}

/** 哪些操作用哪套判据。 */
const QC_MODE_CRITERIA = {
  plan: 'plan',
  'plan-3d': 'axon',
  diagram: 'diagram',
}

/**
 * 按操作生成质检提示词。
 * @param taskModeId 操作 id；不传则用主体判据（默认）。
 */
function qcSystem(taskModeId) {
  const criteria = QC_CRITERIA[QC_MODE_CRITERIA[taskModeId] ?? 'cabinet']
  return [
    '你是设计效果图的质检员。图1是底图，图2是生成的结果图。',
    criteria,
    '材质、颜色、光影、氛围一律不在判定范围内，不要因为风格不同就判不合格。',
    '严格按两行输出，不要任何多余文字：',
    '判定：合格   或   判定：需修正',
    '问题：合格时写「无」；需修正时用一句中文写清哪里不对、该怎么改，必须具体到数量与位置，例如「上部应有三块层板但只画了两块，请补一块；左侧通高侧板缺失」。',
    '只有确实看出结构差异才判需修正，不要为了挑错而编造差异。',
  ].join('\n')
}

/** 默认（主体）质检提示词，便于直接引用。 */
const QC_SYSTEM = qcSystem('elevation')

/**
 * 教 LLM 把客户的大白话整理成【本次要求】这一节。
 *
 * **注意职责边界**：基础框架（结构 / 材质 / 光影 / 画质）不归它管，
 * 框架保证出图效果、原样保留；模型只写「客户额外提出的、或要覆盖框架的」要求。
 * 这样两边各司其职：框架保效果，本次要求保符合客户意图。
 */
const COMPOSER_SYSTEM = [
  '你是效果图提示词工程师。你的任务只有一件：把客户的大白话整理成一段简短、专业、可执行的【本次要求】。',
  '',
  '重要：系统已另外提供一段「基础框架」提示词（描述结构约束、材质工艺、光影、画质），它会原样保留。',
  '- 不要复述框架里已经写好的内容（材质名、光影方向、画质词等），只写**增量**；',
  '- 客户的要求与框架冲突时，明确写出覆盖关系（例如「台面改用深色岩板，不用框架里的浅色」）；',
  '- 客户提到的每一项都要保留，不得遗漏；',
  '- 客户没提的，不要编造；',
  '- 材质统一性：若客户没有特别说明不同部件采用不同材质，默认原图上同一构件/立面保持材质与色彩完全统一，严禁自行拼色或添加杂色分块；只有客户明确指明某构件/某扇门采用特定材质或颜色时，才精准指定该部位，其余部位保持一致；',
  '- 没特别说明拉手时绝不自行编造拉手（拉手形式已在框架内锁定底图）；客户明确提及时才转换专业说法（如「不要拉手」→「反弹器或免拉手」，「明拉手」→「明装拉手」）；「暖一点」→「色温约 3000K」；',
  '- 客户给的具体名词（材料名、色号、品牌、尺寸数字）原样保留。',
  '',
  '只输出正文：3~6 个短句、60~200 个汉字，不要【段名】前缀、不要 markdown、不要列表符号、不要任何解释。',
].join('\n')

/** 取任务模式，缺省为立面渲染。 */
function resolveTaskMode(id) {
  return TASK_MODES.find((mode) => mode.id === id) ?? TASK_MODES[0]
}

/** 取风格预设；不存在或为 custom 时回 undefined。 */
function resolveStyle(id) {
  const style = STYLE_PRESETS.find((item) => item.id === id)
  return style && style.id !== 'custom' ? style : undefined
}

function resolveLighting(id) {
  const lighting = LIGHTING_PRESETS.find((item) => item.id === id)
  return lighting && lighting.id !== 'auto' ? lighting : undefined
}

const byId = (list, id) => list.find((item) => item.id === id)

/** 取水平角度；inherit/缺省表示沿用任务模式自带的视角。 */
function resolveCamera(id) {
  const azimuth = byId(CAMERA_AZIMUTH, id)
  return azimuth && azimuth.id !== 'inherit' ? azimuth : undefined
}

function resolveCameraElevation(id) {
  const elevation = byId(CAMERA_ELEVATION, id)
  return elevation && elevation.id !== 'inherit' ? elevation : undefined
}

function resolveCameraDistance(id) {
  const distance = byId(CAMERA_DISTANCE, id)
  return distance && distance.id !== 'inherit' ? distance : undefined
}

/**
 * 把三个维度拼成一句精确的机位描述。
 * 三个都是「原样」时返回空串，交给任务模式自带的视角描述。
 */
function composeCamera(azimuth, elevation, distance) {
  const parts = []
  if (azimuth) parts.push(`水平角度 ${azimuth.deg}°（${azimuth.label}）`)
  if (elevation) parts.push(`垂直角度 ${elevation.deg}°（${elevation.label}）`)
  if (distance) parts.push(`取景距离 ${distance.label}`)
  if (parts.length === 0) return ''

  const elevationNote =
    {
      low: '镜头从下往上，主体显得高耸挺拔，天花与顶部占比更大。',
      high: '镜头从上往下，能看到台面与地面的布置关系。',
      bird: '近乎垂直俯视，用于交代整体布局。',
      eye: '镜头与主体平齐，透视自然。',
    }[elevation?.id] ?? ''
  const distanceNote =
    {
      close: '画幅收窄到局部，突出材质与细节。',
      medium: '主体完整，保留少量周边环境。',
      wide: '包含更多周边环境，交代空间关系。',
    }[distance?.id] ?? ''

  return `按指定机位重新取景：${parts.join('；')}。${elevationNote}${distanceNote}透视自然真实，材质、颜色、家具与图1完全一致。`
}

/**
 * 组装最终提示词。
 *
 * 段落的取舍按优先级来：结构锁死 > 材质 > 任务帧 > 清除 > 用户补充 >
 * 视角 > 光影 > 画质 > 五金 > 空间 > 氛围。长度受限时优先用精简文案，
 * 仍然超预算就丢掉优先级最低的段；但「结构锁死」这类硬约束永不丢弃。
 *
 * @param options.taskMode  任务模式 id
 * @param options.stylePreset 风格预设 id
 * @param options.lighting  光影预设 id
 * @param options.camera     水平角度 id（也叫方位角）
 * @param options.cameraElevation 垂直角度 id（机位高低）
 * @param options.cameraDistance  取景距离 id（远近）
 * @param options.referenceCount 参考图张数（不含主图）
 * @param options.instruction 迭代改图时的「本次改动」，给了它就进入改图模式
 * @param options.structure 视觉模型读图得到的结构清单（逐条注入，优先级仅次硬约束）
 * @param options.plain     用户的原话/大白话
 * @param options.extra     额外补充
 * @param options.budget    汉字长度上限（0 = 不限）；即梦 Seedream 建议 ≤300
 */
function composePrompt(options = {}) {
  const mode = resolveTaskMode(options.taskMode)
  const style = resolveStyle(options.stylePreset)
  const lighting = resolveLighting(options.lighting)
  const referenceCount = Number(options.referenceCount) || 0
  // 无底图的模式（文生图）里，第一张图就是参考图1，编号整体前移一位。
  const baseOffset = mode.noBase ? 0 : 1
  const refs =
    referenceCount <= 0
      ? ''
      : referenceCount === 1
        ? `图${baseOffset + 1}`
        : `图${baseOffset + 1}~图${baseOffset + referenceCount}`

  // 视觉模型读出的图纸规格（结构 + 材质颜色 + 五金）。提到函数作用域，
  // 因为材质段与五金段都要用它来「压住」风格预设里的模板文字。
  const observed = typeof options.structure === 'string' ? options.structure.trim() : ''

  // 顺序即最终输出顺序；priority 越大越不该被裁掉。
  const segments = []

  if (options.instruction && String(options.instruction).trim()) {
    // 迭代改图：上一版效果图就是图1，只改用户点名的地方。
    segments.push({ name: 'frame', priority: 60, text: '在图1这张已有效果图的基础上做定向修改。' })
    segments.push({
      name: '【结构锁死】',
      priority: 100,
      text: '除下面点名的改动之外，图1的主体结构、分格、门板与抽屉的数量与位置、机位与构图全部保持不变，不得重新设计、不得改变整体比例。',
      short: '除点名改动外，图1的结构、分格、数量位置、机位与构图全部不变。',
    })
    segments.push({ name: '【本次改动】', priority: 98, text: String(options.instruction).trim() })
    // 不要在改图模式复述风格材质：它与【本次改动】可能直接冲突
    // （例如用户要把门板换成木纹，而复述里写着「奶油白哑光烤漆」）。
    segments.push({
      name: '【材质色彩】',
      priority: 80,
      text: `除【本次改动】点名的部分外，其余材质、颜色与表面工艺一律沿用图1，不要整体换风格${
        refs ? `，并与${refs}的材质关系保持一致` : ''
      }。`,
    })
  } else {
    // 首句点明任务性质：**这是给底图上材质，不是重新做设计**。
    // 「结构经常被改」的直接成因是模型把它当成一张设计委托，
    // 于是顺手把分格"美化"了。放在最前面（首因）+ 末尾再自检一次（近因）。
    if (!mode.noBase) {
      const docName =
        mode.id === 'elevation'
          ? '施工图'
          : mode.id === 'sketch'
            ? '设计线稿'
            : mode.id === 'model'
              ? '模型截图'
              : mode.id === 'photo'
                ? '实拍图'
                : mode.id === 'plan' || mode.id === 'plan-3d' || mode.id === 'plan-perspective'
                  ? '平面图'
                  : '底图'
      segments.push({
        name: '',
        priority: 98,
        text:
          `这是一张${docName}，你的任务只是把它的材质、光影与画质做成照片级效果 —— ` +
          '**不是重新设计**。图上已有的分格、比例、构件数量一律照原样保留。',
      })
    }
    // 执行优先级：把「谁说了算」写在最前面。
    //
    // 用户反复强调过：**提示词不能是固定模板，一切以他的图、他的面板选择、
    // 他的大白话为准**。但模型看到一长串硬性措辞时，会本能地优先执行那些
    // 「不要改结构」之类的通用规则，从而顶掉客户的具体要求。
    // 所以这里显式声明三级优先级，冲突时一律按此裁决。
    segments.push({
      name: '【执行优先级】',
      // 88 < 清除(90)：预算紧张时先保「清除施工图元素」，优先级声明可以让位
      priority: 88,
      text:
        '冲突时按此裁决：① 客户原话（最高，可覆盖下面任何一条）> ② 面板选择 > ③ 本文其余通用规则。' +
        '绝不许用通用规则（如「保持原样」）去顶掉客户在①②里明确提出的要求。',
      short: '【优先】客户原话 > 面板选择 > 本文通用规则；冲突时按此。',
    })
    segments.push({ name: 'frame', priority: 70, text: mode.frame, short: mode.frameShort })
    if (mode.noBase) {
      // 文生图：没有图1可锁，把用户描述本身当成必须满足的内容。
      const described = String(options.plain ?? '').trim()
      segments.push({
        name: '【画面内容（必须逐条满足）】',
        priority: 100,
        text: described || '按下面的风格与光影描述生成一张完整的效果图。',
      })
    } else {
      segments.push({ name: '【结构锁死】', priority: 100, text: mode.structure, short: mode.structureShort })
      // 视觉模型读出来的图纸规格：优先级仅次于硬约束，且属于硬约束（≥95 不裁）。
      // 这是让模型「照规格画」而不是「看着像」的关键 —— 结构、材质、五金都在里面。
      if (observed) {
        segments.push({
          name: '【图纸规定（已按图1识读，逐条必须满足）】',
          priority: 96,
          text:
            `${observed}\n` +
            '以上是图纸本身的规定做法（结构、材质、颜色、五金）。凡是图纸写明的，一律照做，不要用风格模板里的常见做法替换它。\n' +
            '如果上面的文字清单与图1画面有出入，**一律以图1画面为准** —— 清单只是识读结果，可能读错；图1才是唯一事实来源。',
        })
      }
    }
    // 分析图类型：只在「分析图」操作下出现。
    const diagram = DIAGRAM_TYPES.find((item) => item.id === options.diagram)
    if (diagram) segments.push({ name: '【分析图类型】', priority: 97, text: diagram.prompt })
    // 彩平图的制图符号规范：必须给出符号长什么样，否则模型只会在原地摆方块。
    if ((style?.group ?? '') === 'flat') {
      segments.push({ name: '', priority: 94, text: FLAT_SYMBOLS })
    }
    // 图号对照：明确告诉模型「图1是底图、图2是参考图1」，消除指代歧义。
    const legend = imageLegend(referenceCount, baseOffset === 1)
    if (legend) segments.push({ name: '', priority: 74, text: legend })
    // 机位＝水平角度 + 垂直角度 + 取景距离三个正交维度；全「原样」时用任务自带视角。
    const cameraText = composeCamera(
      resolveCamera(options.camera),
      resolveCameraElevation(options.cameraElevation),
      resolveCameraDistance(options.cameraDistance),
    )
    segments.push({
      name: '【视角构图】',
      priority: 55,
      text: cameraText || mode.view,
      short: cameraText || mode.viewShort,
    })
    // 画布比例与底图不一致时，必须显式禁止「为了填满画布而重排」。
    //
    // 这里传进来的必须是**接口实际收到的画布比例**，不是我们心里算的那个：
    // gpt-image 只认 1024x1024 / 1536x1024 / 1024x1536，竖图底图会被归到
    // 1024x1536，比例差 7% 左右 —— 模型为了填满画布就会拉伸或重排分格。
    const canvasAr = Number(options.canvasAr) || 0
    const baseAr = Number(options.baseAr) || 0
    if (canvasAr > 0 && baseAr > 0 && (canvasAr / baseAr > 1.04 || canvasAr / baseAr < 0.96)) {
      const drift = Math.round(Math.abs(canvasAr / baseAr - 1) * 100)
      segments.push({
        name: '【画布与主体】',
        priority: 93,
        text:
          `**画布比例和图1不一致（相差约 ${drift}%）**，这是画布本身的尺寸差，不是你改动设计的理由：` +
          '你必须把图1的主体**按它自己的原始比例完整地放进画面**，差额用两侧（或上下）的背景、' +
          '墙面或留白补足 —— 可以多画一点环境，但主体一格都不能动。' +
          '**绝对不许**为了填满画布而横向拉伸、压扁、改变每一格的宽度比例、增删分格或重新排布。' +
          '自检方法：把出图和图1并排看，**每一格的长宽比、每条分割线的相对位置都必须一致**。',
      })
    }
    // 质检自动重出：**只加一段修正意见，框架全部保留**。
    //
    // 踩过坑：早先走的是「迭代改图」通道（instruction + 上一版图当图1），
    // 结果那个分支不注入【图纸规定】/【视角构图】，还告诉模型「其余一律沿用图1」——
    // 第一版一旦漂移，重出反而把漂移固化了。现在始终以原始图纸为基准修正。
    const qcFix = typeof options.qcFix === 'string' ? options.qcFix.trim() : ''
    if (qcFix && !options.instruction) {
      segments.push({
        name: '【质检修正（必须执行）】',
        priority: 99,
        text:
          `上一版效果图被质检判为不忠实，问题：${qcFix}\n` +
          '请针对上述问题修正，**同时严格遵守上面所有结构与材质约束**：' +
          '结构以图1为准、材质五金以【图纸规定】为准。不要因为这次修正而改动没被点名的任何东西。',
      })
    }
    // 「沿用底图」不是一个风格，而是「不指定风格」：不能按风格段注入材质。
    const styleUsable = Boolean(style && (style.group ?? 'interior') !== 'none' && (style.material || style.detail)) && !modeInheritsStyle(mode.id)
    if (styleUsable) {
      // 参考图若是「一张完整的房间效果图」，模型会直接照抄它的构图。
      // 所以材质段必须显式禁止复制参考图内容 —— 实测这是最常见的跑偏原因。
      const anti = refs ? `只取${refs}的材质与色彩，绝对不要复制其构图、家具、房间布局、人物或水印。` : ''
      // 只有家居风格是按主体写的；彩平/轴测/分析图/概念风格自带完整措辞。
      const isInterior = (style.group ?? 'interior') === 'interior'
      const lead = isInterior && GENERIC_MATERIAL_MODES.has(mode.id)
        ? '以下材质按画面中对应位置的构件理解（原文的「门板」指该位置的立面饰面，「台面」指该位置的台面）：'
        : ''
      // 图纸规定了材质时，**图纸压住风格模板**：图纸说用什么就用什么。
      //
      // 关键：这时**不能再把风格预设的材质原文放进来**。踩过坑 —— 两套材质
      // （图纸「白色亚克力 / 黑色岩板」+ 风格「奶油白烤漆 / 浅色岩板」）同时出现，
      // 模型只能二选一，表现就是「材质经常被改」。风格只保留光影 / 氛围 / 陈设。
      segments.push({
        name: '【材质色彩】',
        priority: 95,
        text: observed
          ? refs
            ? `材料种类、颜色与五金形式以【图纸规定】为准；具体纹理、光泽与色感以${refs}为准。若无特别说明，原图上同类构件保持同一材质与色彩统一，严禁擅自拼色。风格预设只体现在光影、氛围与陈设上，不要用风格模板里的材料名去替换图纸写明了的材料。${anti}`
            : '材料种类、颜色、五金形式以【图纸规定】为准。若无特别说明，原图上同类构件保持同一材质与色彩统一，严禁擅自拼色。风格预设只体现在光影、氛围与陈设上，不要用风格模板里的材料名去替换图纸写明了的材料。'
          : refs
            ? `材质、颜色、纹理与表面工艺完全以${refs}为准：只提取${refs}展示的真实材质、颜色与表面质感（如饰面板、木纹、石材、岩板、烤漆或金属等），严格按${refs}的真实色彩与材质表现。若无特别说明，原图上是同一材质的构件渲染出来必须保持完全相同材质与色彩，绝不套用任何未在参考图和底图中出现的固定模板材料或拼色。${anti}`
            : `${lead}${style.material}若无特别说明，原图上同一材质的构件渲染出来必须保持完全一致，严禁擅自拼色或混搭材质。`,
        short: observed
          ? '材质、颜色与五金以【图纸规定】为准，风格只管光影氛围陈设。'
          : refs
            ? `材质、颜色与表面工艺完全以${refs}为准；只取材质，不要复制其构图、家具或水印。`
            : style.material,
      })
      if (isInterior) {
        const metalText = (style && style.metal) || (style && style.hardware ? style.hardware.replace(/^[^，。]+[，。]/, '') : '')
        let hardwareText = ''
        if (observed) {
          // 图纸写了五金就照图纸，不再复述风格模板的拉手（两套会互相打架）。
          hardwareText =
            '拉手与配件形式以【图纸规定】为准：底图画了什么、图纸写了什么就做什么（底图为免拉手则做免拉手、为反弹器无拉手则做无拉手、为明拉手则做明拉手，拉手位置、长短与数量一律照图1原样保留），不要默认免拉手、也不要默认明装拉手，除非有特别说明。图纸未写明时，用与图纸材质协调的简洁做法。门板之间留 3~5mm 均匀阴影缝，主体与墙面、地面交接处收口干净。'
        } else if (!mode.noBase) {
          // 有底图时（立面施工图/线稿/模型/照片），拉手严格根据底图来：
          // 有些是免拉手、有些是反弹器无拉手、有些是明拉手，不能硬编码某种特定拉手。
          hardwareText =
            `拉手与开启方式严格以图1底图为准：底图画了什么就做什么（底图为免拉手则做免拉手、为反弹器无拉手则做无拉手、为明拉手则做明拉手，拉手位置、长短、样式与数量严格按照图1底图来），除非有特别说明，绝对不要主观臆造或默认免拉手/明拉手。${refs ? `金属配件的色泽质感参考${refs}，` : ''}${metalText}门板之间留 3~5mm 均匀阴影缝，主体与墙面、地面交接处收口干净。`
        } else {
          // 文生图等无底图模式，沿用风格预设的拉手建议。
          hardwareText = `${style.hardware}门板之间留 3~5mm 均匀阴影缝，主体与墙面、地面交接处收口干净。`
        }
        segments.push({
          name: '【五金细节】',
          priority: 30,
          text: hardwareText,
        })
      } else if (style.detail) {
        // 彩平/轴测/分析图没有拉手，换成它们各自的「细节处理」。
        segments.push({ name: '【细节处理】', priority: 30, text: style.detail })
      }
      const sceneText = !mode.noBase
        ? '背景墙面与地面保持素雅干净、适当留白，环境只作为衬托主体的自然背景（允许适当虚化与留白），绝不能因此改变主体的构图、分格或比例。'
        : `${style.scene}环境只作为背景：允许适当虚化与留白，绝不能因此改变主体的构图、分格或比例。`
      segments.push({ name: '【空间环境】', priority: 25, text: sceneText })
      segments.push({ name: '【氛围】', priority: 20, text: style.mood })
    } else if (refs) {
      // 没选风格但有参考图（含「风格迁移」）：材质完全交给参考图。
      segments.push({
        name: '【材质色彩】',
        priority: 95,
        text: `材质、颜色、纹理、表面工艺（哑光/亮光/木纹/烤漆/岩板/玻璃）与五金拉手样式完全参照${refs}，材质区分度清晰。只取${refs}的材质与色彩，绝对不要复制其构图、家具、房间布局、人物或水印。`,
        short: `材质、颜色、纹理、表面工艺与五金完全参照${refs}；只取材质，不要复制其构图、家具或水印。`,
      })
    } else if (MODE_INHERITS_STYLE.has(mode.id)) {
      // 换视角 / 照片优化：必须沿用底图的材质色彩，否则就不是同一个空间了。
      segments.push({
        name: '【材质色彩】',
        priority: 95,
        text: '材质、颜色与表面工艺完全沿用图1，不要换风格、不要换色系、不要替换任何材料；只处理视角与画质。',
        short: '材质色彩完全沿用图1，不要换风格。',
      })
    }
    segments.push({
      name: '【光影】',
      priority: 50,
      // 防御：任何一个风格预设漏了 light 字段，都必须回落到默认描述。
      // 否则会把字面量 "undefined" 拼进提示词发给模型（踩过一次）。
      //
      // 沿用底图材质的模式（换视角 / 照片优化 / 洗图）：光影也必须沿用图1 ——
      // 否则洗图会把原图的光换掉（比如硬塞一套暖光 3000K），那就不是洗图了。
      text: modeInheritsStyle(mode.id)
        ? '**光照必须与图1完全一致，不要重新打光。**逐项对齐：光源的方向与数量、主光与辅光的强弱关系、色温冷暖、整体明暗与对比度、阴影的软硬与投射方向、高光的位置与强度、暗部保留的细节、环境反射与氛围色。只允许让光影更干净、更细腻、层次更清楚，不允许改变它的性质。'
        : (lighting ? lighting.prompt : style ? style.light : '') || '柔和自然的室内灯光，真实阴影与反射。',
      short: modeInheritsStyle(mode.id)
        ? '光照必须与图1完全一致，不要重新打光；只让光影更干净细腻。'
        : '柔和自然的室内灯光，真实阴影与反射。',
    })
    segments.push({ name: '【清除】', priority: 90, text: mode.cleanup, short: mode.cleanupShort })
  }

  // 画质段必须跟着风格组走：彩平/分析图要的是图形语言，不是摄影语言。
  const quality = qualityOf(style)
  segments.push({
    name: '【画质】',
    priority: 40,
    text: quality.text,
    short: quality.short,
  })

  // 光影复述。
  //
  // 为什么要在末尾**再说一遍**：洗图/换视角这类「只提画质」的任务里，模型最
  // 容易翻车的地方就是**顺手把光重打一遍** —— 它会本能地把画面调得更暖、更亮、
  // 更"好看"，于是原图的布光被换掉。中段的【光影】段在这种长提示词里最容易被
  // 忽略，所以按近因效应在末尾重述一次，并把要核对的项目逐条列出来。
  if (modeInheritsStyle(resolveTaskMode(options.taskMode).id)) {
    segments.push({
      name: '【光影复述（务必遵守）】',
      priority: 96,
      text:
        '**再强调一次：这是一次画质提升，不是重新打光。**' +
        '交付前逐项比对图1 —— 光源方向与数量、主辅光强弱关系、色温冷暖、' +
        '整体明暗与对比度、阴影软硬与投射方向、高光位置与强度、暗部细节、环境反射与氛围色。' +
        '**上面每一项都必须和图1一致**；只允许让它更干净、更细腻、层次更清楚。',
      short: '**再强调：不是重新打光。**光源方向、色温、明暗对比、阴影与高光位置必须与图1一致。',
    })
  }

  // 末尾再自检一次（近因效应）。长提示词里中段的约束最容易被忽略，
  // 所以核心的「结构不许改」既放开头也放结尾，并给出可执行的自检动作。
  //
  // 自检项必须**跟着操作走**：彩平图没有门板/拉手，拿这些去核对只会让模型胡报
  // （用户反馈过「彩平图里出现拉手」）。
  if (!options.instruction && !resolveTaskMode(options.taskMode).noBase) {
    const checkGroup = (resolveStyle(options.stylePreset)?.group ?? 'interior')
    const isPlanLike = checkGroup === 'flat' || checkGroup === 'diagram'
    segments.push({
      name: '【交付前自检】',
      priority: 45,
      text: isPlanLike
        ? '画完先和图1逐项核对，任何一项不一致就按图1重画：墙体位置与房间划分、' +
          '门窗洞口的位置与宽度、家具的种类/数量/摆放位置与朝向、' +
          '材质统一性。**图1是平面图，它长什么样就画成什么样，不要美化、不要简化。**'
        : '画完先和图1逐项核对，任何一项不一致就按图1重画：分格的栏数与每栏宽度比例、' +
          '从上到下每段的高度比例、每条分割线的位置、门板与抽屉的数量与开启方向、' +
          '材质统一性（除特别说明外，图1原本同一材质的部位必须保持完全一致，严禁擅自拼色）、' +
          '拉手有无与形式（免拉手/反弹器/明拉手严格照图1）、' +
          '玻璃/格栅/灯带等构件的有无。**图1是施工图，它长什么样就画成什么样，不要美化、不要对称化、不要简化。**',
    })
  }

  const tail = [options.plain, options.extra]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join('；')
  if (tail) {
    // 客户原话是**最高优先级**：它是唯一能合法推翻上面所有通用规则的东西。
    // 名字里就把这件事写清楚，模型才不会把它当成一句「补充说明」忽略掉。
    segments.push({
      // 名字要短：方舟预算只有几百字，段名本身也占额度，而这一段绝不能因为
      // 「名字太长」被挤掉。优先级由【执行优先级】统一声明，这里不重复。
      name: '【客户原话（最高优先）】',
      priority: 100,
      text: tail,
    })
  }

  const budget = Number(options.budget) || 0
  // 最后一道防线：任何一段正文缺失、或拼进了 undefined / null 字面量，
  // 都在这里被清掉 —— 绝不让占位符漏进真正发给模型的提示词（踩过一次）。
  const clean = segments
    .filter((segment) => typeof segment.text === 'string')
    .map((segment) => ({
      ...segment,
      text: segment.text.replace(/\b(?:undefined|null)\b/g, '').replace(/\s{2,}/g, ' ').trim(),
      short:
        typeof segment.short === 'string'
          ? segment.short.replace(/\b(?:undefined|null)\b/g, '').replace(/\s{2,}/g, ' ').trim()
          : segment.short,
    }))
    .filter((segment) => segment.text.length > 0)

  // 段名以【】开头就作为提示词里的段落标签输出，任务帧不加标签。
  const render = (segment, tight) => {
    const text = tight && segment.short ? segment.short : segment.text
    return segment.name.startsWith('【') ? `${segment.name}${text}` : text
  }
  if (budget <= 0) return clean.map((segment) => render(segment, false)).join('\n')

  // 先按优先级挑出放得下的段（优先用精简文案），再按原顺序输出。
  // 注意用**下标**做键：好几个段落的 name 是空串（图号说明等），
  // 用 name 当键会互相串（留下一个就全留下）。
  const byPriority = clean
    .map((segment, index) => ({ segment, index }))
    .sort((left, right) => right.segment.priority - left.segment.priority)
  const keep = new Set()
  let used = 0
  for (const { segment, index } of byPriority) {
    const text = render(segment, true)
    const cost = text.length + 1
    // priority ≥ 95 是硬约束（结构锁死、材质、本次改动），再超也要留。
    if (segment.priority < 95 && used + cost > budget) continue
    keep.add(index)
    used += cost
  }
  return clean
    .filter((_, index) => keep.has(index))
    .map((segment) => render(segment, true))
    .join('\n')
}

/**
 * 组装负向提示词，可追加用户自定义项。
 *
 * @param extra 用户自定义
 * @param style 选中风格；彩平类会额外带上「不要画成实景俯拍照片」那组词
 */
function composeNegative(extra, style) {
  const parts = [NEGATIVE_PROMPT]
  if ((style?.group ?? '') === 'flat') parts.push(NEGATIVE_FLAT)
  const tail = typeof extra === 'string' ? extra.trim() : ''
  if (tail) parts.push(tail)
  return parts.filter(Boolean).join(', ')
}

export {
  TASK_MODES,
  DIAGRAM_TYPES,
  QUICK_ACTIONS,
  FLAT_SYMBOLS,
  NEGATIVE_FLAT,
  STYLE_PRESETS,
  STYLE_SWATCHES,
  LIGHTING_PRESETS,
  CAMERA_PRESETS,
  CAMERA_AZIMUTH,
  CAMERA_ELEVATION,
  CAMERA_DISTANCE,
  CAMERA_COMBOS,
  resolveCameraElevation,
  resolveCameraDistance,
  composeCamera,
  QUALITY_SEGMENT,
  NEGATIVE_PROMPT,
  COMPOSER_SYSTEM,
  CAD_READER_SYSTEM,
  cadReaderSystem,
  resolveImageMentions,
  imageLegend,
  QC_SYSTEM,
  composePrompt,
  composeNegative,
  resolveTaskMode,
  resolveStyle,
  resolveLighting,
  resolveCamera,
  RATIO_PRESETS,
  resolveRatio,
  sizeFromRatio,
  styleGroupsOf,
  stylesOf,
  styleIsFixedToBase,
  modeInheritsStyle,
  uiOf,
  qcSystem,
  MODE_STYLE_GROUPS,
  MODE_UI,
}
