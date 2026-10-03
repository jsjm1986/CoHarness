---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-schedule-change-title

English | [中文](2026-10-03-schedule-change-title.zh.md)

## Summary

Acknowledges `schedule/change`'s `data.schedule` gaining an optional `title`: scheduled reminder rows persist the operator-supplied title beside the existing timing and delivery fields.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-schedule-change-title
baseline: false
changes:
  - root: "event:schedule/change"
    previous: "2026-09-18-coharness"
    after: "a0a2e5c42e1c929445ecd1cd70f49be6b66441894ec72c08e8ae332821d4a3cb"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Same-version: `title` is optional in both directions. Readers keep folding rows written before `title` existed through the `Legacy*ScheduleRecord` variants, and a writer that has no title simply omits the property.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence-changes` classifies the diff as `optional property added (same-version allowed)`; the schedule fold and reminder specs cover records with and without `title`.

<a id="dev-note"></a>
## Dev Note

None.
