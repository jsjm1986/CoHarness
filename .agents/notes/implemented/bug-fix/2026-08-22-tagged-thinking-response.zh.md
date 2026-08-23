# Agent Note: OpenAI 兼容标签化思考响应

Status: implemented

[English](2026-08-22-tagged-thinking-response.md) | 中文

## 问题

部分 OpenAI 兼容网关把模型思考序列化到普通流式 `delta.content`，而不是 reasoning 字段。pi-ai 0.82.1 会正确地把约定的 `reasoning_content`、`reasoning` 和 `reasoning_text` 字段公开为原生 thinking 事件，但无法从普通文本推断带标签的响应方言。因此 Harness 收到的思考和回答会成为同一个可见文本块。

## 决策

pi-ai 适配器为 `openai-completions` 启用文本思考 fallback。`TextThinkingParser` 会暂存第一个非空白前缀，直到确认严格标签 `<thinking>`、`<analysis>` 或 `<think>` 之一具有非空正文和匹配闭合标签。解析器支持标签跨增量分片到达，使用 `text_end` 或终端 assistant message 提供的累计文本恢复缺失内容，并将普通文本、空标签、未闭合标签、正文中的标签以及代码或 XML 示例保持不变。pi-ai 原生 thinking 事件继续走原有路径。

流转换器为每个原生文本 index 预留 reasoning 与 text 两个索引，并在较低 index 的文本前缀尚未判定时暂存后续 index 的事件，从而让交错的 reasoning、文本和工具调用分片始终满足 Harness 流不变量。累计的普通文本值与已发出增量不一致时，其 `block-end` 仍以完整内容为准。如果任一文本块发生转换，终端分片会省略 pi-ai replay 元数据，因为一个原生文本块变成了两个 Harness 块；持久化的 Harness 内容仍然权威，后续历史使用提供方无关的转换。前导排版仍保留在 reasoning 块中；[思考摘要决策](../../implemented/feature/2026-08-02-web-thinking-tail-scroll.zh.md)负责其折叠呈现。

## 考虑过的替代方案

**只信任 pi-ai 的 reasoning 字段。** 否决：受影响的网关把思考放在普通 `delta.content` 中，因此这些约定字段根本不会到达适配器，可见 transcript 仍然错误。

**在响应任意位置解析匹配标签。** 否决：回答可能引用 XML、展示代码示例，或在普通正文中提到标签。只接受第一个非空白前缀、非空正文和匹配闭合标签，可以把误分类限制在明确采用该响应约定的情况。

**在 fallback 发布前增加可配置的响应方言字段。** 延后：当前事件没有保存完整原始 SSE body，无法确认该网关使用的确切分隔符；严格的三个标签启发式已经覆盖观察到的 OpenAI 兼容响应族，不必先改变 profile schema。启发式冲突已记录，并作为未来显式方言设置的触发条件。

## 后果

私有 OpenAI 兼容网关的标签化思考会渲染为独立 reasoning 块，同时不改变其他协议的原生思考行为。有意以这些标签开头的回答可能被归类为思考，未知分隔符仍会保留为普通文本。发生转换的响应会失去该轮的提供方原生 replay 签名和响应 id，但持久化的 Harness 块保持完整，并可作为提供方无关历史安全重放。没有发生转换时，空的原生文本块仍然会发出，以保持 replay 条目对齐。排版空白在展开后仍可见，但不会再产生空的折叠摘要。提供方隐藏的推理，或者只存在于 pi-ai 会丢弃的文本型 `reasoning_details` 中的推理，对本适配器仍然不可用。

## 测试

`packages/llm/llm-pi-ai/tests/text-thinking.spec.ts` 覆盖分片标签、支持的标签名、带空白前缀、空标签和未闭合标签、正文及代码示例、转换后的尾部文本、累计后缀恢复以及分片边界无关性。`packages/llm/llm-pi-ai/tests/convert.spec.ts` 覆盖原生 reasoning 与 fallback 文本并存、交错工具调用、缺失或不一致的增量、仅终端文本、空块、错误结束、索引唯一性、fallback 关闭以及 replay 对齐。适配器集成测试覆盖仅把思考放在普通内容中的 OpenAI 兼容 SSE 响应。聚焦的 V8 覆盖率检查将 `text-thinking.ts` 与 `stream.ts` 的语句、分支、函数和行全部保持在 100%。
