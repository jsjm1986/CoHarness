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
    after: "b81c9983d178996c4f994fb4ae8b3b2eb2babd12a2f22de72477a5028e63f70c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-v7-tool-result"
    after: "30b19509806348b545945e42357c4bdf50865bf02cf49a7f4a50dd4349f668e3"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-v7-tool-result"
    after: "2e67c918285d4485db9235a00a13a92cd5796536e72442d261c8eb50f02a8c10"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-v7-tool-result"
    after: "8de225d2721d0d6ea44d6d11f46aa1b59a9b9638da88bb73c7465fbfcca5b055"
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
