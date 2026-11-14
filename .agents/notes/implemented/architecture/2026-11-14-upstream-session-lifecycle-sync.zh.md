# Agent Note：上游 session 生命周期同步（rc.2..v0.2.2-rc.3）

状态：已实现

[English](2026-11-14-upstream-session-lifecycle-sync.md) | 中文

## 问题

上游 `rc.2..v0.2.2-rc.3` 在 store 所有权下重排了 session 写入并修复 released-checkpoint 处理；本地 session 主干需要这些修复，而批量 `append` API 与 projection-frame 重构规模过大，无法同批引入。

## 决定

store 持有的写入重排与 released-checkpoint 修复已移植；批量 `append` API 与 projection-frame 重构推迟到功能吸纳批。

- **Session 先于 setup 发布（`49a7a75d75`）**——`PreparedAgent.publish` 改为 `initializeAndPublish(source, setup?)`：Session 先 enter 并 announce，随后在 abort 控制下运行 setup 并 commit，最后 Agent enter 并 announce。因此 setup 可以向已发布的 Session 追加事件；失败或被中止的 setup 会 dispose 已公告的 Session，不再泄漏。dispose 以 `keepInbox: !ready` 取消。
- **Append 守卫（同批次）**——Session 仅在其 store attachment 存活且公告为 `complete` 时可追加；detached 条目保留显式 `null` 墓碑，迟到的 append 抛出 `cannot append outside a SessionStore` 而不是解引用死条目。
- **权限 pin 迁移到 `agent/created`**——`permission-presets` 不再在 `session/created` 内 append（新守卫禁止）；改为在 `agent/created` 上以 `prepend: true` pin 初始权限事实，remount 时从 `ctx.agents.list()` 播种既有 agent，并在 `inject` 中声明 `agents`。
- **释放的 projection unit 保留在 checkpoint（`eb1713f856`）**——最后一次释放将 registration 标记为 `refs: 0` 而非删除。live drive、restore、`stateOf` 与客户端快照跳过 released unit；`checkpoint()` 只服务该 Session 已存在的最后 cell（不新建），key 重新注册时安装新 unit 并重折日志。因此 domain 插件卸载后才运行的 checkpoint 写入者保留该 unit 的最新状态，不再静默丢行。
- **`command/done` append 容错**——agent dispose 现在会 detach Session，因此已结算命令的 `command/done` 无法落盘时记录 warn 并仍返回结算结果，而不是抛出 append 失败。

## 后果

- 批量 `append` API（`b5969f9e8d`、`748c53b865`、`b3d570cdf8`、`143fabbc34`、`5e77db2d5c`、`7f6b7ba4b6`、`1e7f265cfd`、`e00af4f994`、`e767bef144`、`876c4a4f78`）——多事件位置元组、共享 live-append 校验与 surface 选项隔离；属功能面，随 tool-executor 批吸纳。
- `945006c984`（每个已提交事件一帧 projection frame）与 `fcca540841`（统一运行时 projection 读取）——面向 wire/消费者的重构，推迟到功能评估。
- spec fixture 采用上游模式（agent-loop testkit harness、`ctx.agents.create`、对异步 config 启动使用 `vi.waitFor`、fixture agent 走 `agents.register`）。

## 备选方案

- **在此一并引入批量 `append` API**——拒绝：它是与 tool-executor 批共享的功能面，捆进生命周期修复会把重排语义藏在无关的 API 扩张之后。

## 验证

对 session、agent、agent-loop、commands、permission-presets、session-projection、session-projection-cache、session-persistence、session-persistence-jsonl 执行 `pnpm exec vitest run`：105 个文件、2544 个测试全绿。
