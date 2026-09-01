# telegram-private-media-vault 项目执行规则

## 真实状态优先

- 本项目是 `D:\wendangcodex\Codex2\telegram-private-media-vault` 的现有个人图片 / 数字资产 SaaS。
- 每次继续任务先读取真实磁盘、Git 状态、测试结果和运行时状态；真实磁盘高于旧对话摘要。
- 当前工作区可能存在用户正在进行的大量未提交修改。除非任务明确要求，不得回滚、覆盖、清理或重置这些改动。

## DevSpace Subagent / Codex2 Agent 判定规则

- 本项目允许直接使用 DevSpace Subagent。需要独立调查、实现、复核或测试时，先用 `devspace agents targets --json` 获取真实可用目标，优先使用已注册的 `explorer`、`implementer`、`reviewer`、`tester` Profile。
- **禁止仅凭 `devspace agents daemon status` 判断 Agent 能力是否失效。** Agent daemon 采用按需启动与空闲退出；无任务时 daemon 未常驻、返回 `DAEMON_UNAVAILABLE`，或在约 30 秒空闲后退出，都不等于 Agent 启动失败。
- 判断 Agent 能力必须以一次真实创建为准：`devspace agents run <profile-or-provider> "<bounded brief>" --json`。只要返回 Agent `id` 且状态进入 `running` / `completed`，即证明创建链路有效。
- `devspace agents run` 应自行完成 daemon 冷启动、项目 workspace 绑定、Agent 记录创建和 Provider runtime 启动；**不要求用户预先导入、创建或维护 namespace / Agent 容器**。
- 如果真实 `agents run` 失败，必须继续用 `devspace agents show <id> --json`、daemon 日志和 Provider 错误定位具体边界，例如：target/profile 配置、Codex 可执行文件、认证、Provider runtime、模型、网络或执行策略。不得把单个 Provider/Profile 的故障笼统描述成“Codex2 Agent 能力失效”。
- 某个 Provider/Profile 失败而其他目标真实可用时，可以在任务语义允许的情况下切换备用目标；必须保留并汇报原始失败边界。
- 只读 Agent 测试不得修改本项目业务文件。Agent 测试中某条 shell/read 命令被策略拦截，只能说明该命令权限受限；如果 Agent 本身已创建并返回结果，不得因此误报为“Agent 启动失败”。

## 本项目的 Agent 健康验收

遇到“Agent 启动失效 / Agent 不可用 / daemon 不可用”提示时，按以下顺序验收：

1. `devspace agents targets --json`：确认至少一个目标真实可用。
2. `devspace agents run explorer "只读检查当前项目并返回 PROJECT_AGENT_OK；不要修改文件。" --json`：做真实创建测试。
3. `devspace agents show <id> --json`：确认最终为 `completed`，或读取结构化失败原因。
4. 只有第 2/3 步真实失败时，才把问题判定为 Agent 启动故障。

不要为了让状态看起来常驻而强行保持 daemon 永不退出；当前按需启动 + 空闲退出属于正常设计。

## DevSpace Agent 修复后的运行版本验收

- 如果刚修改过 DevSpace / Codex Agent 适配层，但项目仍出现“Agent 又失效”，必须先确认当前 `devspace` 启动器实际指向的 `dist` 是否包含最新源码；禁止只看到源码已修就判定线上调用链已修复。
- 当前本机 `devspace` 启动器使用 `C:\Users\gyy12\.devspace\worktrees\devspace-11a46aff\dist\cli.js`。如果 Agent 相关源码时间晚于对应 `dist`，先在该 DevSpace worktree 完成测试、`npm run build`，再停止旧 daemon，让下一次 `agents run` 冷启动加载新构建。
- Agent 修复的最终验收至少包含：旧 daemon 正常停止、一次冷启动创建成功，以及 `explorer` / `reviewer` / `tester` 三个只读任务可以同时进入 `running` 并最终全部 `completed`。
- 只有完成上述真实运行版本验收后，才可以说“多 Agent 调用已修复”。

## 本地开发进程生命周期

- 本项目的 `wrangler dev` / `workerd` / `esbuild` 属于开发或测试运行时，不得因为一次测试、预览、对话中断或 Agent 退出而永久留在后台。
- `PrivateArchive-Local.exe --preview` 必须使用 launcher 的 preview lease + supervisor 生命周期：预览窗口关闭后只回收该预览实例自己的 Wrangler 进程树；下次启动先清理没有活跃 lease 的历史预览残留。
- 禁止再用 `dist/index.html` 与端口返回 HTML 是否完全一致来判断“当前 Worker 是否有效”；构建产物变化不能成为继续创建 8810、8811、8812、8813 等新端口实例的理由。
- 需要 E2E 时优先使用 Playwright `webServer` / `npm run test:e2e` 的受控生命周期。`npm run test:e2e` 现在带项目级运行锁：同一项目同一时间只允许一套完整 E2E；若返回 `E2E_ALREADY_RUNNING` 或 `E2E_UNTRACKED_RUNTIME_ACTIVE`，必须先检查当前 owner/运行状态，禁止通过另开 `npx playwright test`、换端口或并行对话绕过闸门。临时直接启动 `wrangler dev` / `test:e2e:raw` 仅限明确需要的单项交互式调试，并且确认没有完整 E2E 正在运行；任务结束前必须终止对应进程树。
- `tests/e2e/run-split.mjs` 使用异步 child lifecycle + Windows `taskkill /T` 精确回收自己的 Playwright/Wrangler 进程树；正常结束、测试失败、SIGINT/SIGTERM/SIGHUP 都必须释放运行锁并清理当前 E2E runtime。锁 owner 已死亡时，下次受控 E2E 可以清理该死 owner 的遗留 runtime；没有锁但检测到 8799 仍有旧 runtime 时 fail closed，不得误杀可能仍在运行的其他对话任务。
- 不得通过全局 `taskkill node.exe`、`taskkill workerd.exe` 或类似方式清理，因为本机同时运行其他 SaaS、DevSpace、脚本和后台服务。清理必须按当前项目路径、端口和命令行归属精确匹配。
- CPU 不做人工限速；资源治理目标是“需要运行的任务可以吃满 CPU，但已经结束的任务不得继续占用 CPU/内存”。
