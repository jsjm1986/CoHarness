# identity/ — shared identity

English | [中文](README.zh.md)

Identity values shared across product domains. These values do not represent an authenticated account.

| Package | Role | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.md) | Persists one anonymous Harness-home correlation id for telemetry, feedback, and DeepSeek requests | — |

The [session telemetry subsystem page](../../docs/subsystems/session-telemetry.md) owns the telemetry feature that carries the id on exports.


## Summary

The identity group provides one anonymous id per harness home that the installation's telemetry, feedback, and DeepSeek requests attach to their records, so everything leaving one home can be recognized as coming from the same installation without identifying the user. There is nothing to configure: the id appears automatically the first time one of those features runs and stays stable until its file is deleted. The group has one package; this page maps it, and the package README owns the details.
