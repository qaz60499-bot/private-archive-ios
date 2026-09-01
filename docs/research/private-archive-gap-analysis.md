# Private Archive 真实状态与差距审计

> P0 复核状态（2026-08-12）：本文第 7 节列出的本地 job schema v2、单一 Upload Scheduler、Batch Manager、指数退避/429/timeout/Abort、中文错误和专项测试已完成。实现与最终验证见 `docs/upgrade/p0-completion-report.md`；P1/P2 与本文明确暂不实现项仍保持未授权状态。

> 审计日期：2026-08-12  
> 事实来源：`D:\wendangcodex\Codex2\telegram-private-media-vault` 当前磁盘、Cloudflare 远程只读查询、生产 Worker/Queue 元数据。  
> 基线：`npm run check` 通过（6 个测试文件、33 项单测；lint、typecheck、build 均通过）。

## 1. 当前生产状态

- 正式入口：`https://photo.joye.cc.cd`
- 主 Worker：`private-archive`
- 当前主 Worker 版本：`98094f03-9cd2-4ee0-9183-8ff349d79a7f`
- Webhook Worker：`private-archive-telegram-webhook`
- D1：`private-archive-db`（`8ca60403-dd2b-48fa-8e07-9b0274a258fc`）
- Queue：`private-archive-analysis`
- DLQ：`private-archive-analysis-dlq`
- D1 migration：`0001`–`0009` 全部已应用，远程无待应用 migration。
- D1 只读统计：41 个 ready、10 个 trashed；历史 `storage_file_unique_id` 重复组为 0。
- 本轮绝不操作 `global-signal-news`。

## 2. 应保护的成熟能力

### 上传与存储

- Web 上传先生成稳定本地 job id，再在 D1 预留 asset 和 upload token。
- 原件进入 Telegram 前，以 SHA-256 `content_hash` 查询并由 D1 部分唯一索引阻止活动资产重复。
- Telegram 回流以 `file_unique_id` 与 `(chat_id, message_id)` 幂等。
- 内容 PUT 在已有 `storage_file_id` 时直接返回 `alreadyStored`，避免恢复时二次写入 Telegram。
- Worker 使用 `ReadableStream` 组装 streaming multipart，没有把 48 MB 原件整体读入 Worker 内存。
- 完成后释放 OPFS/IndexedDB 中的原件、预览 blob。
- `≤20 MB` 可由 Web 获取原件，`20–48 MB` 只由 Web 展示 preview，`>48 MB` 拒绝。

### 元数据、分类和图库

- EXIF 拍摄时间和 GPS 已进入 D1；失败时回退到文件时间/上传时间。
- AI 链路是 Vision 描述 → Structured facts → deterministic classifier；这个分层值得保留。
- `category_override` 始终高于 AI 分类，手动分类不会被 AI 覆盖。
- Timeline 使用 `(taken_at, id)` keyset cursor，每页 48 项，不是 offset pagination。
- Preview 有浏览器懒加载和 Edge Cache。
- Viewer 已有横竖图 fit、键盘导航、焦点约束、原图渐进加载和 Telegram-only 提示。
- Albums、Discover、自定义模块、收藏、搜索和软删除均已工作；软删除不会删除 Telegram 原件。

## 3. P0 已确认差距

### 3.1 导入不是低内存流水线

当前 `importFiles` 对每个文件执行：

1. `Promise.all(prepareMedia(file), sha256File(file))`
2. 写 OPFS / IndexedDB
3. 在线时等待该单项完整上传
4. 下一项

主要问题：

- `sha256File` 使用 `file.arrayBuffer()`，单个大文件会产生整文件内存副本。
- Hash 与 EXIF/解码/Canvas preview 同时进行，形成单文件峰值叠加。
- 调用期间 `FileList`/数组仍持有整批 File 对象；选择 100–200 张时不能尽快释放页面引用。
- “建任务”和“准备媒体”没有分层，无法先在 UI 中立即出现 100 个轻量任务，再用 1–2 个 prepare slot 消化。
- 没有 prepare 状态，无法准确区分“等待处理、正在提取、正在上传”。

目标架构应改为：轻量登记 → 原件尽快持久化 → 限量 prepare → reserve/去重 → 限量 upload → 释放 payload。

### 3.2 没有真正的 Batch Upload Manager

当前 UI 逐项轮询 IndexedDB，只显示单项进度。缺少：

- 批次 ID 与选中总数。
- completed / active / queued / duplicate / failed / cancelled 汇总。
- 总体进度与剩余数量。
- 暂停全部、继续全部、重试失败、清除完成、取消单项。
- 本轮重试次数、批次状态和动态并发状态。
- 跨刷新恢复同一批次的语义。

### 3.3 上传进度不是真实字节进度

现有 8/22/40/100 是阶段百分比，不是网络字节进度；Fetch upload 在主流浏览器中也没有通用上传进度事件。本轮可准确显示阶段进度、完成数量和总体完成率；“总上传速度”只有改用 XHR 或额外分片协议才可靠，不应为 UI 指标破坏当前 streaming/idempotency 设计。

### 3.4 恢复器固定串行且存在重复扫描

- `resumePendingUploads()` 固定逐项串行。
- `importFiles()` 每项在线上传完成后，最后又调用一次 `resumePendingUploads()`。
- `main.tsx`、Queue 页面、online/visibility 监听都可能触发恢复；虽然 `active Set` 能阻止同 job 并发，但没有统一 scheduler。
- 缺少照片 2/桌面 3/视频 1 的有限并发控制，也没有 429 后降并发。

