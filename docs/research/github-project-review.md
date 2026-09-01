# GitHub 项目源码审读：CloudFlare-ImgBed 与 Telegraph-Image

审读日期：2026-08-12  
审读对象：

- `MarSeventh/CloudFlare-ImgBed`，本地提交 `c0b00948c6145d6e32baa3b7d507daaba50c0987`
- `cf-pages/Telegraph-Image`，以 `work/external/Telegraph-Image` 当前检出提交为准

本审读只回答一个问题：哪些实现经验适合用于 Private Archive 的 P0 上传可靠性升级。它不是功能对齐清单，也不授权引入 R2、多用户、公开图床、分片协议或生产部署。

## 1. 结论摘要

两个项目都证明了 Telegram + Cloudflare 可以承担轻量个人媒体存储，但它们的目标是公开/半公开图床和通用文件管理，Private Archive 的目标则是单用户、精确去重、可恢复的私人归档。因此应吸收任务状态、失败隔离、临时数据清理、批量管理和限流约束，不应复制其存储抽象、公开链接模型或分片上传协议。

P0 采用以下结论：

1. 保留现有 `reserve → preview → streaming PUT → Telegram → D1` 链路。
2. 保留 `content_hash` 精确去重和服务端 `storage_file_id` 幂等判断。
3. 浏览器先把原件持久化，再由唯一 scheduler 限量 prepare 和 upload。
4. 429 必须读取 `Retry-After`，调度器临时把并发降为 1；网络/5xx 使用指数退避和抖动。
5. 原件上传不改为浏览器分片；Fetch 没有可靠上传字节进度时，以阶段和完成项数表达真实进度。
6. 完成、取消后立即释放 OPFS/IndexedDB payload；失败和暂停保留 payload 供恢复。

## 2. CloudFlare-ImgBed

### 可借鉴

- 上传、存储适配、元数据、索引和管理 API 分层清楚，批量操作不会把单项状态隐藏掉。
- 分块流程具有显式 `uploadId`、初始化、分片、合并和清理阶段，说明可恢复任务必须有持久状态与清理语义。
- Telegram/R2/S3/WebDAV 等后端失败被隔离在适配层；前端任务不应直接理解每个后端的协议细节。
- 图片尺寸只读取有限头部，原件上传路径避免无意义的重复解码。
- README 明确写出 Telegram 每频道速率限制，承认吞吐边界而不是用无限并发掩盖它。

### 不应移植

- 其分片协议服务于多存储后端和更大文件，包含初始化、临时片、合并、清理以及读取时重组。Private Archive 的 Telegram Bot API 原件上限固定为 48 MB，复制该协议会放大请求数、失败面和重复 Telegram 消息风险。
- `request.formData()` 会让 Worker 解析完整 multipart。当前项目已经以自建 streaming multipart 将请求体流向 Telegram，应继续保留。
- 自动切换存储渠道与公开 URL 不符合“Telegram 原件唯一事实来源”的产品约束。
- 图床的目录、公开管理和多用户能力会扩大隐私与权限面，不属于 P0。

## 3. Telegraph-Image

### 可借鉴

- `storage/index.js` 用小型 provider contract 隔离 Telegram 与 R2；当前项目已有 `StorageAdapter`，方向一致。
- 元数据正规化为旧记录补默认值，可直接类比 IndexedDB v1 → v2 的惰性兼容。
- 管理列表采用 cursor/limit，批量管理以稳定 ID 操作；Batch Manager 同样应聚合本地 job，而不是复制二进制。
- 文档坦率说明 Telegram 下载 20 MB、上传/频道频率限制以及 Cloudflare 配额，这种“能力边界即产品文案”的做法适合私人档案。

### 不应移植

- 上传入口先 `request.clone().formData()`，随后把 `File` 交给 provider；这不如现有 Worker streaming 原件路径稳健。
- Telegram 上传失败统一变成 500，缺少 429 `parameters.retry_after`、超时和分类错误；P0 必须补上。
- KV 管理元数据以最终一致的公开图床语义为主，不具备本项目 D1 `content_hash` 部分唯一索引带来的精确去重保证。
- 文档提示用户手工控制速率，但没有浏览器持久 scheduler；不能直接满足 20/100 项断网恢复要求。

## 4. 对当前代码的具体映射

| 外部经验 | 当前基础 | P0 决策 |
| --- | --- | --- |
| 显式上传生命周期 | `LocalUploadJob.status` 较粗 | 增加 batch、prepare、控制状态、重试时间与阶段 |
| 临时数据清理 | 已有 OPFS + fallback Blob | 成功/取消立即释放，失败/暂停保留 |
| provider 隔离 | 已有 `StorageAdapter` | 保留，不新增存储后端 |
| 批量管理 | 当前只逐项重试/删除 | 增加 batch 聚合、全部暂停/继续/取消/重试 |
| 速率限制 | 固定 700/1800 ms 重试 | 指数退避+jitter、Retry-After、动态降并发 |
| 大文件分片 | 外部项目复杂分片协议 | 明确拒绝移植，继续单次 streaming PUT |
| 旧数据正规化 | v1 job 无新字段 | IndexedDB v2 索引升级 + 读取时补默认值 |

## 5. 风险与保护条件

- Telegram 成功但 Worker 在写入 D1 前崩溃，是跨系统事务无法完全消除的极小窗口；P0 不宣称 exactly-once。正常重试首先检查 D1 的 `storage_file_id`，已保存时不再次调用 Telegram。
- 浏览器不能可靠获取 Fetch upload byte progress；不得用虚构百分比或不安全分片换取视觉速度条。
- prepare 仍可能需要解码图片/视频和 SHA-256 整文件读取，因此必须受限并发，并在任务完成后释放引用。
- OPFS 不可用时允许回退 IndexedDB Blob，但空间不足必须给出中文错误，不可静默丢任务。

## 6. 验收依据

P0 完成以代码和自动化测试为准：20/100 项调度、精确重复、断网恢复、单项失败隔离、payload 释放、`createImageBitmap` 缺失、Access 失效、429、以及服务端已存原件重试不再次触发 Telegram。本文不替代测试，也不包含部署结论。
