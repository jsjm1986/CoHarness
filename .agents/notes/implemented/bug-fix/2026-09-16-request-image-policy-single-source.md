# Agent Note: Single source for request image policy

Status: implemented

English | [中文](2026-09-16-request-image-policy-single-source.zh.md)

## Problem

`adapter.ts` and `request-pricing.ts` each carried their own `resolveRequestImagePolicy`. The pricing copy ignored the legacy `imageDetail: 'low'` alias, so a model declaring both a numeric `imagePixelBudget` and `imageDetail: 'low'` projected requests under one budget while pricing them under another — the pricing estimate diverged from the projection's actual resolution on any model that set both knobs.

## Decision

`request-image-policy.ts` now holds the constants and the policy function; the adapter's semantics — `imageDetail: 'low'` honored as the low-detail alias — are the single authoritative implementation both call sites import. `request-pricing.ts` re-exports it for its existing consumers.

## Alternatives considered

**Converge on the pricing copy instead (numeric budget wins unconditionally).** Rejected: the adapter drives the actual request projection, so its semantics define correct behavior; pricing must match what the request really does.

**Duplicate-with-a-comment.** Rejected: the drift that produced this defect started exactly that way.

## Consequences

Adding a policy knob now has one place to land. The pricing projection honors `imageDetail: 'low'` the same way the request path does.

## Verification

`adapter.spec.ts` and `request-pricing.spec.ts` cover the shared policy through both consumers, including the combined `imagePixelBudget` + `imageDetail: 'low'` case that previously diverged.
