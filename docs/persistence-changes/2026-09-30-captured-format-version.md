---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-captured-format-version

English | [中文](2026-09-30-captured-format-version.zh.md)

## Summary

Acknowledges the optional capturedFormatVersion field on session-source references in agent/inbox/spliced, developer/message, session/title-llm-request, and user/message payloads: a reference now records which Session format version its captured content came from.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-captured-format-version
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-30-v7-tool-result"
    after: "d7ce3bf7a944c4558f9f82df1eeaaa8ea9097274459d821e07369388ff9974ff"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-v7-tool-result"
    after: "5e9d96a7092c158272fdcbb3fa6008a745233576b437b82f07d00b09d8486565"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-v7-tool-result"
    after: "0239f052c960a78fbfd7e0ec8ad45c1a3737aef41ea2127d7094f7ceea544907"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-v7-tool-result"
    after: "ffb5919c0e4c8b03125807bf1aec8056562805d132c3f6df6b3b82f929d2ce5d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Each change adds one optional property to a reference element. Writers may emit the field, readers must accept its absence, and no existing payload alters meaning, so the Session format version stays unchanged.

<a id="verification"></a>
## Verification

The four event schemas carry the optional field in both the current inventory and this record's after snapshot; packages/context/session-reference populates it when the captured snapshot's format version is known, and its spec covers seeded and unseeded captures.

<a id="dev-note"></a>
## Dev Note

None.
