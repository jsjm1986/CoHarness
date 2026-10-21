---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-fixture-message-source

English | [中文](2026-10-19-fixture-message-source.zh.md)

## Summary

Adds a fixture variant to the source union on user, developer, and inbox-inserted messages and to the messages array of session/title-llm-request, for the browser fixture session mode.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-fixture-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-17-memory-recall-source"
    after: "ca3082f98a92e7e28c5b50718c8e17285bf020e33c63c8489a4eac05ca7d6fc2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-17-memory-recall-source"
    after: "be178e721e3554ed94b1988b892f45a66d575d339518f0aa3d5ee3a8e80584ff"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-18-title-reasoning-effort"
    after: "1ade73d8d275f25066d9b0ecd5d97563757021a0ab32cb20a436ef2b5a4aca8f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-17-memory-recall-source"
    after: "081d62847eea7c2011b66be579949cd4fda0a6be75f3f566fc52c69ffc9e9e71"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records are unchanged; the variant is additive on a merge-extensible union. Fixture-sourced events are produced only by the client fixture mode and are not emitted through durable host writers, so released logs never carry them.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/test-support/session-snapshot/tests/suite.spec.ts: 152 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
