# Private Archive · 艺术感 Three.js 网页 V2 执行策划

更新时间：2026-08-13
执行身份：Codex2 / DevSpace
项目：`D:\wendangcodex\Codex2\telegram-private-media-vault`

## 1. 目标

在不破坏现有上传、批量导入、时间线、人物、地点、相册、Viewer、Queue、Cloudflare Worker/D1/Telegram 原件链路的前提下，把当前 UI 从“设计感较强的私人图库”提升为“具有明确艺术指导的数字摄影档案”。

最终体验应像一间会缓慢显影的私人数字暗房，而不是 SaaS Dashboard、通用相册或单纯 Three.js 炫技页。

## 2. 核心概念：Exposed Memory / 显影中的记忆

视觉语言由四层组成：

1. **Photographic Chemistry**：Three.js Shader 负责纸张、乳剂、银盐颗粒、漏光、显影液云团、接触印样边框等低频气氛。
2. **Editorial Archive**：DOM/CSS 负责强排版、留白、日期索引、档案编号、非对称照片墙与细线结构。
3. **Measured Motion**：GSAP 只编排页面进入、路线切换、日期章节和照片出现，不做滚动劫持、无限旋转大物体或抢内容注意力的动效。
4. **Functional Silence**：上传、搜索、筛选、批量选择、Viewer 等交互必须比视觉特效优先，艺术层失败时功能完整可用。

## 3. 灵感抽取

参考方向只提取方法，不复制具体作品：

- Awwwards / ICG Galleries：3D、Shader、Typography 作为统一体验，而不是孤立背景。
- Awwwards / EXPO 58：纸张、照片、展览目录、复古档案的实体感。
- Awwwards / Maël Ruffini Portfolio：Three.js 场景与图片转场语言。
- Awwwards / bryantcodes.art：GLSL noise / shader / transition 的实验性。
- Three.js 官方 post-processing 思路：后处理只在价值明确时加入，优先控制成本与降级。

## 4. 视觉系统调整

### 4.1 字体

- UI/正文继续使用 Inter / system sans，保持中文可读性。
- 大标题增加本地 serif display fallback：`Iowan Old Style`, `Baskerville`, `Times New Roman`, `Noto Serif SC`, serif。
- 形成“展览标题 + 档案信息”的双字体系统，而不是全站一套无衬线。
- 不引入远程字体，避免首屏阻塞和隐私依赖。

### 4.2 页面构图

- Page Intro 扩大上下留白，标题变成更强的画册封面比例。
- accession count 从普通统计块升级为“档案登记戳”式信息。
- 保留右侧竖排 `PRIVATE / INDEXED / YOURS`，但降低 UI 感，增强版式感。
- 日期章节标题加强“索引页”感觉：细线、日期、数量和 archive code 分离。

### 4.3 图片墙

- 保留 CSS Grid 和 DOM 顺序，不上 JS masonry。
- 桌面维持 5 列基础，但加入更有节奏的 editorial spans 和轻微错位感。
- 图片默认边缘增加极弱的内框/纸边；hover 仅做非常小的 scale、对比和 caption reveal。
- 不做强烈 3D tilt，避免照片本体被特效抢走。

## 5. Three.js V2

### 5.1 目标

把当前“抽象颜色云”升级为可被识别为摄影工艺语言的动态场：

- warm paper base
- silver grain
- amber/red light leak
- sage/oxide chemistry cloud
- contact-sheet frame traces
- aperture-like exposure bloom
- route-aware scene palette
- pointer response
- scroll-linked slow exposure shift

### 5.2 技术约束

- 保持动态 import Three.js。
- WebGL canvas 始终 decorative / `aria-hidden`。
- DPR：桌面最多 1.2，移动最多 0.9。
- 帧率：桌面约 30 fps，移动约 18 fps。
- reduced-motion / saveData / WebGL failure 使用 CSS fallback。
- background tab 暂停。
- 只使用一个全屏 plane shader，不引入 GLTF、大纹理、实时阴影或昂贵后处理。
- 保持资源 dispose 和 ResizeObserver 清理。

## 6. GSAP V2 动效编排

### 页面进入

1. route exposure veil 轻微显影退场。
2. eyebrow → title → description → accession count 分段进入。
3. 当前导航 glyph 轻微校准。

### 日期章节

- folio rule 从上到下绘制。
- 日期与 archive count 错峰出现。
- 仅视口内照片做 stagger；每项位移控制在约 18–24px。
- 不为长列表一次性创建大量 tween。

### reduced motion

- 不创建 GSAP motion choreography。
- CSS animation 全部关闭或静态化。
- 页面内容直接可见。

## 7. 新增“路线曝光层”

在 `ArchiveAtmosphere` 内加入一个轻量 DOM overlay：

- `.route-exposure-veil`
- 用 GSAP 在 route change 时控制 `autoAlpha` + `scale`，模拟换片/显影，而不是整页 fade。
- 该层 pointer-events:none，不阻塞 UI。

## 8. 响应式

### Desktop ≥ 1280

- 强化封面感和留白。
- 允许更大胆的 title size 和 grid span。

### Tablet 768–1279

- 保留艺术层，但减少标题尺寸和 grid 跨列。

### Mobile < 768

- 保留极轻 Three.js shader（18fps/0.9 DPR），不加载昂贵资产。
- 关闭依赖 hover 的表现。
- Bottom Nav 仍是主要操作入口。
- Page Intro 不做过度竖排或超大文字，避免首屏只能看标题。
- 375/430 宽度无横向滚动。

## 9. 实施文件

重点修改：

- `src/web/components/ArchiveAtmosphere.tsx`
- `src/web/components/MotionDirector.tsx`
- `src/web/styles/main.css`
- `.design/DESIGN.md`
- `tests/e2e/visual-atmosphere.spec.ts`

原则上不改 Worker/D1/API/上传核心逻辑。

## 10. 验收标准

### 视觉

- 首屏一眼能感受到摄影画册/数字暗房，而不是后台管理页面。
- Three.js 与 DOM 排版属于同一套视觉语言。
- 图片是主角，背景和动效不抢主体。

### 功能

- Timeline、Discover、People、Places、Albums、Search、Upload、Viewer、Queue 均可正常使用。
- route scene 切换仍正确。

### 动效

- route exposure veil 工作。
- intro 和 timeline section 有 GSAP choreography。
- `prefers-reduced-motion` 下 canvas motion 和 CSS infinite motion 停止。

### 性能

- 不增加大模型/纹理/远程字体。
- Three.js 继续独立 lazy chunk。
- 移动端低 DPR / 低 fps。
- tab hidden 停止 render loop。

### 测试

- lint / typecheck / unit / build 通过。
- desktop + mobile visual-atmosphere E2E 通过。
- 重点验证 375 / 768 / 1280 / 1440 与 reduced-motion。

## 11. 执行顺序

1. 固化策划与设计系统。
2. 重构 Three.js shader / route exposure layer。
3. 重构 GSAP choreography。
4. 调整 typography / intro / folio / media grid / navigation art direction。
5. 更新 reduced-motion 与移动端 CSS。
6. 更新 E2E 验收。
7. 全量检查、构建、Playwright。
8. 最终只交付已验证的实际网页代码与结果，不停留在策划说明。
