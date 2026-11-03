---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-24-memory-auxiliary-requests

English | [中文](2026-10-24-memory-auxiliary-requests.zh.md)

## Summary

Records the exact resolved input of each memory recall selector and each extraction or consolidation round before dispatch.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-memory-auxiliary-requests
baseline: false
changes:
  - root: "event:memory/curation-request"
    previous: null
    after: "e1c43217d6952171eed0632c369ea619ac0aeb700a0f7621f5acec9cc4c654c1"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: null
    after: "6a9be45ed50e3a6424d93fcc92c75118efd39781184a1dde7528edb766948f1f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Adds required log-only memory/recall-request and memory/curation-request events at Session format version7 without structural changes. Existing logs remain readable. Older builds that do not know these events refuse affected logs; current writers do not mark them ignorable. Memory-domain records need no conversion.

<a id="verification"></a>
## Verification

99 related unit cases pass with100percent statements, branches, functions and lines in both changed plugins. Source and built Loader regressions and real TypeScript and Python SDK projections pass. The shared deterministic adapter compares every complete durable request with dispatched input and confirms four quiescent model permits; it uses a controlled admission provider rather than a live model HTTP endpoint.

<a id="dev-note"></a>
## Dev Note

None.
