# Agent Note: Snapshot 录制前置检查

Status: implemented

[English](2026-09-10-snapshot-record-preflight.md) | 中文

## 问题

Snapshot replay 有意不需要 key，而录制会调用真实模型并需要凭证。如果没有早期检查，录制可能先开始 fixture 工作，随后在 provider 内部才失败，导致缺 key 看起来像场景或传输错误。

## 决策

Snapshot record 配置现在在 Vitest 注册场景前运行共享的 `snapshotRecordPreflight()`。前置检查可选加载仓库 `.env`，要求非空 `DEEPSEEK_API_KEY`，并在不打印凭证的情况下报告可操作的 `snapshot record requires DEEPSEEK_API_KEY`。普通 snapshot 和 web snapshot 配置共用这个 helper。Replay 和 refresh 不调用前置检查，继续保持无 key 行为。

## Alternatives considered

**让 provider 在第一个场景调用模型时失败。** 不采用：延迟失败会浪费初始化时间，并掩盖运行需要 secret 的事实。

**所有 snapshot 模式都要求 key。** 不采用：replay 和 refresh 的设计就是确定性、无 key。

**没有 key 时静默跳过 record 场景。** 不采用：跳过的录制可能看起来成功，却没有生成新的验证证据。

## Consequences

没有凭证或仓库 env 文件无法加载时，record 会在场景执行前失败。无 key 的 replay/refresh 仍可在开发机和便携 CI runner 上运行。前置检查只检查 secret 是否存在，不会记录或验证凭证内容。

## Tests

`pnpm exec vitest run scripts/snapshot-preflight.spec.ts scripts/ci-workflow.spec.ts scripts/ci-pr-scope.spec.ts` 通过，覆盖凭证存在、缺失和空值，并保留现有 workflow 契约。
