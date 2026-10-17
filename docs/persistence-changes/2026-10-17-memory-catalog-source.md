---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-17-memory-catalog-source

English | [中文](2026-10-17-memory-catalog-source.zh.md)

## Summary

Acknowledges the `memory-catalog` message source kind on the user/developer message `source` unions in agent/inbox/spliced inserted rows, developer/message, session/title-llm-request, and user/message: dsh-memory-context stamps it on the durable saved-memory catalog it publishes into a session's visible history.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-17-memory-catalog-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-working-directory"
    after: "f366c1c849a0c13f00be016f35b77765a56876ec79d9da91afbd900ba0f4e00b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-working-directory"
    after: "7e65d362e391b74fac891650ef83a8617e34bc4eab2081af6cfdc1e1f4b0d1af"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-working-directory"
    after: "662cecc47bae19290333afe2dcb7a9c07b7ac61cc7390e8d13ea08c7c35cbcff"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-working-directory"
    after: "ed58c1350fc91e330ea6613286e93bbc6bbb0cd83239c6e4439c7598287c323a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The kind is declared `@persistenceAttribution`, so the recorded source policy admits it without a version bump: it names the plugin that produced an already-preserved message, adds no required field, and carries no new reader obligation. Readers that never met the producer keep the message and its unknown source kind under the preserved-unknown rule, matching every other attribution kind on the same unions.

<a id="verification"></a>
## Verification

scripts/persistence-changes.ts classifies each of the four roots as attribution-kind-added under the recorded source policy; packages/memory/memory-context specs cover the listener stamping `memory-catalog` with `form`, `update`, `entries`, and `omitted`, and the loader-composition spec replays a stored entry into a fresh session's catalog message.

<a id="dev-note"></a>
## Dev Note

None.
