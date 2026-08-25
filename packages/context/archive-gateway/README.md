# @deepseek-ai/dsh-archive-gateway

English | [中文](README.zh.md)

Synchronizes the durable Workspace archive snapshot of a Gateway-launched runtime with the Gateway archive index. The provider sends a versioned ID snapshot, root lineage, session headers, retained Workspace placement, message counts, and title/body search projection; Gateway commands are applied on the next successful synchronization.

The provider also registers a loopback-only `/api/internal/archive/read` route. Gateway-issued archive capabilities can read a personal root and its descendants on demand; the route never accepts browser-origin traffic or a non-administrator assertion.

The provider is a runtime-only integration. Standalone local DSH compositions do not load it and keep their local archive registry unchanged.

## Model Experience

None, as the provider reads and synchronizes already-logged session state without adding prompts, tools, or model-request fields.

#### KV Cache effect

None. It does not assemble model requests or alter a reusable prefix.

## Known Limitations and Deferred Work

- Gateway synchronization is available only to runtimes launched with the Gateway credential; standalone local compositions keep their existing archive behavior.
- A personal transcript cannot be read while its owning runtime is unavailable or its persisted log is corrupt; the Gateway keeps the archive index row and reports the body as unavailable.
