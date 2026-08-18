# Agent Note: Two-tier conversation history transport

Status: implemented

[English](2026-08-18-conversation-history-tier.md) | 中文

## 问题

公开 Web 会话第一次 `session.history`（`maxMessages: 50`）可能返回数万条展开事件，几乎全是 `assistant/chunk`，在 Cloudflare 路径上要数十秒。[无损 history 线路分页](2026-08-14-lossless-history-wire-pagination.md) 会打包这些 chunk，并把 Fetch 信封裁到约 128 KiB，但浏览器仍要在 Chat 渲染前展开全部历史 chunk。Chat 从 `assistant/message` 定稿；Trajectory 与 inspect 计时需要这些 chunk。持久化、`deriveMessages()`、压缩和 `session.prompt` 已经使用完整 Host 日志，并不等待浏览器下载。

## 决策

`session.history` 与 `subagent.history` 接受 `detail?: 'conversation' | 'full'`。缺失的 `detail` 与 `'full'` 返回已经分页页面上的全部事件。Web `Session` 在 `open()` / `loadOlder()` 时请求 `conversation`，除非该会话已经补全 detail。Host 仍分页出一段连续原始区间，再从 `events` 中省略符合条件的历史 chunk 游程，并以 `omittedSpans` 报告，使客户端保持无空洞的 seq 账本。Trajectory、Chat inspect 交接，以及持久化的 `view === 'trajectory'` 恢复，会对同一窗口请求 `full` 并按 seq 合并。Fetch 继续打包剩余 chunk。

`omittedSpans` 是被省略历史 chunk 游程的闭区间 `{ startSeq, endSeq }`；没有省略时该字段缺席或为 `[]`。

拆分发生在 `historyPage()` / `paginate()` 之后，因此消息组裁切、压缩配对、工具 `view` 和尾页投影不变。辅助函数保留所有非 chunk 事件；保留属于尚无追加来源 `assistant/message` 的组的 chunk 游程（进行中尾部与中断的不完整流）；省略落在已完成追加来源 `assistant/message` 之下的 chunk 游程（`sourceEventSeqs` / 组起点，与分页同一规则）；并按 seq 顺序发出合并后的 `omittedSpans`。未知的非 chunk 类型原样通过。`SESSION_FORMAT_VERSION` 保持 `0`。

客户端窗口是逻辑跨度：`baseSeq` / 尾 seq 取已加载事件 seq **与** `omittedSpans` 的最小／最大值。连续性与缺口修复对照该逻辑尾，而不是 `events[events.length-1]`。实时 mux chunk 仍按今日方式追加。`prompt()` 仍不门控 `openState`。Detail 补全使用与已安装窗口相同的 `beforeSeq` / `maxMessages`、`detail: 'full'`，按 seq 合并（已有条目在重复 seq 上胜出），然后一次 `replaceWindow`；被覆盖范围内的 `omittedSpans` 清除。因为 `full` 仍会碰到打包字节目标，补全会沿更早后缀走，直到当前窗口的 span 被覆盖。补全进行中，Trajectory 显示加载态；Chat 留在 conversation 档快照。依赖 chunk 中 `firstTokenTime` 的 TTFT / tokens-s 在补全前保持缺席。

### 验证

Host 测试钉住 conversation 省略、进行中与中断保留、`full`／缺失 `detail` 空操作、span 合并、后缀裁剪，以及未知类型透传。Fetch 与 connection 测试往返 `omittedSpans`。Session 测试钉住逻辑账本、`loadOlder` 连续性、跳过缺口修复、按 seq 合并补全，以及 conversation 档加载期间仍可发送。无密钥组装 Web 场景 `apps/web/tests/lossless-history-wire.e2e.ts` 断言浏览器第一次 `session.history` 使用带省略 span 的 `detail: 'conversation'`、不含历史打包 chunk 的 Chat golden、带 `detail: 'full'` 的 Trajectory 补全，以及持久化 `view=trajectory` 启动无需第二次点击即拉取 detail。

## 考虑过的替代方案

**在服务器上删除、跳过持久化或压缩掉 `assistant/chunk`。** 否决：高保真回放、失败的不完整流和快照仍依赖已持久化的 chunk（[assembled-assistant-messages-only](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.md)）。本次只改传输。

**流式传输 6 MB 展开页，指望压缩或转圈足够。** 否决：测到的延迟是公开路径上的 UTF-8 JSON 体积；Chat 渲染已定稿消息不需要历史 chunk。

**省略 chunk 但不带 `omittedSpans`。** 否决：客户端把最后已加载事件 seq 当作窗口尾，并要求 `loadOlder` 连续性 `tail.seq + 1 === baseSeq`。空洞看起来像 mux seq 缺口，会重新拉取巨大的一页。

**把 `detail` 缺省为 `conversation`。** 否决：省略该标志的进程内、ACP 和测试必须保持今日的完整事件页。

**改动 `session.prompt`、`deriveMessages()`、压缩或模型上下文。** 否决：那些路径已经读取 Host 日志；浏览器下载不在发送或模型上下文路径上。

## 后果

Chat 在 conversation 档页面上打开，而不再展开全部历史 chunk。Trajectory、inspect 交接和持久化的 Trajectory 视图为 `detail: 'full'` 付费并按 seq 合并；span 已空时第二次打开是空操作。补全仍会在 128 KiB 目标下走打包的 `full` 页，因此在巨大窗口上打开 Trajectory 会发出若干次 history RPC，而不是一次 6 MB 信封。Conversation 档 Chat 在补全前省略 TTFT。若把省略 span 当成 mux 缺口，会重新引入原来的下载。持久化、`SESSION_FORMAT_VERSION`、prompt 和模型上下文不变。Python SDK 没有 `session.history` 面，不在范围内。

相关所有者：[无损 history 线路分页](2026-08-14-lossless-history-wire-pagination.md)、[打包 chunk 行](2026-07-26-packed-chunk-rows-by-default.md)、[人类转写的追加来源分页](../bug-fix/2026-07-29-human-transcript-append-origin.md)，以及 [Conversation 组装](2026-08-09-client-conversation-node-assembly.md)。
