# Agent Note: 会话查询工具的参与方可读 ACL

Status: proposed

[English](2026-10-17-session-query-participant-acl.md) | 中文

## 问题

`dsh-tool-session-query` 过去以工作目录相等来授权每个跨会话目标：一个会话可以搜索、跟踪并读取任何 `cwd` 与调用方相同的会话。在 Gateway 项目运行时中，所有成员的会话共享项目目录，因此 `cwd` 相等覆盖了整个项目——某个成员的 agent 可以读取其他成员的全部会话，包括项目 ACL 标记为 `private` 的对话。工作目录相等回答的是"同一文件系统上下文"，而不是"该参与者可以读取此会话"；在共享项目运行时中这是信息泄露缺陷，而不只是缺失的功能。

## 提案

组合了 `collaboration` 服务时，每个跨会话 id 还必须出现在 `collaboration.capture().readableSessionIds(ids)` 中——即 `session-reference` 在 agent 上下文已应用的参与者级可读集合过滤。`personal` 参与者 scope 原样返回输入集合，因此不需要按 scope 特判；未组合该服务的组合保持仅 `cwd` 的行为。

每个操作在每个授权阶段批量发起一次 `readableSessionIds` 调用，并把返回的 `ReadonlySet<SessionId>` 传入同步过滤器：

- `authorizeTarget` 在 `cwd` 相等之外还要求目标可读；调用方自己的会话保留提前返回。
- `authorizeSessionIds` 将 `cwd` 授权集合与可读子集求交。
- `session_search` 一次性解析已授权工作区集合——一次 `cwd` 语料枚举加一次批量可读性调用——并复用于请求的父 id、流式命中、命中父会话与标题复核，因为命中随提供方分页到达，无法为每条记录各自等待一次批量调用。
- `session_trace` 在血缘读取后把目标、全部祖先与完整后代树合并为一次可读性调用，再把该集合应用到祖先边界、后代投影与标题检查。

当 `capture()` 抛出——没有绑定请求 principal 的环境轮次——操作失败关闭：所有跨会话 id 均未授权，而调用方自己的会话仍然可达，沿用现有 `serviceBoundary.unauthorizedTarget()` 拒绝。可读性提供方失败则像其他 `ctx.sessionQuery` 失败一样经过模型边界净化器传播，而不是静默降级授权。

## 考虑过的替代方案

- **保留 `cwd` 相等作为唯一检查。** 它不携带可见性信息，无法区分同一项目目录下的私密对话与共享对话。
- **在同步过滤器内逐条记录授权。** `readableSessionIds` 是异步的，而血缘与搜索命中过滤器是同步的；逐条调用还会按结果数量放大 Gateway 请求数。
- **只在搜索边界应用可读集合。** 模型仍可通过 `session_trace` 或 `session_event_read` 触达相同会话；强制必须放在每个操作都会经过的共享授权辅助函数中。
- **`capture()` 找不到 principal 时让整个操作失败。** 环境轮次检查自己的会话是合法的；拒绝一切会破坏独立运行的计划任务，而失败关闭保留了自身路径。

## 接受标准

- 项目成员的 agent 无法搜索、跟踪或读取参与者 ACL 标记为不可读的同 `cwd` 会话；拒绝保持 `SESSION_QUERY_TOOL_UNAUTHORIZED` 形态且不泄露 id。
- 在包括环境轮次在内的所有组合中，调用方自己的会话始终可达。
- `session_search` 发起一次覆盖请求的父会话、命中、命中父会话与标题的批量可读性调用；`session_trace` 发起一次覆盖整个返回血缘的批量调用。
- 未组合 `collaboration` 的组合行为与之前完全一致；单元测试覆盖被拒目标、过滤集合、血缘脱敏、环境失败关闭与提供方失败净化。

## 风险

工作区枚举为协作组合下的 `session_search` 增加了一次语料列举；枚举与后续提供方读取之间发生的可读性撤销仍会被每个操作已有的观察复核捕获。personal scope 与独立组合保留 `cwd` 规则，因此收紧后的规则只在存在参与者 ACL 时生效。
