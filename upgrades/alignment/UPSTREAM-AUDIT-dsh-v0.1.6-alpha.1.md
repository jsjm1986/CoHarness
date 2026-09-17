# 上游对齐审计 — dsh-v0.1.6-alpha.1

## 执行基线与验证记录

- 记录来源：`ef13d3f068`（Phase 0 三件套）恢复到主线 `master`（`409253c092`）之上；两棵本地树在 `packages/core/agent`、`packages/core/agent-loop`、`upgrades/`、`scripts/upstream-sync.json` 上无差异。
- 升级记录门：`verify-upgrade-records` 14 份记录通过；`verify-md-links` 2492 个文件、`verify-md-wrap` 2458 个文件通过。

## 干净基线测试（409253c092，实施前）

全量单测 1065 个文件通过、2 个失败（244 项）：`packages/experimental/code-runtime-python` 的 `boot-write-failure.spec.ts` 与 `runtime.spec.ts`。失败原因全部为 `config.pythonBin "/usr/bin/python3" must be CPython 3.10 or newer, got cpython 3.9.6`——宿主系统 Python 3.9.6 低于该包的运行要求，属环境性既有失败，与本次升级改动无关；修复属于环境准备（安装 Python ≥3.10），不阻塞其他阶段。

Lint（oxlint）0 告警 0 错误。

## 本次实施验证（Phase 2 首项：发布回滚）

- 新增 `interception.spec.ts` 回滚测试：`session/created` 与 `agent/created` 抛出时，create 以原始错误拒绝、Agent 与 Session 注册表已清空、同一 id 可立即重建（无轮询等待）。实施前两条测试在未清理状态下失败，实现后通过。
- 生命周期面全绿：interception 25、scope-lifecycle 38、resume 28、config-session-id 16。
- `tsc -b packages/core/agent-loop` 通过；局部 oxlint 0 警告 0 错误；`git diff --check` 干净。
- 未验证：真实 provider e2e、组装快照、TS/Python SDK 输出——本批为私有发布操作，不改公开事件与 Session schema；完整迁移（串行 `agent/created`、首轮输入屏障、消费者与 SDK 输出）仍未实施。

## 实施后全量复跑（c980a7e7b7）

全量单测 1067 个文件、18150 项：4 个文件失败。对比实施前基线：Python 3.9.6 环境性失败不变；`app-boot/tests/hmr-config.spec.ts` 与 `session-persistence-jsonl/tests/lease.spec.ts` 在全量并发下失败、单独重跑全部通过（23 项），属资源争用型不稳定，与本次改动无关。无本次改动引入的失败。


## Phase 2：发布期间输入暂存

- setup 和发布复用维护操作，成功才释放排队唤醒；失败时先取消唤醒再回滚，避免尚未成功创建的 Agent 开启模型轮次。
- disposed 取消会清除唤醒标记，即使先前已发生保留收件箱的普通取消；状态回调卸载根作用域时，未启动的驱动结算完成，不阻塞清理。
- AgentLoop 单测 19 文件、359 项通过；聚焦 interception 32 项与 cancel 37 项通过；包级 TypeScript 编译和局部 oxlint 通过。审查补充两条回归，确认普通取消保留输入但清除旧唤醒，之后的新输入仍可唤醒。
- Headless 产品与 TypeScript SDK 快照共 22 项通过；新增发布失败快照输出 `publication turn started: false`，其余已有预期输出不变。
- 公开创建事件仍为同步事件；串行事件、消费者迁移、Python 打包运行时快照、真实 provider 和桌面能力验收未完成。本批未重复执行仓库全量单测。

## Phase 2：串行创建与启动 hooks

- `2d893a6eb9` 引入串行 `agent/created` 与 Codex 启动等待；Claude Code 的 SessionStart 同样在初始化中等待，创建取消与桥接卸载会中止并等待进程清理，不注入迟到上下文。Hook 失败保留记录但不否决创建。
- `235cfdedc7` 修正测试消费者的异步 registry disposer 类型与等待；相关 5 文件 161 项测试通过，6 文件类型感知 lint 0 告警、0 错误。
- Claude 桥接 6 文件 69 项测试、包级 TypeScript 编译、局部 lint 通过。Headless 与 TypeScript SDK 原集合 23 项通过，包括真实 Claude 启动 hook 的首请求上下文和持久来源检查；未放宽请求次数断言或改写已有预期。
- 本批全量测试首次 1058 文件通过、9 文件失败，构建通过。在测试进程 PATH 指向宿主 Python 3.12 后，原 9 个失败文件集合最终复跑 516 项通过、2 项跳过。此前复跑出现过 Python 清理耗时 4074ms 超过 4000ms，快照出现过请求数 2 而非 1；隔离和原集合后续复跑通过，原因未确定，不据此宣称全量稳定性已解决。耗时和请求数断言均未修改。
- 待完成：goal、goal-round-driver、agent-team 旧启动事件消费者迁移与旧事件移除；Python SDK、真实 provider、桌面与 LAN/公网验收。各阶段状态仍以升级计划为准。

## Phase 2：旧启动事件移除与全量验收

- goal、goal-round-driver、agent-team 已迁移到串行 `agent/created`；旧事件类型、发布通知、scoped resolver 和生成目录条目已移除。生产源码与测试消费者搜索无旧事件引用。
- 创建期间入队后取消并保留 inbox 的回归通过：创建返回并 idle 后零模型请求、无 `turn/start`，新输入仍可唤醒保留消息。Headless 与 TypeScript SDK 快照 23/23、构建、类型检查和 lint 已通过。
- 本批首次全量 18047 项通过、4 项失败，失败为 ACP 子任务/标题等待诊断和 Python CPU/宽值用例。受控阻塞首次标题日志读取复现通用超时，修复保持原期限与谓词，保留场景诊断和最近观测错误；完整 harness 文件 63/63、包测试 224 项通过及 1 项跳过。
- 修复后使用 Python 3.12、原并发和超时配置执行 `pnpm test`：1067 文件通过、9 文件跳过；18052 项通过、116 项跳过，退出码 0。子任务诊断与两个 Python 用例未修改实现或放宽断言，本次全量通过不代表既往偶发失败根因全部解决。
- Python SDK 打包产物、coverage、独立 Gateway/插件业务回归、真实 provider、桌面和 LAN/公网验收尚未由本批完成。同步基线不前移，整次升级仍在进行。
