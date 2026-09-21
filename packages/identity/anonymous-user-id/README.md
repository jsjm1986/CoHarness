# @deepseek-ai/dsh-anonymous-user-id

English | [中文](README.zh.md)

Shared anonymous identity for session telemetry, direct feedback acknowledgement, and DeepSeek provider requests. `getOrCreateAnonymousUserId()` returns a random UUID v4 scoped to one harness home, persisted as the bare line `$DSH_HOME/.anonymous-user-id` (`~/.dsh/.anonymous-user-id` when `DSH_HOME` is unset). The OpenTelemetry backend reports it as Resource `user.id`; `/feedback` includes the same value in its acknowledgement; and `dsh-llm-deepseek` sends it as `x-deepseek-harness-user-id`, allowing the receiving systems to correlate records without independently generated identities.

The identity is never derived from the hostname, network address, git remote, or another identifying source. Deleting `.anonymous-user-id` resets the identity on the next process launch. Separate harness homes have separate identities.

## Summary

DeepSeek Harness uses one anonymous identifier per harness home to correlate telemetry, feedback, and DeepSeek requests from the same installation without identifying the user. The random UUID is stored in `$DSH_HOME/.anonymous-user-id` (`$DSH_HOME` defaults to `~/.dsh`), persists across restarts, and is regenerated after you delete the file. Different harness homes use different identifiers, and the value contains no machine or account data. Built-in features create and attach it automatically; package consumers can reuse the same value for installation-scoped correlation, but cannot join records across homes.

## Storage contract

Reads and writes are synchronous because both boot-time telemetry construction and direct command execution need one API. The result is memoized per resolved file path for the process lifetime. A first writer uses exclusive creation and a concurrent loser adopts the persisted winner; a corrupt file is replaced. Persistence is best-effort, so an unwritable home still receives a process-local UUID rather than blocking telemetry or feedback.

## Composition

This package is a shared library, not a Cordis plugin. Consumers import `getOrCreateAnonymousUserId()` directly. Its invariant companion is intentionally empty because the package owns no event stream or public mutable relation that can be checked without creating the identity as a side effect. `DSH_TELEMETRY_DISABLED` stops telemetry export only; it does not suppress direct feedback acknowledgement or the DeepSeek provider header.

## Model Experience

None, as the shared identifier reaches DeepSeek only as model-hidden HTTP metadata and registers nothing model-facing.

#### KV Cache effect

None; the transport header changes neither tokens nor the model-visible prefix.

## Known Limitations and Deferred Work

- **No recovery after deletion** — loss mints a new anonymous identity by design; recovery would require stable derivation material that weakens anonymity.
- **Best-effort concurrency** — a reader landing in the narrow interval between a concurrent process's exclusive create and completed write can use a different in-memory UUID for that run; later launches converge on the persisted value.
- **No cross-home identity** — different `$DSH_HOME` values cannot be correlated.
- **Configured DeepSeek gateways receive the id** — `dsh-llm-deepseek` sends the stable header to its resolved `baseURL`, including deployment overrides, independently of telemetry sharing mode.

## Invariants

**Runtime invariant:** No companion is published. The id is created once, persisted as a single durable line, and immutable thereafter; there is no changing relation to observe.
