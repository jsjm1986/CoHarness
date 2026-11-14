# Agent Note：上游 mcp-client 代际同步

状态：已实现

[English](2026-11-25-upstream-mcp-client-generation-sync.md) | 中文

## 问题

上游 rc.3 围绕显式 `McpGeneration` 记录、按 Fiber 状态单元、运行时凭据模板与一次性探测重写了 mcp-client 生命周期，但本地仍在运行旧版连接监督器，保证较弱：失败或超时的世代仍可能发布工具；旧受管进程范围尚未确认拆除时替代连接就可能启动；清理失败时 dispose 抛错会卡死调用方而非记录结果。本地还拥有上游没有的分歧——`McpProcessOwner` 准入、发现/服务进程隔离、资源预算集成与 `mcp/tool-call` 瀑布——因此整文件替换不安全。

## 决定

以上游代际模型为新基座，并把本地进程所有者与策略分歧重新接入其中。

`connection.ts` 现在为每个传输/客户端生命周期运行一个 `McpGeneration`：模板解析、连接与首次工具同步在世代信号内执行；`syncTools` 先抓取再经由既有的 `eligible()` 提交检查原子换入；注册失败抛出 `McpToolRegistrationError` 并经 `lost()` 路径关闭世代。重连监督、凭据刷新与通知再同步全部经由 `syncChain`/`settling` 串行化，因此新世代绝不会与关闭尚未确认的旧世代重叠。

`generation.ts` 拥有传输生命周期、待处理工作追踪，以及返回 `McpCloseResult { closeConfirmed, cleanupError? }` 而非抛错的 `close()`；`managed-stdio.ts` 保留本地准入、环境清洗、发现探测与进程范围清理——`McpGeneration` 可选地经 `processes.connect(client, transport)` 路由 stdio 连接。`status.ts` 在 `ctx.fiber` 上注册 `McpStatusCell`，在 HMR 重载后存活、保留最终 `McpCloseResult`、在最终卸载时解除观察者，并由管理器经 `connectionStatusOf(fiber)` 读取。`credentials.ts`/`templates.ts` 在 `expandTemplates` 下解析 `${credential:REF}`、监听 `credentials/reference-updated`，并把每个解析出的值——包括早期轮换值与 URL 编码形式——从诊断、工具错误与 `isError` 文本中脱敏。`probe.ts` 暴露 `probeServer`，用于不预留名称、不注册任何内容的一次性连接—识别—列举—关闭检查。`deadline.ts` 与 `types.ts` 补全共享截止时间与面向客户端的类型面。

挂载契约有意变更：`dispose()` 总在 `closeTimeoutMs` 内停稳；未确认或失败的清理记录进状态单元并记日志，`mountMcpClient` 拒绝同一 Fiber 的下一次挂载（`previous connection cleanup is incomplete; restart the Host`）——同时命名空间仍会释放，使新 Fiber 可以接管该名称。观察者在 `mountMcpClient.dispose` 内、`ctx.fiber.uid === null` 时解除，早于监督器发布终态 `closed`，因此观察者能跨重载存活却永远观察不到最终转换。

## 后果

- `startConnection(ctx, config, policy, status)` 需要 `McpStatusCell`；直接调用方自行构造，`apply`/`mountMcpClient` 经 `registerStatusCell` 获取。
- `expandTemplates: true` 在加载时要求凭据提供方；缺失的值进入 `waiting-credentials` 状态且不消耗重连尝试，只有解析值变化才触发受控重建。
- `startupTimeoutMs` 不带 schema 默认值；stdio 进程所有者保留自己的 `120,000` 准入回退。
- `Config` 在两种传输上接受 `closeTimeoutMs`（默认 5000）与 `expandTemplates`（默认 false），stdio 上接受 `processGraceMs`/`processCloseTimeoutMs`，并导出 `ReconnectSchema` 与面向管理器的 `./types` 包入口。
- 在重载中释放 Fiber 的状态观察者被隔离；清理仍覆盖进行中的尝试。

## 备选方案

- **保留旧监督器并外挂 status/probe**——拒绝：上游的正确性修复（世代隔离、有界关闭、凭据重建）通过同一组 `current`/`settling`/`syncChain` 状态互锁；局部移植会留下重写所消除的竞态。
- **保留清理失败时 dispose 抛错**——拒绝：上游的"记录并阻止"契约通过保留的状态单元覆盖重载替换场景且不卡死 Cordis 卸载，命名空间释放让新 Fiber 能够恢复。
- **放弃 `mcp/tool-call` 瀑布改用上游直连 `client.callTool`**——拒绝：本地部署策略（撤权取消、按服务准入）依赖该事件；改为围绕它合并上游的 signal/timeout 改动。
- **用上游 stdio 路径替换 `managed-stdio.ts`**——拒绝：本地资源预算准入、发现/服务进程隔离、环境清洗与受管范围清理在上游没有等价物；上游生命周期模型经 `McpProcessOwner` 注入与之组合。

## 验证

- `pnpm exec vitest run packages/mcp`——18 个文件 236 个测试通过，包括 `generation.spec.ts`、`status.spec.ts`、`credentials.spec.ts`、`probe.spec.ts`、`diagnostic.spec.ts`、重连/释放边界与受管 stdio 准入套件。
- `pnpm exec tsc -b packages/mcp/mcp-client`——干净；`verify-export-jsdoc`——干净；`oxlint`——干净。
- `verify-translation-pairing`——双语 README 重写后 2182 对一致；`gen-config-catalog` 已为新字段重新生成。
