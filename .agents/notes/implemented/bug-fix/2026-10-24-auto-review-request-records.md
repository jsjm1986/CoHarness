# Agent Note: Durable Auto review request inputs

Status: implemented

English | [中文](2026-10-24-auto-review-request-records.zh.md)

## Problem

Auto review sends policy, working directory, retained instructions and binding-time tool descriptions to a model. The Session recorded the pending call and any denial, but omitted the complete resolved reviewer input.

## Decision

Each reviewer prepares one LLM call, freezes its resolved configuration and complete input, then appends required log-only `auto-review/request` with the pending call id before dispatch. Dispatch retains the prepared adapter and explicitly requests execution admission with the Session and existing verified billing witness. Cancellation before publication prevents the request; preparation, persistence and admission failures retain the existing failed-review outcome without executing the tool.

The event stays outside the primary conversation. It includes policy, resolved working directory, retained history and pending native or PTC action text. Risk, reviewer reasoning and raw response remain unrecorded; the existing structured denial retains its optional reason. This replaces only request omission and transient-schema retention in [the Auto feature decision](../feature/2026-08-28-auto-review.md).

## Alternatives considered

**Reconstruct from current code and registrations.** Policy, configuration, working directory and bindings can change after dispatch. Current values cannot establish the prior input.

**Append reviewer inputs to the main conversation.** The primary model does not consume them. A log-only event preserves input without changing its surface.

## Consequences

Repeated retained history increases Session storage. Format version 7 remains unchanged; builds unaware of this required event refuse affected logs. Committed generations are preserved without conversion or downgrade support. Start and settle events retain their fields.

## Verification

Negative controls prove the original request has no preceding record and omits explicit admission intent. Real LLM unit cases compare complete recorded and dispatched input and confirm permit release. SDK acceptance runs the shipped reviewer and tool executor, writes an owned file, projects the request and completed permits, then resumes the persisted Session in a new runtime. Source, built and Python fixtures share a deterministic model and controlled admission provider; they do not establish paid-provider behavior.
