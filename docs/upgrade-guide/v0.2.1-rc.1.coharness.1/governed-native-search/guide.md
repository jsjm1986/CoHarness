---
kind: upgrade-guide
description: "Managed native web search uses its configured LLM route for authorization, credentials, admission and usage."
---

# Select a model route for managed native search

English | [中文](guide.zh.md)

## Change

Native Messages and Sonar search use ordinary LLM authorization, model admission, execution attribution and actual usage reporting whenever model policy is installed or required, or its `provider` is configured. The default governed routes are `deepseek-official` for Messages and `perplexity` for Sonar search. Its prepared adapter owns the endpoint and credentials; independent `baseURL`, `apiKeyEnv` and `apiKey` search settings do not override them.

Direct DeepSeek API-key adapters and explicitly configured pi-ai Messages routes implement native Messages search. Explicitly configured pi-ai `openai-completions` routes implement Sonar search. Incompatible protocols fail with `MODEL_OPERATION_UNSUPPORTED`. Catalog routes relying only on provider-native login fail with `MODEL_OPERATION_AUTH_UNSUPPORTED` rather than projecting that login onto another request protocol. Missing required model policy or withdrawal during a wait refuses dispatch.

## Migration

1. Confirm that the managed runtime loads an LLM route supporting the corresponding Messages or chat-completions operation and authorizes its exact model.
2. Set `web-search-deepseek.provider` or `web-search-perplexity.provider` to that route when it differs from its default. Set search `model` to a model served by that route. Keep `maxTokens` and protocol-specific search controls.
3. Move custom search endpoints and credential references into that LLM route's connection configuration. Verify that its deployment supports the corresponding native search API.
4. Run a search and check its exact Session request plus actual usage. Missing provider usage remains missing and cannot create a zero-cost success record. Retry requests refused while a policy provider is being replaced.

Standalone compositions without model policy and without an explicit `provider` retain their independent endpoint and API-key settings. Their existing model resource protection remains active when a budget is mounted.
