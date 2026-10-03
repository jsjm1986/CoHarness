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
    after: "9a986adc7ddd7022a990c0e8bea148be9adee877e7185e1a128b6fc9b248e3c7"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-v7-tool-result"
    after: "31b3741c54811477977e2764c8fc19cb12bcd5205a926b7a95426e9c0c71b4de"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-v7-tool-result"
    after: "f642567464886e372fac8bfbeadae9c3a3271a007f9ccc586eca4eb060bed10c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-v7-tool-result"
    after: "ac021627b9df3cf0141fef60757efdde2688128309681fbad725f387bd8e9dfb"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Each change adds one optional property to a reference element. Writers may emit the field, readers must accept its absence, and no existing payload alters meaning, so the Session format version stays unchanged.

<a id="verification"></a>

<a id="verification"></a>
## Verification

The four event schemas carry the optional field in both the current inventory and this record's after snapshot; packages/context/session-reference populates it when the captured snapshot's format version is known, and its spec covers seeded and unseeded captures.

<a id="dev-note"></a>

<a id="dev-note"></a>
## Dev Note

None.
