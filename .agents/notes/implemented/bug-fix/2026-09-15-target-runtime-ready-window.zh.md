# Agent Note: 目标 runtime 的就绪等待跨越瞬时重连

Status: implemented

[English](2026-09-15-target-runtime-ready-window.md) | 中文

## Problem

工作台选择器里打开一个项目会话需要点两次。`SessionRuntimePool.runtimeForTarget` 惰性启动 `forTarget` 连接并等待 `entry.ready`；它的 `onStateChange` 回调在第一次 `reconnecting` 转换时就拒绝该 Promise。`reconnecting` 在单个连接 generation 失败时触发——早于控制器退避重试执行——因此首次握手的瞬时失败（项目 runtime 冷启动的常见情形）会销毁挂起的 entry 并报出 `target runtime connection unavailable`。本可在约一秒后建立目标的 retry loop 被 `releaseEntry` 停掉；下一次点击对已预热的目标新建 entry 并成功。

## Decision

`entry.ready` 现在在一个有界窗口内等待跨过重连转换，而非在第一次转换时失败。`TARGET_RUNTIME_READY_TIMEOUT_MS` 期限（30 秒——两个 generation 握手预算）仅当窗口内没有任何 generation 产出就绪的会话列表时才拒绝等待并释放 entry，因此永久不可达的目标仍会失败而非让选择器一直挂起。`entry.ready` 落定后经由 Promise 链清除期限，`releaseEntry` 也继续为非连接原因的释放拒绝等待。重连簿记——`WorkspaceResourceRegistry.disconnect` 与 `SessionRuntime.handleDisconnected`——仍在每次 `reconnecting` 时执行，对已建成 entry 行为不变；对未就绪 entry 两者均为 no-op 或空态重置，会被下一次 `onConnected` 刷新覆盖。

## Alternatives considered

**在操作层重试 `ensureSession`/`chooseSession`。** 否决：每次尝试都要从零重建连接与 fiber，丢弃既有 loop 已取得的重试进度，且同样的竞态仍存在于其他每个 `runtimeForTarget` 调用方。

**统计 generation 失败次数、达到 N 次再拒绝。** 否决：`onFailure` 的上报并非每个 generation 一次（握手错误与流错误可对同一 generation 各报一次），且 `reconnecting` 在整个重试区间内去重，两个回调都无法给出干净的 generation 计数。

## Consequences

命中瞬时目标故障的首次选择现在会等过这次重试，单击即可加入窗格；死亡目标在窗口耗尽后报 `target runtime connection unavailable` 而非立即报错。选择器的 `pending` 标志在整个等待期间保持置位，因此该期限同时是对话框的解锁上界。

## Verification

`session-pool.client.spec.ts` 通过假 `ConnectionHandle` 先发出 `reconnecting` 再发出 `onConnected`，断言 `ensureSession` 在同一 entry 上成功解析；另有一个 fake-timer 用例断言期限触发拒绝并释放 entry。
