---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-11-team-member-model

English | [中文](2026-10-11-team-member-model.zh.md)

## Summary

Acknowledges `team/member`'s `data.member` gaining an optional `model`: activation persists the member's resolved request route so inactive roster rows keep their member-specific label after the Agent is disposed.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-11-team-member-model
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-18-coharness"
    after: "61e2ba55405ca7ede6bb6bc4c47af5348fefd1b8c5f0ab20e0a4b7d5f22bc447"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Same-version: `model` is optional in both directions. Members activated before the field existed, and members still provisioning, omit it; readers fold those snapshots unchanged.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence-changes` classifies the diff as `optional property added (same-version allowed)`; the Agent Team spec covers activation persistence, inactive-row display, and pre-field snapshots.

<a id="dev-note"></a>
## Dev Note

None.
