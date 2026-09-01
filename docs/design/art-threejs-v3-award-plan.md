# Private Archive · Three.js V3 Award Direction

更新时间：2026-08-13
执行身份：Codex2 / DevSpace
项目：`D:\wendangcodex\Codex2\telegram-private-media-vault`

## 1. 目标

在保留现有 Telegram 原件链路、Cloudflare Worker/D1、上传、搜索、Viewer、时间线、人物、地点、相册与移动端底栏的前提下，把 V2 的“Exposed Memory / 显影中的私人档案”提升为更接近 Awwwards / CSS Design Awards 交互作品的 V3。

本轮不是增加大量互不相关的特效，而是引入一个明确、可识别、可复述的主视觉签名：

**Memory Aperture / 记忆光阑**。

它是一个由“镜片 / 光阑 / 档案框 / 银盐颗粒 / 轨道”组成的实时 Three.js 记忆雕塑，仅在主时间线首页承担视觉高潮；进入搜索、分类或其他功能路线后回到更安静的档案布局。

## 2. 参考结论

从近期 CSS Design Awards 和 Awwwards 的 3D/WebGL/互动作品中抽取方法，不复制具体视觉：

1. 高评分作品往往有一个非常明确的体验核心，而不是很多互不相关的效果。
2. WebGL / Three.js 的价值在于成为内容和叙事的一部分，而不是纯背景。
3. 创新得分高并不意味着 UX 可以牺牲；交互路径、内容可达性和移动端完成度仍然重要。
4. 3D 资产、GLSL、排版和动效需要共享同一套材质语言。
5. 获奖感更多来自“导演式节奏”：进入、停留、响应、离场都有层次，而不是一直高速运动。

V3 因此采用：**一个主雕塑 + 一套光学材质 + 一套轨道运动 + 一套档案标注语言**。

## 3. 核心概念：Memory Aperture / 记忆光阑

### 3.1 视觉含义

中心体不是普通球体，也不是泛用科技地球：

- 外层：半透明“乳剂晶体”，像被显影液腐蚀过的镜片。
- 中层：多个偏心轨道，模拟光圈、快门和档案索引环。
- 内核：暖色曝光核心，像一张尚未显影完成的底片。
- 周围：稀疏银盐粒子与接触印样框，建立摄影而不是科幻 UI 的语义。
- 轨道标签：`EXPOSURE / INDEX / PRIVATE FIELD` 等极少量档案式标注。

### 3.2 交互

Desktop：

- 指针移动只产生约 8–14° 的跟随偏转，不做夸张 3D tilt。
- 轨道持续缓慢错速转动。
- 页面向下滚动时雕塑略微下沉、转向、收束，像关闭光圈后交还给照片墙。
- GSAP 负责编排标题、标注、主舞台进入与离场；Three.js 自身负责实时物理感。

Mobile：

- 降低几何细分、粒子数量、DPR 和帧率。
- 不依赖 hover。
- 舞台高度受限，避免首屏只剩 3D。
- 页面功能与底部导航优先。

Reduced motion / Save Data：

- 不启动实时 Three.js。
- 保留 CSS 构成的静态光阑海报作为艺术 fallback。
- 所有文字、搜索、筛选、上传、浏览功能完整可用。

## 4. 技术方案

### Three.js

继续使用现有 `three`，不新增 React Three Fiber。

新增独立组件：

- `src/web/components/MemoryAperture.tsx`

组件使用动态 `import('three')`，与应用主体解耦。

场景组成：

1. `PerspectiveCamera`
2. 程序化 `IcosahedronGeometry` 乳剂晶体
3. 自定义 GLSL vertex/fragment shader
4. 内部曝光核心球
5. 3–4 组偏心 Torus 轨道
6. 稀疏银盐 Points 粒子场
7. 轻量 contact-sheet frame 线框
8. pointer + scroll response
9. ResizeObserver / IntersectionObserver / visibility pause
10. 完整 dispose / WebGL context loss fallback

不引入：

- 大型 GLB
- HDRI
- 实时阴影
- SSAO / DOF / 多层昂贵 post-processing
- 外部远程纹理

原因：当前应用本身还承担真实图库和移动端功能，主视觉应高辨识度但不能把生产图库变成 GPU benchmark。

### GSAP

保留现有 route / folio 动效，同时增强首页：

- Memory Aperture copy 分段进入
- 3D stage 从轻微失焦/缩放状态显现
- archive labels 错峰出现
- 使用 ScrollTrigger 做短范围 scrub：舞台缓慢收束并向上离场
- 不 pin 页面，不 scroll-jack，不做假水平滚动

### CSS

首页 Hero 从普通 `PageIntro` 升级为专门的双栏展览封面：

- 左：超大 serif 标题 + 极少说明
- 右：Memory Aperture 3D 舞台
- 细线、档案编号、坐标式注记连接 DOM 与 3D
- 背景继续沿用 warm mineral paper / sage / amber / oxide

## 5. 视觉预算

Desktop：

- hero canvas DPR ≤ 1.25
- 目标 36–45 fps，而不是强求 60 fps
- 粒子约 600–900
- Icosahedron detail 4–5
- 页面不可见时暂停
- Hero 离开视口后暂停

Mobile：

- DPR ≤ 0.85
- 目标 20–24 fps
- 粒子约 180–280
- Icosahedron detail 2–3
- 两组主要轨道即可

Background atmosphere 继续维持原预算，不与 Hero 同时无限拉高成本。

## 6. 页面规则

### `/` 主时间线且没有搜索/分类参数

启用完整 Memory Aperture Hero。

### `/?q=...`、`/?category=...`

回到普通 PageIntro，避免搜索结果被大 Hero 占据。

### 其他路线

继续 V2 Exposed Memory 体系，不复制 3D Hero。

这是 V3 保持“奖项感”与“真实产品 UX”平衡的关键。

## 7. 不做的东西

- 不增加旋转地球、宇宙星空、机器人、液态金属、霓虹 HUD 等与私人摄影无关的通用炫技。
- 不把每张照片做强 3D tilt。
- 不使用长时间 pin / scroll-jacking。
- 不让 3D canvas 接管按钮、导航或搜索。
- 不在移动端照搬桌面的密度。
- 不为了“看起来高级”拉取来源与授权不清楚的 3D 模型。

## 8. 预计修改文件

- `src/web/components/MemoryAperture.tsx`（新增）
- `src/web/pages/TimelinePage.tsx`
- `src/web/components/MotionDirector.tsx`
- `src/web/styles/main.css`
- `.design/DESIGN.md`
- `website.config.json`
- `tests/e2e/visual-atmosphere.spec.ts`
- `docs/design/art-threejs-v3-award-plan.md`

## 9. 验收标准

### 视觉

- 首页第一眼有明确、独有、可复述的 3D 视觉符号。
- 3D 与摄影档案语义一致，不像模板科技站。
- 页面往下滚动后照片重新成为主体。

### UX

- 搜索/分类结果不被大 Hero 干扰。
- 上传、筛选、选择、Viewer、导航全部保持原交互。
- Mobile 375 / 430 无横向溢出，底部导航始终固定。

### A11y

- canvas 仅装饰并 `aria-hidden`。
- reduced-motion 下无实时 3D。
- 所有核心信息保留语义 DOM。

### 性能

- Three.js 仍动态加载。
- Hero 只在首页主态出现。
- 离开视口/切后台停止渲染。
- 不新增大型远程资产或模型。

### 工程

- lint / typecheck / unit / build 通过。
- visual atmosphere E2E 增加首页 Hero、reduced-motion、mobile 几何验证。
