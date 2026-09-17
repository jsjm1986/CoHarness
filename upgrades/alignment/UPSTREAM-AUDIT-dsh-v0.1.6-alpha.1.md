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
