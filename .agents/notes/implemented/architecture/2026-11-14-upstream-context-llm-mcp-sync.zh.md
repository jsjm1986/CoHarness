# Agent Note：来自 v0.2.2-rc.3 的上游 context、LLM 与 MCP 修复

状态：已实现

[English](2026-11-14-upstream-context-llm-mcp-sync.md) | 中文

## 问题

上游 `dsh-v0.2.2-rc.2 → dsh-v0.2.2-rc.3` 携带值得选择性回填的 context、LLM 与 MCP 修复；若干上游目标在本 fork 中不存在，或已被上游自行撤销。

## 决定

已回填的修复：

- `e3a485bd32` llm-deepseek：目录模型现在公布官方 `/models` 列表中的上下文窗口（1,048,576），不再是适配器回退值（1,000,000）。
- `032fd5f6d5` mcp-client：连接诊断保留 `cause` 链（`describeError`），`TypeError: fetch failed` 现在能显露真实的系统调用错误。
- `5285c6dcc4` mcp-client：工具同步只为仍有资格的 generation 提交——被放弃的尝试或关闭所超越的列表请求不发布任何内容，并保留既有注册；放弃时的注销逐个容错。
- `09570cf383` mcp-client（部分）：放弃时的注销容错与 `resolveReconnectPolicy` 再导出。上游的 probe 中止与异步状态监听部分针对 `probe.ts`/`status.ts`，本 fork 不存在这两个文件（属 mcp-manager 功能批）。
- `321d6362c5` compaction-basic：provider/model 切换前按新模型的信封压缩历史，通过 `tokenMeter.measure(session, header)` 计价；失败则以 `MODEL_SWITCH_COMPACTION_FAILED` 中止切换，保留原路由。
- `022da17f27` agent-loop/system-prompt：runtime-context 快照改为 "The following information describes your current session…"；去重改为比较快照 sections（上游语义）而非渲染文本，首次→后续 intro 翻转不再伪造更新。已重写记录的 fixture 与 session-title 注入前缀列表。

## 后果

- 无存储 sections 的恢复/遗留 `RuntimeContextProjection` 条目按精确文本或原始 body 去重；快照形式条目按 sections 相等去重。
- `renderContextSnapshot` 发出首次快照 intro；`joinContextSections` 只返回 body（agent.ts 将其送入 `project()`，intro 由 `project()` 负责）。
- Subagent spawn fixture：回滚的 spawn 之前合法地出现 `session/created`；`agent/created`/`subagent/start` 仍不得触发。
- 恢复但未 announce 的会话在 fixture 中 append 前需要 `ctx.sessions.announce(session)`（session-reference、gateway-execution authority）。

## 备选方案

- `b015d18e81` agent-loop 拒绝路由诊断——本 fork 不存在被检查的结构。
- `156dad153d` + `624c3e91a9` llm-deepseek 全延迟占位符——上游先加后撤；最终行为（显露 provider 400）与现有序列化器一致。
- `ed645016cd` tool-jobs 内联输出——本 fork 的 tool-jobs 代际没有内联完成通知路径。
- `8b085b7e35` web-search 凭据顺序——本 fork 的 web-search-deepseek 无账户路由（`deepseekAccount`）路径。
- `2676c67f32` prompt 前缀保留——已在前一批 session 生命周期中回填。
- `aa685be0a44` compaction 审阅细节——rc.3 中不存在该提交（已被取代）。

## 验证

受影响套件：agent-loop+system-prompt 549、compaction 235、mcp-client 149、llm-deepseek 548、session-reference 92、subagent-spawn-in-process + continuation-presets + gateway-execution authority 全绿。
