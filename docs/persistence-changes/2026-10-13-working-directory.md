---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-13-working-directory

English | [中文](2026-10-13-working-directory.zh.md)

## Summary

Adds durable per-Session working-directory changes and their notice attribution.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-13-working-directory
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-02-user-question-reply-source"
    after: "d3d3ece359c924faaaa00445c170550729b09b83517903dd33991a04d3e5ebdd"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-02-user-question-reply-source"
    after: "9c8372b22163d4db606bc76654a01fff0583456f25ec761ee03cec458fd43913"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-02-user-question-reply-source"
    after: "ef6c23a2eaefc0e77b0b298a4a4a64453ffb3bda4ed0d452836caad37e9a8633"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-02-user-question-reply-source"
    after: "1ff5d27bf6fa121a02328d9748bafc6a7cfa44f30dd336062ea6468a368a8751"
    decision: same-version
  - root: "event:working-directory/change"
    previous: null
    after: "124aa62078ca3311353b39cc3bf6c75da281338be6bbf672f8b361d828cddca3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session headers and events remain valid. The new event is required on read: older builds that do not know working-directory/change refuse logs containing it. The additive working-directory source kind is attribution only; the declared source policy preserves unknown attribution without interpreting it. The event vocabulary grows without changing the structural Session format.

<a id="verification"></a>
## Verification

The working-directory and system-prompt suites cover durable changes, recovery, user-context notices, admission refresh, and suppressed-context retention; keyless headless replay verifies the model-visible context line.

<a id="dev-note"></a>
## Dev Note

None.