### 3.5 429、超时和取消不完整

- 浏览器端仅用固定 700/1800 ms 重试，没有指数退避、抖动或 `Retry-After`。
- API 层没有 request timeout，也没有 AbortController。
- Telegram client 没有 timeout、429 `parameters.retry_after` 解析或分级重试。
- 用户无法暂停/取消正在排队的项目。
- Worker 将 Telegram 错误统一映射为 `STORAGE_UPLOAD_FAILED`，浏览器无法区分限流、上游 5xx、超时。

### 3.6 OPFS/IndexedDB 容量错误不可解释

- OPFS 写失败会静默回退 IndexedDB Blob，但未做 `navigator.storage.estimate()` 预检。
- 两者都失败时只会落到笼统错误。
- 缺少“本地空间不足”“本地临时文件不可用”“Safari 后台限制”的明确中文状态。

## 4. P1 已确认差距

### Viewer 手势

- 只有键盘和按钮，无左右滑、双击缩放、pinch zoom、下滑关闭。
- 必须在缩放比例为 1 时才允许左右滑/下滑，缩放时手势只用于平移，避免冲突。
- 不改变当前工具栏、右侧信息栏、字体、箭头、列宽和手机布局。

### Timeline 规模

- 服务端 keyset pagination 是正确基础。
- 浏览器加载更多后会一直保留并渲染所有 DOM；1,000+ 项时 DOM、图片元素和 GSAP observer 会累积。
- 当前不需要立刻引入巨型瀑布流依赖。优先增加自动分页 sentinel、`content-visibility`/IntersectionObserver、缩略图尺寸策略；达到真实 5k–10k 数据再评估虚拟瀑布流。

### 重复与相似

- 精确重复已经可靠自动跳过。
- 当前没有重复报告页、历史 D1 报告、视觉相似 hash 或 duplicate groups。
- 感知 hash 只能标记“疑似相似”，禁止自动删除。
- 生产 D1 当前只有 1 个活动资产具有 SHA-256，旧 Telegram 资产无法在不重新下载原件的情况下确认 SHA-256；历史扫描应先报告 `file_unique_id` 与已有 hash，不能假装完整。

### UI 美化接管

- 已部署 GSAP 页面/section 入场与一版轻量 Three.js 档案框背景。
- `ArchiveGlyph.tsx` 已新增但未接入导航。
- Three.js 已动态 import 且移动端、低动态、省流量时降级；但产物约 516.6 kB，不能把它加入 PWA precache 或移动端首屏。
- 待完成：自绘导航图标、全屏但低对比的“暗房光化学场”、按路由轻微变调、WebGL 失败静态 fallback。媒体仍必须是主体。

## 5. P2 评估

### 搜索

当前 LIKE 已覆盖文件名、分类和 tags，并使用安全转义；生产规模仅几十项。现阶段不应为此先引入 FTS5。先把 `scene`、地点 label、拍摄年份/月等字段纳入查询；当资产达到数千且 LIKE 变慢，再以 migration 加 FTS 和同步触发器。

### AI

现有架构稳定、可解释、成本可控。现有 allowlist 已包括 night、animal、document、architecture、food、screenshot 等，但结构化 facts 尚未完整覆盖宠物、OCR、夜景、文档。应先以最少字段增强，不增加新的模型调用；OCR 只在明确需要时评估。

### 历史 Telegram 重复扫描

Bot API 没有任意遍历完整频道历史的通用接口。当前 Worker 只保存收到的 update，因此“全量 Telegram 历史扫描”若不引入 MTProto 客户端无法保证完整。本轮最多提供 D1 报告和从现在起的重复组，不引入 VPS/MTProto 常驻服务。

## 6. Worker 与生产架构结论

- 保留主 Worker + webhook proxy 两 Worker 架构。Webhook proxy 通过 service binding 转发并绕开 Access，是清晰且低风险的隔离层。
- 原件 streaming multipart 方向正确。Cloudflare 官方最佳实践同样要求大请求/响应流式传递，避免 `arrayBuffer()`/`text()` 缓冲大 body。
- Queue 对 AI 异步分类合适；当前逐消息 ack/retry 能避免单个失败拖累整批。后续可按 `message.attempts` 做指数退避，但不把上传原件搬进 Queue。
- 不引入 R2 原件、VPS、S3、通用网盘、多用户或公开分享。

## 7. 本轮实现边界

优先直接实现：

1. 本地 job schema v2 与 prepare/upload 状态。
2. 单一 Upload Scheduler：prepare 1（必要时桌面 2）、图片上传手机 2/桌面 3、视频 1。
3. Batch Manager 汇总和批量控制。
4. 指数退避、429 降并发、timeout/AbortController、中文错误分类。
5. 20/100 模拟文件、重复、断网/恢复、单项失败、payload 释放、createImageBitmap 缺失、Access 失效、429、重试幂等专项测试。
6. 低风险 Viewer 手势、Timeline 自动分页/渲染优化、D1 精确重复报告页。
7. 完成已卡住的自绘图标和可降级背景动效。

暂不实现：

- 自动删除任何 Telegram 原件。
- 浏览器端视频全文件感知指纹。
- 依赖 MTProto 的完整 Telegram 历史遍历。
- 为当前几十项数据引入 FTS5 或巨型虚拟瀑布流依赖。
- 以分片协议重写 Telegram 上传；Bot API 上传仍是单次 streaming multipart。
