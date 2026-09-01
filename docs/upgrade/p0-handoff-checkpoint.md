# P0 升级接续检查点

更新时间：2026-08-12  
工作区：`D:\wendangcodex\Codex2\telegram-private-media-vault`

## 当前授权范围

- 完成 `docs/research/github-project-review.md`
- 完成/复核 `docs/research/private-archive-gap-analysis.md`
- 完成 `docs/upgrade/private-archive-vNext-plan.md`
- 实现 P0 上传流水线、Batch Manager、有限并发、429/网络恢复、精确去重相关低冲突代码和专项测试
- 禁止改 UI 动态背景、自绘导航图标、Viewer 外观
- 禁止生产部署、禁止远程 D1 migration、禁止触碰 `global-signal-news`

## 已完成且不要重做

1. 已读取 `D:\wendangcodex\AGENTS.md`、`D:\wendangcodex\Codex2\home\AGENTS.md`、项目配置、migrations、Worker/Web/Tests、上传队列、Telegram Adapter、AI、Viewer、Timeline、Albums、Discover。
2. 原始基线 `npm run check` 通过：lint/typecheck/build 通过，6 个测试文件 / 33 项单测通过。
3. 生产只读确认：
   - D1 `private-archive-db` UUID `8ca60403-dd2b-48fa-8e07-9b0274a258fc`
   - `0001`–`0009` 已应用，无待应用 migration
   - Queue/DLQ 与配置一致
   - 主 Worker 当时版本 `98094f03-9cd2-4ee0-9183-8ff349d79a7f`
   - 41 ready、10 trashed；历史 `file_unique_id` 重复组为 0
4. 已写 `docs/research/private-archive-gap-analysis.md`。
5. 两个指定外部仓库已经克隆到：
   - `work/external/CloudFlare-ImgBed`
   - `work/external/Telegraph-Image`
   两个研究 Agent 被上下文切换中断，尚未生成最终研究 Markdown；应直接基于这些本地仓库继续源码审读。

## 已确认关键设计

- 当前 `importFiles` 是串行，但单文件内同时执行 `prepareMedia` 与整文件 `arrayBuffer()` SHA-256；没有轻量登记 → 限量 prepare → 限量 upload 流水线。
- 当前 `resumePendingUploads` 固定串行，多处触发，没有统一 scheduler。
- 精确去重与 PUT 幂等正确：`content_hash` 部分唯一索引、已有 `storage_file_id` 返回 `alreadyStored`，必须保护。
- Worker streaming multipart 正确，禁止把原件读入 Worker 内存。
- 目标并发：移动端照片 2、桌面照片 3、视频 1；弱网/429 降到 1。
- 浏览器 Fetch 无可靠 upload byte progress；Batch 总进度应以阶段和完成数为事实，不为速度指标重写成不安全分片协议。
- OPFS 必须优先；任务先快速持久化原件，prepare 每次 1（桌面最多 2），完成后立即释放 payload。

## 下一步顺序

1. 完成 GitHub 研究文档和 vNext 计划。
2. 设计并修改 `LocalUploadJob` schema（batchId、prepare 状态、cancel/pause、nextAttemptAt 等），兼容 IndexedDB v1 数据。
3. 将 import 拆成轻量登记和 scheduler；统一所有 resume 入口。
4. 加有限并发、指数退避+jitter、429 Retry-After/动态降并发、AbortController/timeout、中文错误。
5. Batch Manager 聚合统计与批量操作，不触碰背景/导航/Viewer。
6. 加 20/100 模拟、重复、断网恢复、单项失败、payload 释放、createImageBitmap 缺失、Access 失效、429、重试不重复 Telegram 的测试。
7. 跑 `npm run check`、desktop/mobile e2e；不部署。

