---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-18-title-reasoning-effort

English | [中文](2026-10-18-title-reasoning-effort.zh.md)

## Summary

Records the concrete reasoning effort selected for auxiliary session-title requests.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-18-title-reasoning-effort
baseline: false
changes:
  - root: "event:session/title-llm-request"
    previous: "2026-10-17-memory-recall-source"
    after: "a2640afd2b4af7f37c8da37671c56c4bd36c58562949b3dbee8a058059d271b0"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The new reasoningEffort field is optional. Existing V7 records remain valid and retain their original absence of a recorded effort. Prepared title requests write the resolved effort when the route exposes selectable reasoning; no Session format bump is required.

<a id="verification"></a>
## Verification

The session-title, session-title-llm, and first-prompt provider suites passed 84 tests across 10 files, covering effort selection, the recorded request payload, and older records without the field. Snapshot re-recording for session-title-after-turn is deferred and tracked separately.

<a id="dev-note"></a>
## Dev Note

None.
