# Agent Note: Keep queued resource polling on the Runtime service

Status: implemented

English | [中文](2026-11-19-resource-budget-poll-ownership.zh.md)

## Problem

The managed resource service captures its Cordis caller to determine the origin of each process or model operation. If a pending poll schedules the next poll through the same caller receiver, every callback adds another Cordis shadow. A long wait can exhaust the JavaScript stack while updating the timer or admitted byte count, interrupting workspace review or model admission.

## Decision

The [resource provider](../../../../packages/context/gateway-runtime/src/resource-budget.ts) passes the caller Context to origin capture and enters the queue through a callback bound to the Runtime-owned provider. Polling, completion, cancellation and disposal share that provider's mutable state and original queue and transport budgets. Each registration retains its own verified origin and exact completion identity.

## Alternatives considered

Increasing the queue deadline or JavaScript stack would leave the receiver chain unbounded. Capturing origin from the provider's Context would substitute the wrong authority for caller-scoped execution. Changing Cordis would affect all traced service consumers.

## Consequences

The provider test delivers a queued process permit after 200 pending polls and confirms a single quiescent completion for that registration. The dual Gateway and Runtime fixture refreshes synthetic node pressure between timed operations to model regular sampling under steady capacity. The persistent workload remains distinct from the repeated-poll regression.
