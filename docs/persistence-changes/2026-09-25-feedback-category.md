---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-25-feedback-category

English | [中文](2026-09-25-feedback-category.zh.md)

## Summary

Adds the optional `category` member to recorded message feedback so a submission can classify the author's intent alongside the rating and note.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-25-feedback-category
baseline: false
changes:
  - root: "event:feedback/message-put"
    previous: "2026-09-18-coharness"
    after: "b5086d249e8502e9ead1d39156bb8d559bde7951cac0f14ce150345b4e42a2bf"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

`event:feedback/message-put` payloads may carry the optional `category` field under the same format version. Readers that predate the member keep validating earlier payloads because the field is optional and carries no read-side obligation; writers omit it when no category was chosen. No committed generation changes.

<a id="verification"></a>
## Verification

The message-feedback suite covers persisting a category-only edit and clearing a stored category when the field is omitted, and the persistence change gate records the root transition as same-version.

<a id="dev-note"></a>
## Dev Note

None.
