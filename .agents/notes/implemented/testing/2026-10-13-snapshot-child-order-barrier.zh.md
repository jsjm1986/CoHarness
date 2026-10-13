# Agent Note：让 advanced Python 快照的 workflow 子会话排在父会话交接记录之后

Status: implemented

[English](2026-10-13-snapshot-child-order-barrier.md) | 中文

## Problem

advanced 打包运行时快照（`smoke_sdk_snapshot`）比对 `result.json` 的通知流，而该流按墙钟时间交错来自父会话和两个子会话的 `session.event` 通知。只要 workflow 子会话先于父会话发出交接事件就到达第一个 step，父会话的 `tool-workflow/agent-start` 通知就会落在该子会话的 `subagent/descriptor` 块之后，使该 lane 因一段纯顺序 diff 而失败。`python-snapshot-workflow-order.mjs` fixture 及其 spec 早已存在，但场景从未挂载它。

## Decision

在 `smoke_sdk_snapshot` 内通过一个独立的 `order.patch.yml` 补丁挂载该顺序门闩。fixture 把 workflow 子会话的第一个 `agent/pre-step` 推迟到父会话记录到对应的 `tool-workflow/agent-start`。由于本树中 `subagent/descriptor` 与子会话首个模型请求都在 `agent/pre-step` 期间发出，门闩把既有快照记录的顺序钉住，而无需重录。

direct `subagent` 子会话刻意不加门闩：对同步 `run_in_background: false` 调用而言，它的第一个 step 必然先于父会话的 `tool/result`，不存在能在不死锁的前提下为它定序的父会话记录。

## Alternatives considered

**按观察到的顺序重录 `result.json`。** 否决——该交错本质上是竞态：重录的 fixture 在不同 runner 时序下会再次翻转，把门禁变成重试循环。

**删掉顺序断言。** 否决——通知流是 SDK 的线协议面；门闩保持其精确性，不削弱快照的证明力。

**用父会话的 `tool/result` 加 `delivery-accepted` 门闩 direct 子会话。** 否决——同步 subagent 的 result 只在子会话完成后才写入，子会话永远到达不了等待它的那个 step。

**在会话创建点而非 `agent/pre-step` 门闩。** 否决——子会话路径上没有更早的 waterfall 点，且 descriptor 仍会先于父会话交接发出。

## Consequences

advanced 快照的通知顺序在各平台 leg 上都是确定性的；子会话生命周期投递的回归现在会因内容而非排程运气而失败。共享 `write_advanced_profile_patch` 的另外三个场景不受此门闩影响，因为它们既不挂载该补丁，也不匹配其 prompt 与父会话身份。

## Verification

`scripts/python-snapshot-workflow-order.spec.ts` 通过 11 个用例，包括子会话首个 step 被持有直到父会话记录 `tool-workflow/agent-start` 的用例。打包运行时 lane 自身的验收仍是 CI `node24-*-x64` 矩阵对 `smoke-python-runtime.py` 的运行。
