# Private Archive · Three.js V3 Award Direction 交付记录

更新时间：2026-08-13
执行身份：Codex2 / DevSpace
项目：`D:\wendangcodex\Codex2\telegram-private-media-vault`

## 已交付方向

V3 在 V2 `Exposed Memory / Living Darkroom` 上增加一个单一、可识别的视觉签名：

**Memory Aperture / 记忆光阑**。

它只出现在未搜索、未分类、未进入 focused-search 的主时间线首页。搜索、分类和其他功能路由继续使用紧凑的档案式页面头，避免真实图库被 3D 展示层占据。

## 视觉与技术实现

### Three.js

新增：`src/web/components/MemoryAperture.tsx`

使用现有 `three`，动态加载，无新增 3D 依赖。

场景由程序化资产组成：

- 自定义 GLSL 的 Icosahedron “乳剂晶体”外壳
- 低透明 wire shell
- 暖色曝光内核
- 七边光阑轮廓
- 2 / 4 组偏心 Torus 索引轨道
- 220 / 760 个银盐 Points 粒子
- 2 / 5 个 contact-sheet 线框
- sage / amber 双点光与暖色环境光
- pointer 微偏转
- scroll 收束与转向
- offscreen / hidden tab pause
- ResizeObserver
- WebGL context-loss fallback
- 完整 geometry / material / renderer dispose

没有拉取外部 3D 模型、HDRI、远程纹理或授权不清晰的视觉资产，也没有增加 SSAO、DOF、实时阴影或高成本 post-processing。

### GSAP

更新：`src/web/components/MotionDirector.tsx`

- 保留原 route exposure、导航 glyph、PageIntro、folio / media reveal。
- 首页存在 Memory Aperture 时才动态加载 `gsap/ScrollTrigger`。
- 增加 Hero copy / stage / labels 的导演式进入。
- 增加一个短 ScrollTrigger scrub：Hero 离场时轻微上移、收束、转向。
- 无 pin、无 scroll-jacking、无假水平滚动。
- reduced-motion 下不创建 GSAP choreography。

### 响应式

更新：`src/web/styles/main.css`

- Desktop：双栏“展览封面 + 3D 舞台”。
- Tablet ≤1023：切成单栏，避免 768 宽度出现最小列宽溢出。
- Mobile ≤767：更短舞台、更小标题、更少标签、更低场景复杂度。
- ≤430：继续压缩舞台并隐藏次要右侧标签。
- reduced-motion：Hero canvas 隐藏，静态 CSS aperture poster 保留。

## UX 规则

更新：`src/web/pages/TimelinePage.tsx`

完整 Hero 只在：

- `/`
- 无 `q`
- 无 `category`
- 无 `focus=search`

时显示。

所以搜索、分类、手机搜索焦点都不会先穿过一个大 3D 首屏。

## 设计源文件

已更新：

- `.design/DESIGN.md`
- `website.config.json`
- `docs/design/art-threejs-v3-award-plan.md`

设计签名已经从单纯的 ambient emulsion field 升级为：

`Memory Aperture: procedural emulsion crystal + exposure core + aperture/index orbits + silver particles + contact-sheet frames`。

## 性能预算

Desktop Hero：

- DPR ≤ 1.25
- target loop ≈ 42 fps
- 760 particles
- Icosahedron detail 4
- offscreen / hidden tab pause

Mobile Hero：

- DPR ≤ 0.85
- target loop ≈ 22 fps
- 220 particles
- Icosahedron detail 2
- two primary orbits

生产构建中：

- 主应用 JS：约 135.05 KB gzip
- `three`：独立动态 chunk，约 132.90 KB gzip
- `gsap`：独立 chunk，约 27.33 KB gzip
- `ScrollTrigger`：独立 chunk，约 17.59 KB gzip

Vite 会对未压缩 minified Three.js chunk 给出 >500 KB 的通用 chunk-size warning，但 Three.js 没有进入主应用 chunk。

## 验证

### `npm run check`

通过：

- website config validate
- ESLint
- TypeScript
- Vitest：10 files / 42 tests
- Vite production build
- PWA generateSW

### `tests/e2e/visual-atmosphere.spec.ts`

最终：

- 11 passed
- 5 skipped（desktop/mobile 条件性测试的预期 skip）

覆盖：

- route-aware archive atmosphere
- home Memory Aperture
- search state removes Hero
- reduced-motion static aperture poster
- reduced-motion global atmosphere fallback
- 375 / 430 / 768 / 1280 / 1440 viewport sweep
- mobile Hero no horizontal overflow
- mobile atmosphere viewport coverage
- mobile bottom navigation fixed while scrolling

### `tests/e2e/archive-smoke.spec.ts`

最终：

- 12 passed
- 8 skipped（按 desktop/mobile 场景条件预期）

覆盖：

- timeline + Viewer
- horizontal / vertical viewer fit
- album create/delete
- bulk trash without deleting Telegram original
- discover custom module
- strict category filter
- upload sheet desktop/mobile
- Telegram auto-sync
- mobile bounded multi-select photo-library import flow
- viewer soft-delete

## 多 Agent 状态

本轮按要求启动了多个独立只读评审：

- Pi：设计评审，启动成功，但截至主交付完成仍停留在 `running`，没有 final response。
- Cursor：技术美术评审，启动成功，但截至主交付完成仍停留在 `running`，没有 final response。
- Copilot：UX / performance jury review，启动成功，但截至主交付完成仍停留在 `running`，没有 final response。
- Claude：因本机 provider 未登录，明确返回错误。

因此没有把未返回的 Agent 意见冒充成设计结论。本轮实际决策由主控结合：

1. 当前获奖互动站点的设计方法参考；
2. Codex2 已安装的 Three.js / GSAP / UI-UX / web performance / responsive / test skills；
3. 当前真实产品结构和已有 V2 艺术语言；
4. 实际 TypeScript / build / Playwright 回归结果；

完成收敛与实施。

## 当前部署状态

本轮只完成本地项目代码、设计源文件、构建和浏览器回归验证。

**尚未在本轮执行新的 Cloudflare production deploy。**

这是刻意保留的发布边界：先让 V3 代码通过全部本地验收，再决定是否替换当前线上版本。
