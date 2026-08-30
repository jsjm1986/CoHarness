# Agent Note: 关闭 ACP stdio 传输以完成 teardown

Status: implemented

[English](2026-08-30-acp-stdio-teardown-listener-cleanup.md) | 中文

## Problem

未提供 transport override时，ACP bridge通过进程 stdio拥有 SDK connection。此前 Cordis plugin dispose只关闭 ACP session，没有关闭该 SDK connection，因此 `Readable.toWeb(process.stdin)`和`Writable.toWeb(process.stdout)` adapter会在重复 HMR或测试实例之间保留 `end` listener。

## Decision

ACP teardown在自有 session结算后关闭由 bridge创建的进程 stdio SDK connection。SDK取消路径随后释放 stdio reader，bridge继续使用原有幂等 quiesce promise完成 session清理和错误聚合。调用方提供的 transport仍由调用方拥有，plugin dispose不会关闭它。

## Verification

ACP focused测试和串行 thread-safe suite覆盖重复创建及 dispose。使用 `NODE_OPTIONS=--trace-warnings`时，不再出现进程流 listener warning；bridge仍通过现有 logger路径报告 session关闭失败。

## Alternatives considered

**提高进程流 listener上限。** 拒绝，因为这会掩盖传输所有权未释放，并允许 HMR／测试不断累积 listener。

**依赖 Cordis dispose清理 stream adapter。** 拒绝，因为 adapter由 SDK connection拥有，不是独立的 Cordis plugin effect。

**先关闭 session，再让 connection异步关闭。** 拒绝，因为进程 stdio transport必须在 bridge quiesce promise内关闭，否则重复挂载会保留 listener；但关闭动作必须在 session结算后执行，确保进行中的 prompt能发送正常的 cancelled结果。

## Consequences

ACP dispose现在同时关闭协议传输和自有 session。仍连接的 peer会观察到标准 ACP connection close，正常 session清理和错误聚合语义保持不变。
