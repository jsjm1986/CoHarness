---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-17-memory-recall-source

English | [中文](2026-10-17-memory-recall-source.zh.md)

## Summary

Acknowledges the `memory-recall` message source kind on the user/developer message `source` unions in agent/inbox/spliced inserted rows, developer/message, session/title-llm-request, and user/message: dsh-memory-context stamps it on the per-question recall injection it publishes into a session's visible history.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-memory-recall-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-17-memory-catalog-source"
    after: "69090a7657308107dd797d55e8da7ae71ed41b10628ecc4a3dec2a0304df25a2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-memory-catalog-source"
    after: "43d9952c3e9bf925d8146d1306e574fee890724a880c6cf632bda242676b0753"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-memory-catalog-source"
    after: "3c685dc08e3d30cb3ae9501b9eac2b7bbeb66526ad24801b76dcaa2bdb39b310"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-memory-catalog-source"
    after: "946d3ecb0c0b85d1f64e22bac7a2d89dcf24e6dba7aae9a95adcdb1defb6386c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The kind is declared `@persistenceAttribution`, so the recorded source policy admits it without a version bump: it names the producer of an already-preserved message, adds no required field, and carries no new reader obligation. Readers that never met the producer keep the message and its unknown source kind under the preserved-unknown rule, matching every other attribution kind on the same unions.

<a id="verification"></a>
## Verification

scripts/persistence-changes.ts classifies each of the four roots as attribution-kind-added under the recorded source policy; packages/memory/memory-context specs cover the selector stamping `memory-recall` with `form` and `keys`, the durable-key fold, and the per-session byte budget.

<a id="dev-note"></a>
## Dev Note

None.
