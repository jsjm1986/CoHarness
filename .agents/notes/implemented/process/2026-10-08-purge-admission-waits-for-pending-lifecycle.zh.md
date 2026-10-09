# Agent Note: 清理准入等待 pending 生命周期结算

Status: implemented

[English](2026-10-08-purge-admission-waits-for-pending-lifecycle.md) | 中文

## Problem

`ctx.agents.reserveRemoval` 是一次性采样，并不承诺 Session 之后保持无声明。先用探针拿到预留、再调用 `HostSessionLifecycle.withReleased` 的用例，会与两次调用之间合法落入的 use 声明竞争；Agent registry 在准入时抛出 `Session "<id>" has a pending lifecycle operation`。`session-purge-composition.spec.ts` 中的 `Session "purge-root" has a pending lifecycle operation` 正是该竞争，被 CI 主机负载放大后暴露。

迟到的声明来自 `goal-round-driver`:pause 会让 `drive()` 清掉 `state.attempt`，随后 aborted `turn/end` 找不到归属 attempt 而落到 `disarm`，它发出 `goal/changed` 并重新进入 `requestDrive` → `ctx.agents.withoutInitiator` → `reserveUse`，为 abort 后的 checkpoint 持有 Session。这个新声明是正确的产品行为——驱动通过合并的 checkpoint 保留 Session——所以等待应由 purge 调用方承担，而不是驱动。

## Decision

把最终的 `withReleased` 包进 `vi.waitFor`，让准入本身就是成功条件：用例持续重试这个设计性拒绝直到驱动的 pending 声明结算，并在同一个等待里断言 paused goal 状态与已落盘的 checkpoint。声明永不结算时，测试仍在等待期限处失败，而不是靠一次幸运采样通过。任何先采样 `reserveRemoval` 再一次性调用删除的用例都适用同一模式。

## Alternatives considered

- **先探 `reserveRemoval` 再一次性调用 `withReleased`。** 探针只能证明采样瞬间没有声明；合法声明完全可以在调用前落入，这正是 CI 上观察到的碰撞。
- **等待某个驱动静默信号。** 驱动的声明状态是内部实现，外部没有任何可订阅的静默事件；可观察的结算只有持久事实——paused goal、已落盘的 persistence、准入成功的删除——而准入是唯一的原子检查加执行。
- **延迟 abort 事件链直到 checkpoint 完成。** 为了让采样可靠而放慢 abort 链路，是在为一个测试缺陷修改产品调度，且仍无法覆盖其他声明来源。

## Testing

`packages/host/apiproxy/tests/session-purge-composition.spec.ts` 本地 6/6 通过，包含 `hands checkpoint ownership to a live Goal turn and allows purge after explicit pause`。在无负载主机上无法强行撑开竞争窗口；机制由代码路径确立（`reserveRemoval` 准入、`drive` 清理 attempt、`disarm` → `goal/changed` → `requestDrive` → `reserveUse`）并与 CI 签名一致。被永久持有的声明会让用例在等待期限处失败，而不是静默通过。

## Consequences

purge 调用方契约不变——`withReleased` 在生命周期操作 pending 时仍然拒绝——用例现在把这个拒绝当作其设计中的重试信号。`remove` 每次准入至多被调用一次，且只有完整释放后的调用才会触达它，所以 once-only 断言在重试下依然成立。没有产品代码改动；驱动通过 checkpoint 持有 Session 的所有权不变。
