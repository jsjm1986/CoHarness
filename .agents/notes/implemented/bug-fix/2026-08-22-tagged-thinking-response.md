# Agent Note: Tagged thinking response compatibility

Status: implemented

English | [中文](2026-08-22-tagged-thinking-response.zh.md)

## Problem

Some OpenAI-compatible gateways serialize model thinking in ordinary streamed `delta.content` instead of a reasoning field. pi-ai 0.82.1 correctly exposes the documented `reasoning_content`, `reasoning`, and `reasoning_text` fields as native thinking events, but it cannot infer a tagged response dialect from ordinary text. The Harness therefore received the gateway's thinking and answer as one visible text block.

## Decision

The pi-ai adapter enables a text-thinking fallback for `openai-completions`. `TextThinkingParser` withholds the first non-whitespace prefix until it can prove one of the strict tags `<thinking>`, `<analysis>`, or `<think>` has a non-empty body and a matching close. The parser handles tags split across deltas, recovers cumulative text supplied by `text_end` or a terminal assistant message, and leaves ordinary, empty, unclosed, inline, and code or XML occurrences unchanged. Native pi-ai thinking events remain on their existing path.

The stream translator reserves a reasoning and text index pair for each native text index and queues later-index events while a lower text prefix is unresolved. This keeps interleaved reasoning, text, and tool-call chunks valid for the Harness stream invariant. A cumulative ordinary text value that differs from emitted deltas remains authoritative in its `block-end`. If any text block is converted, the terminal chunk omits pi-ai replay metadata because one native text block becomes two Harness blocks; durable Harness content remains authoritative and later history uses provider-neutral conversion. Leading formatting remains in the reasoning block; the [Think summary decision](../../implemented/feature/2026-08-02-web-thinking-tail-scroll.md) owns its collapsed presentation.

## Alternatives considered

**Trust only pi-ai reasoning fields.** Rejected: the affected gateway places the thinking in ordinary `delta.content`, so the documented fields never reach the adapter and the visible transcript stays wrong.

**Parse every matching tag anywhere in the response.** Rejected: an answer can quote XML, show a code example, or mention a tag in ordinary prose. A first non-whitespace prefix with a non-empty matching close limits the misclassification to an explicit response convention.

**Add a configurable response-dialect field before shipping the fallback.** Deferred: the current incident has no preserved raw SSE body that identifies the gateway's exact delimiter, while the strict three-tag heuristic covers the observed OpenAI-compatible family without changing the profile schema. The heuristic collision remains documented and is the trigger for a future explicit dialect setting.

## Consequences

Tagged thinking from private OpenAI-compatible gateways renders as a separate reasoning block without changing native reasoning behavior on other protocols. An intentionally tag-prefixed answer can be classified as reasoning, and an unknown delimiter remains ordinary text. Converted responses lose provider-native replay signatures and response ids for that turn, but their durable Harness blocks remain complete and safe to replay as provider-neutral history. Empty native text blocks remain emitted when no conversion occurs so replay entries stay aligned. Reasoning hidden by the provider, or available only as textual `reasoning_details` that pi-ai discards, remains unavailable to this adapter.

## Testing

`packages/llm/llm-pi-ai/tests/text-thinking.spec.ts` covers split tags, supported tag names, whitespace prefixes, empty and unclosed tags, inline and code examples, transformed tails, cumulative suffix recovery, and chunk-boundary independence. `packages/llm/llm-pi-ai/tests/convert.spec.ts` covers native reasoning alongside fallback text, interleaved tool calls, missing or divergent deltas, terminal-only text, empty blocks, error finishes, index uniqueness, fallback disablement, and replay alignment. The adapter integration suite covers an OpenAI-compatible SSE response whose thinking is carried only in ordinary content. Focused V8 coverage keeps `text-thinking.ts` and `stream.ts` at 100% for statements, branches, functions, and lines.
