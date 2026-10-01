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
    previous: "2026-09-22-v5-execution"
    after: "ce6ac250fccac765e878218fef76a86b8f882facf73f79404808e731dced4312"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-21-v4"
    after: "8e551c3f10065b20d3e5cb6bfde0589863be64be79f5200e7863128bcb69c270"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-21-v4"
    after: "f12eaba818724effce06f9bdb2f588571fd5635c1878a4cb27de8eb9fce49906"
    decision: version-bump
  - root: "event:compaction/summary"
    previous: "2026-09-21-v4"
    after: "f8fa8c5a6a47b23509f46b6ff6441ae7a66f3114b84ec2470df4a5a74d586802"
    decision: version-bump
  - root: "event:developer/message"
    previous: null
    after: "5320348194cbbdd3f0332a88ffafd298bb5653dab4a5ef8d4e45f8a19b3fa782"
    decision: version-bump
  - root: "event:request/header"
    previous: "2026-09-21-v4"
    after: "a5805fab2457f244f1124989f2d50e48544294de239092278992db8b95807f71"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-22-v5-execution"
    after: "a32c4291e11836c516954c0ab513a8a8c9aaa4142d48d46f46a9c1f4fbfcdb20"
    decision: version-bump
  - root: "event:system/message"
    previous: "2026-09-21-v4"
    after: "7458c8c4c4c8680f8e34181f26646ef2f4dfe90604b4b48f97583b35a7d6ddcc"
    decision: version-bump
  - root: "event:team/message/queued"
    previous: "2026-09-22-v5-execution"
    after: "5a0d9ac2adbc3447fedace87986312b95d62ab8566df9ee9107468adaedf945f"
    decision: version-bump
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-21-v4"
    after: "0587e446c5bcafffdb12fb5a836a8cfafa31d6f0df65cba20e8108be6acaeb3e"
    decision: version-bump
  - root: "event:tool/result"
    previous: "2026-09-21-v4"
    after: "d1468b7a9b9f41d9ea09be46ff2708e1fd33742817b5bc0ab1147f97d34e5a2f"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-09-21-v4"
    after: "0f8512903d94f57a4748fa1a2092e64342856796684e6b8343db685b192745ce"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-22-v5-execution"
    after: "7523cca26f55497c36e9eef18c37a2f096ad66e42fff2eb563285a64fea9f3f1"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

V6 readers reject every structural addition: new `source` union variants, the V7 content blocks, `developer/message`, and the extended `turn/end` reason all fail V6 admission, so the transition requires a format version bump. The V6-to-V7 adjacent migration rewrites sources and tool results in place on a one-to-one mapping: it republishes the header at version 7, preserves `seq`, `surfaceOp`, and `sourceEventSeqs` coordinates, and inserts, removes, or renumbers no event. Two optional fields accepted without their own bump ride the same transition: `request/header` `tools[].deferLoading` and `tool/result` message `isError`. Committed V6 artifacts remain immutable under the adjacent-generation rule.

<a id="verification"></a>
## Verification

packages/session/session-format-v6-to-v7 owns the codec and `assertV7RowAdmission`, which packages/session/session-persistence-jsonl/src/format.ts invokes on every V7 row; the persistence-jsonl admission, migration, and publication specs exercise the installed V7 catalog against stored V0 through V6 generations. The recorded-session corpus replayed every scenario through the V7 writer and retains each earlier generation fixture, with sdk/migration-v6 pinning adjacent V6 input; scripts/session-snapshot-corpus and session-fixture-layout verify generation naming and migration coverage.

<a id="dev-note"></a>
## Dev Note

None.
