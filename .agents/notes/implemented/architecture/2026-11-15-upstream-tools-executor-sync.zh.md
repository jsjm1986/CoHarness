# Agent Note：上游 tools 执行器 seam 与 tool-office 同步

状态：已实现

[English](2026-11-15-upstream-tools-executor-sync.md) | 中文

## 问题

上游 v0.2.2-rc.3 把工具准入改成了按步骤持有的 `ResolvedToolSet`，并交付了 Office 工具消费方。本地 `ToolRegistrationOptions.when` 虽存在，但没有任何请求路径解析工具集，激活条件从不会被求值，面向模型的 schema 集合可能偏离可执行集合；Office 工具则完全没有消费方。

## 决策

- 每个已准备的步骤在 `preStep` 中解析 `ctx.tools.resolve({ agent, modelSelection, signal })`，将 `ResolvedToolSet` 传入 `systemPrompt.assemble`，随 `PreparedStep` 携带，经 `executeToolCalls` 转发进 `ctx.tools.execute`，并在步骤结束后、每次拒绝、早退或出错时恰好 dispose 一次。
- `stepModelSelection()` 依次读取 `sessionProjections.stateOf(session, 'modelSelection').pending`、`.lastUsed`、`session.requestHeader()?.config`，最后是 Agent options 路由；`prepareRequest` 用同一选择做种子，使恢复与 fork 的 Agent 保留已记录的 provider/model，而在无已记录路由时 `agent/request` waterfall 仍可提供或拒绝路由。
- `ResolvedToolSet` 在解析时按对象身份绑定注册项；步骤中途被替换的注册让在途调用在旧注册上正常完成，后续调用解析为 `UNKNOWN_TOOL`，被替换体绝不在其前任获得的准入之下运行。
- `@deepseek-ai/dsh-tool-office` 通过 `ctx.tools` 声明 `office_convert`、`office_recalculate` 与 `office_render`，配合按步骤求值的 `when` 激活：Office 技能加载后的下一步出现这些工具，并在上一请求头部仍携带 Office 工具期间保持声明。输出是临时文件，归调用方 subagent 树的根 Session 所有；存在 `subagents.rootOf()` 时以其为准，code 为 `UNAUTHORIZED` 的 `SubagentError` 回退到调用方 Session，其他错误继续抛出；服务不存在时经 `ctx.get('sessions')` 遍历 durable `parentSession` 链。
- `gen-tool-catalog` 以无害的 `officeKit` 桩与 `AgentRegistry` 挂载 Office 包；`tsconfig.base.json` 增加 `@deepseek-ai/dsh-tool-office` 路径别名，生成目录已刷新，审校过的中文对应文档重新配对。

## 后果

- `ToolRegistrationOptions.when` 按步骤对当前路由求值，模型可见工具始终恰好等于可执行集合。
- 恢复与 fork 的 Agent 保留已记录路由；依赖 `agent/request` 提供路由的组合继续工作。
- 步骤中途替换注册的工具实现不再捕获准入授予被替换注册的调用。
- Office 输出文件在两种服务拓扑下都遵循 subagent 树归属（上游 `rootOf` 与本地 `parentSession` 血统）。

## 已考虑的替代方案

- 按 Agent 而非按步骤解析工具集被否决：`when` 条件依赖步骤级状态（技能加载、上一请求头部），按步骤解析才是激活契约。
- 仅从 Agent options 为 `prepareRequest` 提供种子（本地没有上游的 `AgentModel.current()`）被否决：恢复与 fork 的 Agent 没有 options 路由，会在 waterfall 之前失败。
- 无条件要求 `subagents.rootOf()` 被否决：本地运行时不暴露它；双路径归属让两种拓扑都正确，且不改运行时契约。

## 验证

- `tool-office` 套件：127 个测试通过——native 与 PTC 执行器模式下的激活、技能激活、resume 与 fork 下的请求头保留、输出生命周期、subagent 归属回退、Kit 不可用的错误映射。
- `agent-loop` 套件在 `preStep` 与调度器改动后通过；`gen-tool-catalog` spec 通过，生成目录为最新，`verify-translation-pairing` 干净。
