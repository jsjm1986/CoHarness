---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-v7-tool-result

English | [中文](2026-09-30-v7-tool-result.zh.md)

## Summary

Advances Session storage to V7: message `source` becomes a producer-kind vocabulary that names plugin producers, `tool/result` lifts `role`, `isError`, and `toolCallId` onto the recorded tool message itself, the content-block union carries the V7 block set, `developer/message` joins the event map, and the header republishes at version 7.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-v7-tool-result
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-24-v6-ssh-target"
    after: "7a08afdb5a9102ded1745785ae107a70d66bfd475b8cf0c2cfcb9d3cf531ca12"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "17cca412a54e2dbbf68dab1b758475cb8a7cf49587a12baa281ad50640dd0048"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-21-v4"
    after: "153b841c3c35bc747c310e21aca6aee533814f52096f8e65e9198b72bf5a29d9"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-21-v4"
    after: "eaf72fc58fc3a3e9d7bf5727a2db76f173a7ee3be6789f83f67c4db83396afc2"
    decision: version-bump
  - root: "event:compaction/summary"
    previous: "2026-09-21-v4"
    after: "e2f9a41e0989f54ed8cee80f8db2bcf9d60a5c810dc9d45b83fa050b9dce7602"
    decision: version-bump
  - root: "event:developer/message"
    previous: null
    after: "8b13edeffcf9c5196c51828f56de435a403c0259f32fdacc7803d901e4abccb4"
    decision: version-bump
  - root: "event:request/header"
    previous: "2026-09-21-v4"
    after: "4208123b50df5006b181481ab45fcf1cde807b88d3fd4d340090bc2e202fac41"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "6be2289bd4a263141169e2312135aa301ab4a020cbefb3efd3566dbcedb64a31"
    decision: version-bump
  - root: "event:system/message"
    previous: "2026-09-21-v4"
    after: "69081694be231d56fd9580ba14645fd5e35373202605d5c5c841a9435b5fa3b1"
    decision: version-bump
  - root: "event:team/message/queued"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "f8acbb9e1eacad9eeb67db7bd1aa605911a94981fac4f66d2ce3300eb58f2341"
    decision: version-bump
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-21-v4"
    after: "100f6dca1468538239522cde3533e5bd721d0f1a7b50bea8b0eb533ea6c96163"
    decision: version-bump
  - root: "event:tool/result"
    previous: "2026-09-21-v4"
    after: "7c9f44e90a0058f4cc532ae20dad0c10afa6eba22e70a6c79fc79490bad64397"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-09-21-v4"
    after: "0f8512903d94f57a4748fa1a2092e64342856796684e6b8343db685b192745ce"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-27-execution-scopes-and-durable-reviews"
    after: "19ae9d6f5ef287ab26008d065769608401b9c6907bb2a3f7781bc7276651c804"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

V6 readers reject every structural addition: new `source` union variants, the V7 content blocks, `developer/message`, and the extended `turn/end` reason all fail V6 admission, so the transition requires a format version bump. The V6-to-V7 adjacent migration rewrites sources and tool results in place on a one-to-one mapping: it republishes the header at version 7, preserves `seq`, `surfaceOp`, and `sourceEventSeqs` coordinates, and inserts, removes, or renumbers no event. Two optional fields accepted without their own bump ride the same transition: `request/header` `tools[].deferLoading` and `tool/result` message `isError`. The transition also publishes the recorded source policy on user/developer `source` unions — the attribution-kind vocabulary, the `kind` discriminator, and the preserved-unknown rule — and the `@persistenceReserved` markers that keep retired `tool`/`system` fields closed; neither exists in the V6 record, so both ride the same bump. Committed V6 artifacts remain immutable under the adjacent-generation rule.

<a id="verification"></a>
## Verification

packages/session/session-format-v6-to-v7 owns the codec and `assertV7RowAdmission`, which packages/session/session-persistence-jsonl/src/format.ts invokes on every V7 row; the persistence-jsonl admission, migration, and publication specs exercise the installed V7 catalog against stored V0 through V6 generations. The recorded-session corpus replayed every scenario through the V7 writer and retains each earlier generation fixture, with sdk/migration-v6 pinning adjacent V6 input; scripts/session-snapshot-corpus and session-fixture-layout verify generation naming and migration coverage.

<a id="dev-note"></a>
## Dev Note

None.
