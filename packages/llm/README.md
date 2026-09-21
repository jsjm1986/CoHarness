# llm/ — LLM capability family

English | [中文](README.zh.md)

The LLM seam and its provider adapters. The `llm` package owns both the Service Definition and Consumer roles: the abstract service, content-block vocabulary, and stream-chunk assembler. Provider adapters register on `ctx.llm`. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`llm/`](llm/README.md) | LLM service and shared streaming vocabulary | `ctx.llm` |
| [`token-meter/`](token-meter/README.md) | Replay-aware token measurement | `ctx.tokenMeter` |
| [`llm-retry/`](llm-retry/README.md) | Provider-scoped retry policy | listens to `agent/request-error` |
| [`llm-deepseek/`](llm-deepseek/README.md) | Direct DeepSeek adapter | registers on `ctx.llm` |
| [`model-provider-config/`](model-provider-config/README.md) | Organization Provider configuration | `ctx.modelProviderConfig` |
| [`llm-pi-ai/`](llm-pi-ai/README.md) | Multi-provider pi-ai adapter | registers on `ctx.llm` |

Adapters register provider routes on the seam; retry and token measurement remain separate consumers. The child READMEs own routing, metadata, replay, and provider-wire details; the [LLM architecture decisions](../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md) own the rationale.

The subsystem reference — messages and blocks, the model request, the `StreamChunk` protocol, the adapter contract — is [docs/subsystems/llm-streaming.md](../../docs/subsystems/llm-streaming.md) (token measurement: [token-meter.md](../../docs/subsystems/token-meter.md)); see the [twin adapters](../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md), [replay token meter](../../.agents/notes/implemented/architecture/2026-07-15-replay-token-meter-service.md), and [routed model context](../../.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.md) Agent Notes.


## Summary

The llm group provides the harness's model-call capability: one provider-neutral service through which any composition streams requests to a model provider, plus adapters, provider-specific request metadata, retry execution, and measurement. The core `llm` package defines the message, content-block, and stream-chunk vocabulary every plugin and the session log use; provider adapters translate a provider's wire format into that vocabulary; DeepSeek request-extension plugins contribute lifecycle-owned metadata outside model input; `llm-retry` re-runs failed requests at durable agent-step boundaries; and `token-meter` measures request and context pressure from the durable log. This page maps the group; each package README owns its per-package contract.
