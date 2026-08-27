# Agent Note: 从扁平化的消息文本中分类 pi-ai 传输层截断

Status: implemented

[English](2026-07-22-pi-ai-transport-truncation-classification.md) | 中文

## 问题

一次 TUI 运行的模型连接在流式输出中途断开，只浮现出一条 `terminated` 通知，而一个被截断的 Anthropic 响应则浮现出 `Anthropic stream ended before message_stop`。两者都是传输层截断——连接在提供方的终止 SSE（Server-Sent Events）事件之前就已断开——然而 `dsh-llm-pi-ai` 中的 `classifyPiAiError` 对两者都不匹配，最终落入兜底的 `PI_AI_ERROR`。由于 `PI_AI_ERROR` 不在 `llm-retry` 的 `DEFAULT_RETRYABLE_CODES`（`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`）中，一次可恢复的断开被当作永久性失败处理，从未被重试。

同一种终止事件措辞也可能出现在响应根本不是 SSE 流时。OpenAI 兼容 `baseURL` 缺少部署要求的 `/v1` 前缀时，可能返回 `200 text/html`；pi-ai 会把落地页当作流读取，最后报告 `Stream ended without finish_reason`。若仍把它视为 `TRANSPORT`，确定性的配置错误会被重试五次，且真正能识别问题的响应元数据会被隐藏。

细节丢失发生在上游，且在适配器内无法恢复：pi-ai 在推送终止 `error` 事件之前，把捕获到的错误缩减为 `error.message`（`api/anthropic-messages.js`：`errorMessage = error instanceof Error ? error.message : JSON.stringify(error)`），丢弃了原始的 `Error` 及其 `cause` 链。undici 将可据以采取行动的 `SocketError` 放在 `cause` 上，却只交给 fetch 包装层一个裸的 `terminated`；pi-ai 只保留了这个词。pi-ai 的 `SimpleStreamOptions` 没有暴露任何 fetch/dispatcher/client 钩子，让我们能在细节被扁平化之前自行捕获 `cause`。

## 决策

- `classifyPiAiError` 识别另外两种传输层措辞；当响应元数据缺失或明确表示 SSE 响应时，将两者映射为 `TRANSPORT`：
  - 流式输出中途的套接字断开，呈现为裸的 `terminated`（undici）或 `Premature close`（Node 流层）；
  - 在终止事件之前被截断的流，每个 pi-ai 提供方各自抛出不同措辞（`Anthropic stream ended before message_stop`、`… before a terminal response event`、`… ended without a terminal event`、`Stream ended without finish_reason`），统一按 `stream ended before/without` 匹配。
- 该分类器带有一条 `XXX(pi-ai upstream)` 注记，点名扁平化发生的位置并说明期望的修复方式：如果 pi-ai 有朝一日转发原始的 `Error` 或提供一个让我们捕获 `cause` 的钩子，就改为基于 `code`/`cause` 分类。在此之前分类仍是尽力而为的文本匹配。
- `PiAiAdapter` 通过 pi-ai 的 `onResponse` 回调捕获每次请求的 `ProviderResponse`。终止事件解析错误若发生在明确的非 `text/event-stream` 响应之后，就会映射为 `MALFORMED_RESPONSE`，保留 HTTP 状态，并在诊断中点名提供方、内容类型、协议与 `baseURL` 修正方向。OpenAI 兼容诊断还会说明这类端点通常需要 `/v1` 后缀。
- `llm-pi-ai/README.md` 同时记录 cause 链丢失，以及响应格式诊断所保留的有限响应元数据。

分类仍然基于消息文本，因为那是 pi-ai 唯一交付的信号；`XXX` 标明它是一个权宜之计，而非期望的最终状态。

## 考虑过的替代方案

**通过 pi-ai 的 fetch/dispatcher/client 钩子捕获 `cause`。** 否决：pi-ai 没有暴露这类钩子。`onResponse` 在响应体流被消费之前触发，因此只能保留状态与内容类型，无法观察或解释流式输出中途的断开。Anthropic 路径接受一个 `client` 对象，但为拦截传输错误而为每个请求构造并注入一个提供方 SDK client，只为一个诊断字符串就越过了适配器的服务边界。

**把两者都保留为 `PI_AI_ERROR`，并放宽 `llm-retry` 的可重试集合。** 否决：`PI_AI_ERROR` 是真正未分类失败的兜底，其中包括不可重试的失败（畸形的提供方响应、意料之外的 SDK bug）。让兜底可重试会重试那些永远不会成功的失败；修复之道是分类出可恢复的那种情况，而不是模糊这个类别。

**在适配器里把扁平化后的错误包装成 `LlmError('TRANSPORT', { cause })`，仿照 DeepSeek 适配器。** 在此否决：DeepSeek 适配器包装的是拿到响应之前的 `fetch` 拒绝，其 `cause` 仍然完好，因此链式包装保留了真实细节。而在 pi-ai 路径中，终止事件的 `errorMessage` 已经是一个没有 `cause` 可链的扁平化字符串，因此包装只会加一层却恢复不了任何东西；分类出 code 是唯一还能增加的价值。

**自动为每个 OpenAI 兼容 `baseURL` 追加 `/v1`。** 否决：合法网关可能直接在配置前缀下提供 Chat Completions，或使用其他部署路径。适配器会诊断收到的响应，而不会重写部署方拥有的地址。

## 后果

- 流式输出中途的传输层断开，以及在终止事件前被截断的 SSE 响应，会携带 `TRANSPORT`，因此组合出的 `llm-retry` 策略会默认重试它们，而不是让该轮次失败。
- 明确为非 SSE 内容类型、随后又出现终止事件解析措辞的响应会携带 `MALFORMED_RESPONSE`，因此默认策略只尝试一次，诊断中包含 HTTP 状态与配置提示。
- 真正的传输通知文本保持不变（`terminated` / `Anthropic stream ended before message_stop`）：cause 细节在适配器看到之前就已丢失，因此 `errorChain` 没有更多内容可渲染。
- 分类仍然依赖字符串匹配且依赖提供方的措辞：未来某个 pi-ai 版本若改写这些错误的措辞，就会静默回退到 `PI_AI_ERROR`，直到模式被更新。`XXX` 注记指向那个持久的修复方式（基于转发的 `code`/`cause` 路由）。
