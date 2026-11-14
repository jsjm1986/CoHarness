# Agent Note: Forge 谱系与 worktree 代际吸收

Status: implemented

[English](2026-11-15-forge-lane-absorption.md) | 中文

## Problem

上游 v0.2.2-rc.3 交付了变更请求工作流谱系：`forge` 注册表、
`forge-github` provider、`forge-session` 投影、`client-ui-forge`
浏览器面板，以及 worktree 重写——checkout 按 Session 记录、删除后可
恢复、归档时回收。本地 worktree 包还停留在上一代（仅创建并进入），
上游针对 checkout 生命周期的每个修复都无法评估，回收行为在本地
完全没有对应物。

## Decision

- 原样携带 `experimental/forge` 与 `experimental/forge-github`：
  注册表核心与 GitHub provider 连同其 seam 落地，本地变更请求工作流
  由此获得 provider 中立的属主。
- 按本地投影注册表携带 `experimental/forge-session`：
  `ProjectionHandle` 改为 `sessionProjections.register()` 返回的
  disposer，状态经 `stateOf(session, 'forgeChangeRequests')` 读取，
  并在 `SessionProjectionStateMap` 与 `SessionProjectionMap` 双双声明。
- `experimental/worktree` 升级到 rc.3 代际：`plugin:worktree/created`
  fold、生成命名、restore 生命周期与 `WorktreeReclamation` 全部落地；
  上游独有的 `settings` `configure` 表单调用剔除，因为本地没有
  settings 页面生成机制。
- 回收状态读取经 `ReclamationHost.projectionState` 穿入而非 handle；
  `cachedSnapshot` 接收本地缓存要求的显式 `inheritedEventCount`——
  seeded Session 的计数是 header 不携带的日志状态，其标识不可能匹配
  checkpoint，因此读取直接落到日志。
- 为支撑回收落地三个核心面：`working-directory/access` waterfall
  让目录验证与 checkout 移除互斥；`workspace/session-archived` 与
  `workspace/session-unarchiving` 在持久写前后准入并结算归档后续
  工作；`SessionQueryEngine.inspectSession` 在 live 或 prepared
  Session 上读域状态而不发布（`SessionObservationReader.acquire`
  重构）。
- `client-ui-forge` 继续 deferred：Host 半边只需常规适配，但 React
  半边属异代（缺 `dsh-api-remote-access` 包、`*OutlineRegular` 图标
  对本地 `*16` 命名、缺 locales 模块、`forgeWorktree` 投影键未注册），
  正确移植需对照本地 primitives 重写 client 半边。
- 保留本地目录包含约束：`workingDirectory.set` 仍拒绝项目根外的
  路径，跨仓库 worktree 借用方因此把第二个仓库嵌进项目内。

## Consequences

- 归档 Session 的自有干净 checkout 现在自动回收；fork、目录借用方
  与 subagent 祖先维持保留。
- 目录访问在包含它的 checkout 排空期间阻塞，被移除的 worktree
  不会与 `cd`/`ensure` 竞争。
- 冷 Session 有投影缓存时由缓存回答回收问题，否则经
  `inspectSession` 读日志——清理不物化 Agent。
- `client-ui-forge`、`forge-bundle`、`subagent-oar` 与
  `sdk-run-commands` 管道仍是对齐矩阵中记录的延期项，各带再进入
  条件。

## Alternatives considered

- 移植 `ProjectionHandle` 本体被否：本地注册表已通过
  `register`/`stateOf` 持有代际状态，各消费点改为本地惯用法，而不是
  再养一套 handle 模型。
- 对 `isSeeded` 未知时省掉缓存探测被否：为 seeded Session 猜
  `inheritedEventCount` 只会必然错过 checkpoint 标识，用显式不可匹配
  的偏移量把落空写成文档，语义保持诚实。
- 为对齐上游 `set` 语义而放松项目根包含被否：包含约束是本地针对
  无包含日志的刻意加固，嵌套仓库测试模式保住了覆盖而不削弱不变量。

## Verification

- `worktree` 套件：101 测试通过——创建、恢复、checkout 安全、
  sandbox 约束、含冷缓存与 subagent 祖先场景的归档回收。
- `forge`/`forge-github`/`forge-session` 套件：73+417+135 测试通过，
  除投影注册表适配外无改动。
- `session-query`、`working-directory`、`workspace` 套件带新增的
  `inspect`/`access`/归档事件面通过：所有触及包合计 1102 测试。
