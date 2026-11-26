# Agent Note: Runtime resource completion during maintenance

Status: implemented

English | [中文](2026-11-22-runtime-resource-completion-in-maintenance.zh.md)

## Problem

A Runtime disposing an admitted process reports completion to the Gateway before shutdown. The maintenance write gate returned 503 for that authenticated report. The Runtime retried within its resource cleanup deadline and could reach the supervisor deadline before publishing a checkpoint receipt.

## Decision

The Gateway accepts a resource completion in maintenance after authenticating the Runtime generation and verifying the current database write epoch. The existing accounting transaction validates that the generation owns the reservation. The normal serving path uses the existing write gate.

## Alternatives considered

**Extend the shutdown deadline.** Waiting longer leaves completion blocked by the maintenance gate, so it cannot settle the reservation while the window is open.

## Consequences

The Runtime can report the end of existing work before exit. Resource admission and Session writes use the ordinary gates. [Uncertain accounting](2026-11-01-uncertain-resource-cancellation.md) retains occupancy until the owner proves cleanup.

## Verification

The Gateway HTTP test accepts an authenticated completion during maintenance and rejects unauthenticated completion, a stale write epoch, new resource admission and a Session append.
