# Private Archive vNext 升级计划

版本：P0 实施版（2026-08-12）

## 目标

让 20–100 项本地导入在桌面与手机弱网环境中可暂停、可恢复、可解释，并保持 Telegram 原件流式上传和 D1 精确去重不退化。

## 不变量

- 不改动态背景、导航、自绘图标或 Viewer 外观。
- 不部署，不执行远程 D1 migration，不触碰 `global-signal-news`。
- Telegram 继续保存原件；D1 只保存索引和状态。
- Worker 原件路径保持 `ReadableStream`，禁止 `arrayBuffer()` 原件。
- `content_hash` 部分唯一索引与 `storage_file_id` 幂等返回必须保留。
- 进度以阶段与完成数为事实，不承诺 Fetch 上传字节速度。

## P0 数据模型

IndexedDB 数据库升级到 v2，只新增索引；旧 v1 记录在读取时惰性正规化，无破坏性迁移。

`LocalUploadJob` 新增：

- `schemaVersion`、`batchId`
- `prepareStatus`: pending / preparing / ready / failed
- `controlState`: active / paused / canceled
- `stage`: registered / preparing / reserving / preview / original / completed
- `nextAttemptAt`、`lastAttemptAt`、`retryAfterMs`
- `previewUploaded`、`contentHash`

原件登记顺序：校验大小 → 写 OPFS（不可用时 IndexedDB Blob）→ 写轻量 job。prepare 与 SHA-256 由 scheduler 后续执行。完成和取消立即删除 OPFS/Blob/preview；暂停、离线和可重试失败保留。

## 调度模型

全应用只有一个前台 Upload Scheduler。main、Queue、导入完成、online、visibility 和 Background Sync 只调用同一个唤醒入口，不直接扫描并执行 job。

并发目标：

| 阶段 | 手机 | 桌面 |
| --- | ---: | ---: |
| prepare | 1 | 2 |
| photo/file upload | 2 | 3 |
| video upload | 1 | 1 |
| 429/弱网保护期 | 1 | 1 |

调度策略：

1. 先选择到期、active 且未完成的任务。
2. prepare 与 upload 使用独立槽位；单项失败不阻塞批次。
3. 状态更新触发订阅事件，UI 不依赖重复页面级 resume 逻辑。
4. 429 优先采用 `Retry-After`，并在保护期内把上传并发降为 1。
5. 网络/502/503/504/timeout 使用指数退避和 full jitter；Access 失效、无本地 payload 等不可自动修复错误停在 failed。
6. pause/cancel 通过 AbortController 中断本次浏览器请求；pause 保留 payload，cancel 释放 payload。

## Batch Manager

`batchId` 由每次文件选择生成。Batch Manager 提供：

- 总数、准备中、等待、上传中、已完成、失败、暂停、取消、精确重复数量。
- 真实完成进度：完成/取消项数 + 当前阶段，不展示伪字节速率。
- 批量暂停、继续、取消、重试失败。
- 逐项中文错误与逐项重试/暂停/继续/移除。

Batch UI 只扩展现有 Upload Sheet 与 Queue 页面，不修改背景、导航或 Viewer。

## API 与 Worker 错误合同

- Web API 包装器为 reserve/preview/content 增加 timeout 与外部 AbortSignal。
- `ApiError` 携带 `status`、业务 `code`、`retryAfterMs`。
- Worker Telegram client 解析 Bot API `parameters.retry_after`，抛出分类错误。
- 资产上传路由把 Telegram 429 映射为 HTTP 429 + `Retry-After`，其他上游错误保持 502；已存在 `storage_file_id` 直接返回 `alreadyStored`。

## 测试矩阵

### 单元/集成

- v1 job 正规化与 v2 字段。
- 20/100 job 并发上限和单项失败隔离。
- 指数退避边界、jitter、Retry-After 优先级和 429 降并发。
- 离线暂停与 online 唤醒。
- payload 成功/取消释放，失败保留。
- `createImageBitmap` 缺失时仍登记并上传原件。
- Access 失效中文分类。
- 已存 content PUT 不再调用 Telegram；精确 hash reserve 返回 duplicate。

### E2E

- desktop 与 mobile：打开上传 Sheet、批量登记、批次操作与恢复状态。
- 原有 web + Telegram ingestion 收敛、重复 reserve 与 PUT 幂等继续通过。
- 离线队列恢复；页面无横向溢出、控件可键盘操作。

## 完成定义

1. `npm run check` 全部通过。
2. Playwright desktop/mobile 全部通过。
3. 无生产部署、远程迁移或受限 UI 文件改动。
4. 交付清单列明源码、文档、测试和任何真实环境限制。
