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
    previous: "2026-10-13-working-directory"
    after: "0d67f2faa274f1e3b3de3912cf334c2339eba8e8390b66dd8ec670da2405c09c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-working-directory"
    after: "43ff3f950db94be7464519e7a18cda3d209c2576ebd1a678162b6afc06cfe5da"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-18-title-reasoning-effort"
    after: "43c60544f929293b6138828ac02928d2714cfb0da033d0f52af7482656135a77"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-working-directory"
    after: "f045679b240795217048f4ffab30175320d9b2af1995cfb05d130b461ba1b82c"
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
