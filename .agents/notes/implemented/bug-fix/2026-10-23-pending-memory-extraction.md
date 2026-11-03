# Agent Note: Pending memory extraction eligibility

Status: implemented

English | [中文](2026-10-23-pending-memory-extraction.zh.md)

## Problem

Memory curation retains one running pass and one pending capture per session. Replacing that pending capture with every completed turn lets an acknowledgement or a turn that already wrote memory suppress an earlier informative turn. Copying only its eligibility onto a later participant's capture would also change the [execution owner](2026-10-23-curation-execution-identity.md) of the admitted work.

## Decision

A pending capture eligible for extraction is replaced only by another eligible capture. Its replay input, cursor target, and execution scope remain together. Ineligible turns can still replace an ineligible pending capture for consolidation evaluation. Execution authorization and live feature switches are checked when the pass runs.

## Alternatives considered

**Remove the low-signal filter.** Acknowledgements would initiate model calls without meaningful new prose.

**Carry eligibility into the latest capture.** Earlier work could run under another participant's identity and advance its cursor over a turn that did not qualify.

## Consequences

The queue remains bounded to one pending capture. Its extraction cursor can end before a later skipped turn; a future informative turn can include that later history.

## Verification

Deterministic project-space regressions hold one extraction, queue another participant's informative turn, and then admit either an acknowledgement or a self-curated turn. The pending extraction retains its original participant and sequence. A real Agent, GatewayExecution, and JSON memory replay admits three participants and records the durable extraction under the informative second participant.
