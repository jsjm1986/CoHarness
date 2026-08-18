# Agent Note: 无损历史线分页

Status: implemented

[English](2026-08-14-lossless-history-wire-pagination.md) | 中文

## 问题

公网 Web 会话首次 `session.history`（`maxMessages: 50`）返回 28,187 条展开事件（6.19 MB JSON，其中 98.8% 为 `assistant/chunk`），在 Cloudflare 路径上耗时 17.8–48.5 秒；同一逻辑页在本地解码只需 84 ms。页面在该信封到达并由 Conversation 组装完成前一直停留在「载入历史…」。token 级 chunk 主导浏览器历史信封；逻辑事件流与渲染历史必须保持完整。

## 决策

`SessionsApi` 与 `SubagentsApi` 继续返回展开后的 `{ events, hasMore, projections? }`。只有 Fetch 载体把合格的 chunk 连续段转成物理 `records`，按完整未压缩 `server-response` JSON 的 UTF-8 字节计量（含信封、投影、视图与元数据），并在完整的追加来源消息组边界上缩小过大的成功页。`AbstractApiClient` 先校验并展开 `records`，业务状态才看得到结果。

编解码复用 `@deepseek-ai/dsh-session/chunk-rows` 的 `packChunkRuns()` / `decodeChunkRow()`。打包行是物理记录，不是 `SessionEventMap` 成员，绝不会进入 `Session.events` 或触发 `session/event`。未知或扩展的 chunk 事件字段按普通事件透传。畸形打包记录会在运行时状态变更前失败。

截断点取每个追加来源 `user/message` 或 `assistant/message` 的 seq 与其 `sourceEventSeqs` 的最小值。编码器至少返回一个不可分割的消息组，或一整页仅含事件的页。当单个消息组超过目标时，整组原样返回并带 `hasMore: true`，客户端仍能继续前进。物理编码器省略了任何逻辑前缀时，`hasMore` 为 true。

`dsh-client-connection` 持有 `historyPageTargetBytes`（默认 131,072）。该值是目标，不是硬拒绝上限。持久化、`SESSION_FORMAT_VERSION` 与 Conversation 组装保持不变。

### 验证

聚焦的编解码、Fetch 载体、schema 与 Host 插件测试钉住重建、恰好放下 / 少一字节的截断、超大消息组前进、畸形记录拒绝，以及未知事件透传。无密钥组装 Web 场景 `apps/web/tests/lossless-history-wire.e2e.ts` 植入少于 50 条追加来源消息，经生产 Host 桥接行使默认 131,072 字节目标，并记录 conversation 档 Chat golden 以及 Trajectory `detail: 'full'` 补全之后的结果。浏览器 Chat 首次打开不再展开全部历史打包 chunk；该下载档见 [两档会话历史传输](2026-08-18-conversation-history-tier.md)。

## 考虑过的替代方案

**把直接 API 改成打包记录。** 否决：所有进程内与非 Fetch 调用方都要学习第二套历史值，Conversation 也不再收到展开事件。

**改持久化或会话格式。** 否决：存储侧已由打包 JSONL 行承担成本；仅为传输问题抬格式版本会强制迁移。[会话日志版本机制](2026-08-10-session-log-version-mechanism.md) 不升级。

**在消息或 chunk 连续段内部截断。** 否决：Conversation 与实时增量共用一套 fold，假定页按消息成组；从连续段中间切开会拆开 `sourceEventSeqs` 与进行中的尾部。

**丢弃 token chunk，或只持久化组装后的助手消息。** 否决：高保真回放、失败流的部分输出与快照仍依赖持久化的 chunk（[只持久化组装后的助手消息](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.md)）。

**先发送展开后的逻辑载荷，再压缩。** 否决：实测延迟来自公网路径上的 UTF-8 JSON 体积；压缩 6 MB 展开正文仍要序列化并解析该正文。

**把字节目标当成硬拒绝上限。** 否决：一个不可分割的消息组可以超过 131,072 字节；拒绝它会卡住最新一页。

## 后果

浏览器历史页靠近配置目标，展开后的逻辑事件流、投影、工具视图与 Conversation 节点保持相同。直接 API 与实时帧继续遵守透传纪律。操作方可以从 connection 配置升降目标，而不改持久化。单个超大消息组仍整组发送，因此一条工具密集或很长的流式消息可以超过目标。Host 必须为每次历史请求编码并计量候选后缀；该 CPU 成本用来换公网传输下降。

相关所有者：[打包 chunk 行](2026-07-26-packed-chunk-rows-by-default.md)、[GUI 分层与 RPC 协议](2026-07-19-gui-layering-and-rpc-protocol.md)、[人类转写的追加来源分页](../bug-fix/2026-07-29-human-transcript-append-origin.md)、[Conversation 组装](2026-08-09-client-conversation-node-assembly.md)、[子代理历史来源](2026-08-06-subagent-list-identity-projection.md)，以及 [两档会话历史传输](2026-08-18-conversation-history-tier.md)。
