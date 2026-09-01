# Private Archive · 艺术感 Three.js V2 交付记录

更新时间：2026-08-13
执行身份：Codex2 / DevSpace
生产 Worker：`private-archive`

## 已交付方向

本轮将现有 Living Darkroom 视觉升级为 **Exposed Memory / 显影中的私人档案**。

目标不是增加更多 3D 物件，而是让 Three.js、GSAP、编辑排版、摄影档案信息成为同一套艺术语言：

- Three.js：摄影化学场、halation 光环、registration marks、contact-sheet frame traces、银盐颗粒与慢曝光偏移。
- GSAP：路线显影、导航校准、标题分段进入、日期 folio 绘制和照片错峰显现。
- CSS / Typography：本地 serif 展览标题 + sans UI 双字体系统，更大的编辑留白、更弱的 Dashboard 卡片感、更薄的照片纸边。
- Mobile / A11y：保留低帧率/低 DPR，reduced-motion、saveData、WebGL failure 全部有静态降级。

## 关键改动文件

- `src/web/components/ArchiveAtmosphere.tsx`
- `src/web/components/MotionDirector.tsx`
- `src/web/styles/main.css`
- `.design/DESIGN.md`
- `tests/e2e/visual-atmosphere.spec.ts`
- `docs/design/art-threejs-v2-plan.md`

未修改 Worker API、D1 schema、Telegram webhook、上传业务核心逻辑。

## 本地验证

### `npm run check`

通过：

- website config validate
- ESLint
- TypeScript
- Vitest：10 files / 42 tests
- Vite production build
- PWA generateSW

Three.js 继续为独立动态 chunk；没有加入 GLTF、大纹理或远程字体。

### 视觉专项 E2E

`tests/e2e/visual-atmosphere.spec.ts`：

- 4 passed
- 2 skipped（按 desktop/mobile project 条件预期跳过）

覆盖 route scene、custom archive glyph、route exposure veil、reduced-motion、mobile viewport atmosphere。

### 核心功能短生命周期 E2E

Desktop：3/3 passed

- Timeline + Viewer
- horizontal/vertical Viewer fit
- Upload sheet

Mobile：3/3 passed

- Timeline + Viewer
- bounded multi-select photo-library import flow
- Upload sheet

### 长套件说明

一次 46 项完整 Playwright 长套件中，前 3 个真实 D1 用例通过后，本地 Wrangler 4.120.1 的 ProxyController 报 `Network connection lost`，`wrangler dev --local` 退出，之后大量测试统一变为 `ECONNREFUSED 127.0.0.1:8787`。

这不是页面断言失败。将关键 E2E 拆成新的短生命周期 Wrangler 进程后均通过。Cloudflare Workers SDK 当前也存在 `wrangler dev --local` / D1 本地进程崩溃类公开问题；后续应把本地 E2E server lifecycle 单独加固，而不是通过修改生产业务逻辑规避。

## Cloudflare 部署

执行：

1. production build / check
2. `wrangler deploy --dry-run`
3. `wrangler deploy`
4. 线上入口与版本核对

部署结果：

- Worker：`private-archive`
- Custom domain：`photo.joye.cc.cd`
- Current Version ID：`fb8c6732-f96a-48b9-ac38-92074a7d49d4`
- 仅上传 6 个新增/变更静态资产，其余复用
- Worker startup time：6 ms
- 未应用 D1 migration
- 未部署 Telegram webhook Worker

线上未认证访问：

- `/` -> Cloudflare Access `302`
- `/api/health` -> Cloudflare Access `302`

说明 Access 防护仍在正常工作，未因本轮部署被绕过或移除。

## 多 Agent 执行记录

本轮尝试使用 DevSpace 的多个 Agent/provider 做独立视觉评审：

- Codex explorer/reviewer：因 Codex2 根目录不是 trusted Git directory，被 provider wrapper 的 repo check 拒绝。
- Claude：本机 provider 未登录。
- OpenCode：本机 executable 缺失。
- Cursor / Pi：任务可启动，但在主交付完成时仍未返回可用 final response。

因此没有把未返回或失败的 Agent 意见冒充成评审结论。实际设计决策由主控结合 Codex2 已安装 Three.js / GSAP / UI-UX skills、当前磁盘实现、艺术网页参考和测试结果完成。

## 后续可选优化

1. 单独修复 Playwright + Wrangler 长套件的本地 server lifecycle，让 workerd 崩溃后自动重建或按测试域分段启动。
2. Wrangler 从 4.120.1 升级到当前提示的 4.122.0 后重新验证本地长套件，升级应作为独立基础设施变更处理。
3. 若后续需要更强艺术表现，可增加轻量 image-to-shader transition，但应继续避免远程纹理、大型模型、昂贵 post-processing 和 scroll-jacking。
