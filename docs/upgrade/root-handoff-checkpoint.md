# Private Archive 主控接续检查点

更新时间：2026-08-12  
主控身份：Codex2  
正式项目：`D:\wendangcodex\Codex2\telegram-private-media-vault`

## 用户目标

完成“升级 Private Archive 私人图库”原任务，并接续其中运行的 agent。保持小计划推进，实际完成研究、P0/P1 低风险升级、UI 美化、测试、安全部署与线上验证，不只输出方案。

## 已确认边界

- 个人私人照片/视频/文件图库，保持 Cloudflare Worker + React PWA + D1 + Telegram 原件存储。
- 不改造成公开图床、通用网盘、多用户 SaaS；不加 R2/S3/VPS 作为原件主存储。
- 不自动删除 Telegram 原件；视觉相似只能提示，不能自动删除。
- 生产目标仅限：`private-archive`、`private-archive-telegram-webhook`、`private-archive-db`（UUID `8ca60403-dd2b-48fa-8e07-9b0274a258fc`）、`private-archive-analysis` 与对应 DLQ。
- 绝对禁止触碰 `global-signal-news`。
- 重大修改顺序：本地实现 → 全量测试 → dry-run/迁移核对 → 部署 → 线上验证。
- Telegram Token 只允许 Cloudflare Secret / 本机 `.dev.vars`，不得写入源码、前端、D1、文档或日志。

## 已完成

1. 已读取根级 AGENTS、Codex2 记忆索引与 `Telegram私有媒体云图库项目.md`；Hermes 已确认隔离 Profile `codex2`，Obsidian 区为 `D:\wendangcodex\ObsidianMemoryVault\Codex2_Web`。
2. 已读取并遵循：Hermes Memory Bridge、website-building-workflow、Cloudflare、Workers best practices、Wrangler、GSAP、Three.js Web Experience 及必要参考。
3. 已定位原任务和 UI 任务，并分别恢复：
   - 核心升级 task：`019ff612-fc1f-79c1-8fcb-06a0742ac5de`
   - UI 美化 task：`019ff5d3-bec2-7dd0-95c7-499ea9dafb16`
4. 核心升级 task 第一次上下文切换后遗忘指令，已从 `docs/upgrade/p0-handoff-checkpoint.md` 再次唤醒；当前 active。
5. UI task 当前 active，边界仅为动态暗房背景、自绘导航图标、GSAP/Three.js、响应式/reduced-motion，不碰上传、Worker/D1/API/部署。
6. 真实磁盘基线 `npm run check` 已通过：配置校验、Lint、TypeScript、6 个测试文件/33 项单测、Vite/PWA 构建全部通过。
7. 当前依赖：Wrangler `4.120.1`，Workers Types `5.20260811.1`；生产构建中 Three.js 为独立动态 chunk，且 PWA precache 已排除该 chunk。
8. 已浏览/核对 GitHub 一手来源和 Cloudflare 官方最新 best-practices/streams 文档；本地已有研究仓库：
   - `work/external/CloudFlare-ImgBed`
   - `work/external/Telegraph-Image`
9. 已确认现有正确基础：SHA-256 精确去重、Telegram `file_unique_id` 去重、PUT 幂等、OPFS/IndexedDB、streaming multipart、Queue + Workers AI、keyset pagination、软删除不删 Telegram。

## 已确认主要缺口

- `importFiles` 仍是单项 prepare/hash/入队/在线上传后再处理下一项；没有轻量登记 → 限量 prepare → 限量 upload 的统一流水线。
- `resumePendingUploads` 固定串行且存在多入口；缺统一 scheduler、移动端 2/桌面 3/视频 1、弱网/429 降到 1。
- 缺 Batch Manager 汇总、暂停/继续、重试失败、清除完成、取消单项。
- 浏览器 API 缺 AbortController timeout、指数退避+jitter、Retry-After 解析和可解释中文错误。
- `sha256File` 使用整文件 `arrayBuffer()`；可接受的本轮安全策略是把 prepare 并发限制为 1（桌面最多 2），避免 100–200 个文件并发进入内存，不为增量 hash 引入巨型依赖。
- P1 仍可做 Viewer 手势和 Timeline 自动分页/content-visibility，但必须保持现有 Viewer 布局不变。

## 正在进行

- 核心升级 agent：研究文档、gap/vNext 计划、上传 job schema/scheduler/Batch Manager/429/网络恢复/专项测试。
- UI agent：ArchiveGlyph 接入、动态暗房背景、GSAP 微动画、Three.js 生命周期和降级、视觉验收。
- 主控：等待两个 task 交付后做文件级交叉审查、整合、补遗漏与最终验证。

## 后续顺序

1. 用 `wait_threads` 继续跟踪两个 active task；不要重复创建 agent。
2. 接收 UI task 后检查 `AppShell.tsx`、`ArchiveAtmosphere.tsx`、`ArchiveGlyph.tsx`、`MotionDirector.tsx`、`main.css`、`.design/DESIGN.md`，确认移动端不加载 WebGL、reduced-motion、清理和失败 fallback。
3. 接收升级 task 后检查 `types.ts`、offline store/processor、新 scheduler、import-files、UploadSheet/QueuePage、api、专项测试和三份文档。
4. 运行 `npm run check`。
5. 运行 `npm run test:e2e -- --project=desktop` 与 `--project=mobile`；必要时补 375/768/1280/1440、短屏、reduced-motion 浏览器验收和截图。
6. 审计 Worker：streaming、timeout/429、浮动 Promise、绑定/secret、webhook service binding；运行 Wrangler schema/type核对与 `wrangler deploy --dry-run`。
7. 仅当全部本地验证通过后，核对远程 D1 migrations；若无新 migration 不应用。随后部署 `private-archive`，如 webhook proxy 未改则不部署它。
8. 部署后记录版本 ID，验证 `https://photo.joye.cc.cd` 的 Access 拦截、登录后 Timeline/Viewer/Discover/Album/Search/Upload/Batch/Dedup，以及 webhook 状态。
9. 完成 Codex2 Obsidian 任务归档；只保存无密钥摘要。

