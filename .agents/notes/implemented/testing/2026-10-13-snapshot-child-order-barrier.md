# Agent Note: Barrier the advanced Python snapshot children behind their parent handoffs

Status: implemented

English | [中文](2026-10-13-snapshot-child-order-barrier.zh.md)

## Problem

The advanced packaged-runtime snapshot (`smoke_sdk_snapshot`) compares `result.json`'s notification stream, which multiplexes `session.event` notifications from the parent and both child sessions in wall-clock order. The parent's `tool-workflow/agent-start` notice could arrive after the workflow child's `subagent/descriptor` block whenever the child reached its first step faster than the parent emitted its handoff, so the lane failed with a pure ordering diff on unrelated content. The `python-snapshot-workflow-order.mjs` fixture existed with its spec but was never mounted in the scenario, and it gated only the workflow child; the direct subagent child had the same unguarded race.

## Decision

Mount the ordering barrier inside `smoke_sdk_snapshot` through a dedicated `order.patch.yml` patch, and carry the direct-child branch upstream added: the fixture delays a child's first `agent/pre-step` until the parent session records the matching `tool-workflow/agent-start` for the workflow child, or — for the direct child — until the parent has consumed the spawning `tool/result`, begun its next `step/start`, and received `session-log-deepseek/delivery-accepted` through that result's sequence number. Because `subagent/descriptor` and the child's first model request are emitted during `agent/pre-step` in this tree, the barrier pins the snapshot's recorded order instead of re-recording it.

## Alternatives considered

**Re-record `result.json` with the observed order.** Rejected because the interleave is genuinely racy: a re-recorded fixture would flip back under a different runner timing, turning the gate into a retry loop.

**Drop the ordering assertions.** Rejected because the notification stream is the SDK's wire surface; the barrier keeps it exact without weakening what the snapshot proves.

**Gate at session creation instead of `agent/pre-step`.** Rejected because no earlier waterfall point exists on the child path, and descriptor emission would still precede the parent's handoff.

## Consequences

The advanced snapshot's notification order is deterministic on every platform leg; a regression in child-lifecycle delivery now fails the comparison for content reasons, not scheduling luck. The barrier is inert in the other three scenarios that share `write_advanced_profile_patch` because none mount this patch or match its prompt and parent-session identity.

## Verification

`scripts/python-snapshot-workflow-order.spec.ts` passes 12 tests, including the new direct-child case that holds the child's first step until the parent's `tool/result` is delivered and a later `step/start` plus `delivery-accepted` are recorded. The packaged-runtime lane's own acceptance remains the CI `node24-*-x64` matrix run of `smoke-python-runtime.py`.
