---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-deliverables-events

English | [中文](2026-09-23-deliverables-events.zh.md)

## Summary

Adds explicit file-delivery declarations and per-turn workspace-change announcements.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-deliverables-events
baseline: false
changes:
  - root: "event:deliverables/presented"
    previous: null
    after: "13d3d180f977bf78081d487ffa0ecb75857349bcab29a5a3fb48189fca2a6176"
    decision: same-version
  - root: "event:workspace/changes"
    previous: null
    after: "e308ccf867a5398e316e0af8cb6ce238a8d33a63b9b384c8250a686786285f72"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New event names use the existing envelope and are required-on-read. Older logs remain readable; unaware readers must reject these events. Declarations contain paths, not preserved file contents. Change summaries are served only while their recorder lives. No existing committed generation changes.

<a id="verification"></a>
## Verification

The V5 event-admission suite passed 22 tests, including byte and inode preservation. TypeScript and Python SDK tests retain both events without adding them to assistant output. The real Web recorder and Review scenario passed with separate historical and current-file assertions.

<a id="dev-note"></a>
## Dev Note

None.
