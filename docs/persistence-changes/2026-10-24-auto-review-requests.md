---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-24-auto-review-requests

English | [中文](2026-10-24-auto-review-requests.zh.md)

## Summary

Retains the complete resolved auxiliary authorization-review request before execution admission and model dispatch.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-auto-review-requests
baseline: false
changes:
  - root: "event:auto-review/request"
    previous: null
    after: "a8bb4103bb591122b893b2a6a14ac589c8fd2321a1b46f1ee17fad0efdaa4fc8"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Adds required log-only auto-review/request at Session format version7 without structural changes. Existing logs remain readable. Earlier builds that do not know the event refuse affected logs; current writers do not mark it ignorable. Committed Session generations are preserved without conversion or downgrade support.

<a id="verification"></a>
## Verification

52 related unit cases pass at100percent changed-module coverage. A real source and built TypeScript SDK composition plus the Python SDK project the exact request, execute an owned file write, verify three completed model permits and resume the persisted Session in a fresh runtime. The adapter and admission provider are deterministic fixtures; paid provider behavior is not covered.

<a id="dev-note"></a>
## Dev Note

None.
