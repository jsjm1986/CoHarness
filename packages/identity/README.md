# identity/ — shared identity

English | [中文](README.zh.md)

Identity values shared across product domains. These values do not represent an authenticated account.

| Package | Role | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.md) | Persists one anonymous Harness-home correlation id for telemetry, feedback, and DeepSeek requests | — |

The [session telemetry subsystem page](../../docs/subsystems/session-telemetry.md) owns the telemetry feature that carries the id on exports.
