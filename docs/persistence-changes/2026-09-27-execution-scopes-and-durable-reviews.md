---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-execution-scopes-and-durable-reviews

English | [中文](2026-09-27-execution-scopes-and-durable-reviews.zh.md)

## Summary

Adds required execution-protocol and continuation events, optional immutable execution-scope references, and optional durable workspace-review metadata. These event-body additions preserve the current Session writer format 6; no released header, envelope or adjacent migration is changed.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-execution-scopes-and-durable-reviews
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-22-v5-execution"
    after: "70704a22165788bd25d97d562d81a1a3d7024ed480cbff8b18213e841498a90c"
    decision: same-version
  - root: "event:gateway/continuation"
    previous: null
    after: "81a6fccc775c0a082791a4fa3bb916b6355c8877c0ca6e1780e5cf01366b0cd3"
    decision: same-version
  - root: "event:gateway/execution"
    previous: "2026-09-22-v5-execution"
    after: "820864922123bf28895e9074ada5d705c65ce0cff058b3807e1b2a5fa3686d70"
    decision: same-version
  - root: "event:gateway/scoped-execution"
    previous: null
    after: "8086a722e54f2867cebf78c887cdef6c9ed7438313a0a133f6d2f3ce72d99944"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-22-v5-execution"
    after: "93c2f2271ce39bcff1b212d260bf60c93e7a51bc3ef67291e1d38b3b8fffb1ef"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-09-22-v5-execution"
    after: "6d67dec8de1c5e780271e492d420741ae1d4533b510ad7cb897982b596dfd439"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-22-v5-execution"
    after: "8c5b6f098f2c2a70d17f3c08212d184408c29a9ca5c5e2ddb14a5832dd4d3cd4"
    decision: same-version
  - root: "event:workspace/changes"
    previous: "2026-09-23-deliverables-events"
    after: "1c062d75afe0e9ae846b18a1d2f5bd1bdb81bb2714bc8d83f74ef0df8f72d474"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Old records may omit scopeId and review metadata. The current execution provider retains legacy input verification and never fabricates a missing delegation or grants Auto from another request. Every modern scope first records the required gateway/scoped-execution protocol marker; durable asynchronous continuations use the required gateway/continuation event. A reader using the #232 event vocabulary rejects these unknown required events, so it cannot silently interpret a narrowed scope as cumulative authority. Current projection also rejects a scopeId without the marker. Optional scope references propagate through queued inputs, title requests and Team messages without changing their existing fields. Workspace summaries retain their existing file and count fields; reviewId locates committed historical content, incomplete records storage failure, and requiredReviewBytes supports bounded recovery. These fields do not replace model-visible messages or claim rollback of file effects. Missing review metadata retains historical summary behavior; durable review reads and storage-failure recovery require the updated workspace-changes provider. Same-version admission is not a promise that older products implement the added behavior or support downgrade.

<a id="verification"></a>
## Verification

node_modules/.bin/vitest run packages/context/gateway-execution/tests/reader-admission.spec.ts packages/context/gateway-execution/tests/projection.spec.ts packages/deliverables/workspace-changes/tests/durable-review.spec.ts packages/deliverables/workspace-changes/tests/review-store.spec.ts passed all 23 tests. The [reader tests](../../packages/context/gateway-execution/tests/reader-admission.spec.ts) use the #232 known-event list and its unchanged released v5 and v6 readers: the old reader accepts a bare optional scopeId, refuses the new required marker and continuation, and the current reader accepts the complete records. [Review tests](../../packages/deliverables/workspace-changes/tests/durable-review.spec.ts) cover restart reads and storage-failure admission. These are local candidate results; they do not assert deployment or release acceptance.

<a id="dev-note"></a>
## Dev Note

None.
