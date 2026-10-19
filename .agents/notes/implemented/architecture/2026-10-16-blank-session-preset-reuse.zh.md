# Agent Note：空白 Session 按请求 preset 复用，而非按记录 preset

状态：implemented

[English](2026-10-16-blank-session-preset-reuse.md) | 中文

## 问题

上游 PR #5460 与提交 `3c1e3571329f` 修复了一个死锁：记录的 Agent preset 被删除后，空白 Session 永远无法打开——每次恢复都解析已记录的 composition 并抛出 `agent-preset-not-found`。本地 fork 存在同样的故障，且比上游 UI 层多一层区分：`session.create` 命名 Session 时既可能是收养（按记录 preset 重放历史），也可能是 Workspace 空白复用候选，这两种语义不能混淆。

## 决策

**命名收养保留历史；`reuseWorkspaceBlank` 执行请求。** 仅带 `sessionId` 的 wire 请求仍是收养——恢复的 Session 保留其日志记录的 composition，因为其对话轮次依赖该 composition 重放。`reuseWorkspaceBlank` 旗标把被命名的 Session 声明为复用候选：它运行请求的 `agentPreset`；未命名或所名 preset 不再被声明时，运行部署默认 preset。空白 Session 没有可重放的轮次，因此不受过期 composition 约束。

**被拒绝的候选直接替换，不做修补。** Host 在获取 writer 后重新校验空白性；候选若在期间被填入内容、失去 writer 或拒绝切换，抛出 `BlankReuseDeclined`，并发创建恢复逻辑在通用 live-agent 收养之前先重抛它，避免被吞掉。随后 create 命令以同一请求铸造新身份——迁移任何草稿预约——并 attach 该新身份。

**`agentPresets.select` 幂等。** 当日志已记录所请求的 preset 且 Agent 仍绑定当前 generation 时，`select` 直接返回，不重组、不记录、不公告。按 Session 串行化保证过期的空白性读数不会插入两次切换之间。

**不同 preset 的请求不合并到同一个 in-flight connect。** `connectWorkspace`/`openWorkspace` 接受 `{ agentPreset }`；in-flight map 只合并 preset 完全相同的请求（省略与命名视为不同），且过期尝试不能删除更新的 map 条目。`agent-preset-not-found`/`agent-preset-invalid` 响应触发恰好一次不带 `agentPreset` 的重试。复用被拒绝而返回不同身份时，重新拉取 session 列表，因为缓存的空白元数据会隐藏这个已被填满的行。

**启动恢复走同一条复用臂。** 持久化的 `dsh.sessions.current` 若指向某 Workspace 成员的空白 Session，则以 `reuseWorkspaceBlank` 和摘要中的 `agentPreset` 调用 `sessions.create`——该值来自客户端列表的日志解析结果而非 header——因此已废弃的记录 preset 会在重试时降级为默认。

**冷列表的 preset 真值来自已经付过成本的探测。** 当有界空白探测已读过日志时，`summarizeCold` 从折叠的探测事件（`sessionListFields`）解析 `agentPreset`；未探测的大型 artifact 保持仅 header——为这一条切换事实付出全量读取不值得。

**复用臂只服务 Workspace 重连。** `connectWorkspace`/`openWorkspace` 回退、启动恢复与携带草稿的启动保留上述语义；不带草稿选项的 `startSession` 改为铸造全新 Session+Agent，不再采用成员空白或停放的草稿预留——见[裸 New Session 全新铸造](2026-10-18-new-session-fresh-agent.zh.md)。

## 备选方案

**像上游折叠后的 create 一样，把每个命名 Session 都当作复用候选。** 否决：上游 UI 无法命名任意 Session 来收养，本地 wire 可以；收养必须为非空历史保留记录的 composition。

**冷列表继续使用 header `agentPreset`。** 否决：切换过 preset 的空白 Session 会使 header 过期，而启动恢复依赖摘要值。探测本就持有事件，日志派生的真值在该路径上零成本。

**在 Host 内部重试失败的 preset。** 否决：类型化的 `agent-preset-not-found`/`agent-preset-invalid` 错误码已存在；客户端单次重试保持了 wire 契约的诚实，也让失败对其他调用方可见。

## 影响

`session.create` 接受 `agentPreset` 与 `reuseWorkspaceBlank`；`SessionsPort` 暴露 `create` 并在摘要上提供 `agentPreset`；`SessionRuntimePool.create` 双向翻译池化身份。草稿臂保留记录 preset 并在缺失时降级默认，保住了草稿恢复语义。对 live 空白 Session 的切换追加 `agent-preset/selected`，使日志——而非 header——成为投影的真值来源。

回归覆盖位于 `packages/host/apiproxy/tests/api-proxy-agent-preset.spec.ts`（复用臂、拒绝后铸造、live 切换）、`api-proxy-cold.spec.ts`（探测派生 preset）、`packages/client/runtime/tests/workspaces-service.client.spec.ts`（preset 转发、重试、列表刷新、按 preset 的合并、启动恢复）以及 `apps/web/tests/blank-preset-reuse.e2e.ts`（出厂 composition 下已声明与未声明 preset 的复用与恢复）。

## 测试

`packages/host/apiproxy`：agent-preset 与 cold 套件——59 个测试。`packages/client/runtime`：workspaces 与 sessions 套件——96 个测试。`apps/web`（host+client 构建产物）：`blank-preset-reuse.e2e.ts`——经真实 Loader composition 的 4 个测试。
