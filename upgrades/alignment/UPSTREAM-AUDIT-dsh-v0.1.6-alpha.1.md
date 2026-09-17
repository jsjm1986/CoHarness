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
