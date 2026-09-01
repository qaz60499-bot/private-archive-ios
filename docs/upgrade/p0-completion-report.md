# P0 上传可靠性升级完成报告

完成日期：2026-08-12  
工作区：`D:\wendangcodex\Codex2\telegram-private-media-vault`

## 完成范围

- 完成两个指定 GitHub 项目的本地源码审读与 vNext 实施计划。
- IndexedDB 升级至 v2，仅新增 batch/重试索引；v1 job 读取时惰性正规化。
- import 改为先持久化原件、后由唯一 scheduler 限量 prepare/upload。
- OPFS 优先，IndexedDB Blob 回退；完成/取消释放 payload，失败/暂停保留。
- 桌面 prepare 2 / upload 3，移动 prepare 1 / upload 2，视频 upload 1；429 保护期统一降至 1。
- 指数退避 + full jitter、`Retry-After`、动态降并发、AbortController、浏览器/Telegram timeout 与中文错误完成。
- Batch Manager 提供聚合完成/重复/失败/暂停/取消统计，以及批量暂停、继续、取消和失败重试。
- Worker 继续流式转发原件；精确 `content_hash` 去重和 `storage_file_id` 的 `alreadyStored` 幂等路径保持不变。

## 专项验证

- 20 项真实浏览器调度：桌面并发大于 1 且不超过 3，全部完成并释放 payload。
- 100 项真实浏览器调度：全部精确重复结束，批次没有溢出。
- 移动端离线登记 → 恢复网络 → 自动完成，期间 payload 保留、完成后释放。
- `createImageBitmap` 缺失：移动相册双文件登记和精确重复流程通过。
- 单项 Access 失效：同批另一项仍完成，失败项显示中文恢复信息。
- 429：按 1 秒 `Retry-After` 重试同一远端 asset/token，第二次完成。
- 批量暂停：中止当前请求并保留 payload；继续后 8 项全部完成。
- 原件 PUT 幂等：第二次 PUT 返回 `alreadyStored: true`；相同 hash reserve 返回同一 asset 的 duplicate。

## 最终测试

- `npm run check`：配置校验、lint、typecheck、10 个测试文件 / 40 项单测、生产构建全部通过。
- `npm run test:e2e`：desktop/mobile 共收集 40 条，23 通过、17 条按项目矩阵跳过、0 失败。
- Playwright 固定单 worker，因为测试共享一个本地 Wrangler/workerd 与 D1 实例；多 browser worker 并发 seed/mutation 会使本地 workerd 退出，不代表产品并发模型。

## 边界确认

- 未部署。
- 未执行远程 D1 migration，未新增 migration。
- 未触碰 `global-signal-news`。
- 未修改 Viewer 实现或外观；未以 P0 名义修改动态背景或导航实现。
- 没有引入浏览器分片上传，也没有把 Worker 原件读入内存。

## 已知非阻塞项

- Vite 仍报告已有 Three.js chunk 超过 500 kB 的警告；该 chunk 不在 P0 授权范围，构建成功且 PWA precache 未包含它。
- Fetch 无可靠上传字节进度；Batch 继续以阶段和完成项数表达真实进度。
- Telegram 成功但 Worker 在写 D1 前异常退出的跨系统极小窗口无法提供 exactly-once 保证；正常重试由 `storage_file_id` 幂等短路保护。
