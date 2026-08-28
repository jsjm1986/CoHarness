# @deepseek-ai/dsh-model-provider-config

English | [中文](README.zh.md)

Service Definition for the enabled organization- and project-managed model Providers available to one runtime. A Provider implementation publishes the complete immutable `ModelProviderConfigSnapshot` on `ctx.modelProviderConfig` and emits `model-provider-config/updated` only after committing a replacement with the reported monotonic revision. Adapter Consumers register these routes without copying them into editable user settings.

Organization route ids use the deployment-reserved `org-*` namespace. Project routes use a deployment-prefixed `project-<id>-<slug>` id and carry their project id. Each profile identifies its adapter driver, wire protocol, endpoint, optional read-only credential reference, and exposed models. Storage, authorization, credential resolution, and refresh ordering belong to Provider implementations.

## Model Experience

Indirectly, through LLM adapter Consumers that expose enabled organization models for selection and execution.

#### KV Cache effect

No direct effect. A Consumer-selected model or Provider change can select an independent model cache namespace.

## Known Limitations and Deferred Work

- **No persistence or transport** — deployments must mount a Provider that owns projection loading, revision ordering, and credential-reference delivery.
