---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-user-question-reply-source

English | [中文](2026-10-02-user-question-reply-source.zh.md)

## Summary

Acknowledges the `user-question-reply` message source kind on the user/developer message `source` unions in agent/inbox/spliced inserted rows, developer/message, session/title-llm-request, and user/message: dsh-user-questions stamps it on the late reply it steers back into the agent when a timed question settles.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-user-question-reply-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-30-captured-format-version"
    after: "97bcf76a5e61136e96f0013f0d1a09a0892eaab1e7797db9b58243fbcacd3cfa"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-captured-format-version"
    after: "0ea329a64267fcf5aed9961cbc1c50f75c0ac24796e678a8242fda19a2776b0e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-captured-format-version"
    after: "5995b6bc4cf7d474f141d007bf2969e2a1a15370a25c3a78110f1d5f3c867133"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-captured-format-version"
    after: "62fdd3262120f81c5cdf05e52dfc5c11d618b301c64d807e799fb8d11174cf77"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The kind is declared `@persistenceAttribution`, so the recorded source policy admits it without a version bump: it names the plugin that produced an already-preserved message, adds no required field, and carries no new reader obligation. Readers that never met the producer keep the message and its unknown source kind under the preserved-unknown rule, matching every other attribution kind on the same unions.

<a id="verification"></a>
## Verification

scripts/persistence-changes.ts classifies each of the four roots as attribution-kind-added under the recorded source policy; packages/interaction/user-questions specs cover the producer stamping `user-question-reply` with `callId` and `outcome`, and the Session projection reads the kind to close the settled question.

<a id="dev-note"></a>
## Dev Note

None.
