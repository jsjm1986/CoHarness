---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-v5-execution

English | [中文](2026-09-22-v5-execution.zh.md)

## Summary

Advances Session storage to V5 so JSONL can read the optional draft header that the V4 writer already emitted, and records verified Gateway execution identity in Session events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-v5-execution
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-21-v4"
    after: "becb738db5b4c2865a69cc40df806519d781feea1ab1b3d177539b5b9188ec66"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-09-21-v4"
    after: "8102d6727bb57bbea3bb78b5622996246ae4609d0bddf332ef0f2c6657493dad"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-v4"
    after: "989d6d8ca9c21c4c5c0e7bbf88ca575e4165221454524cdeb7dc824fdc6b5b0c"
    decision: version-bump
  - root: "event:gateway/execution"
    previous: null
    after: "a8e61a09f296a93e9ba18c7b01cdd85401500ac6ddba8750cf3cdd75610acf5e"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-v4"
    after: "4b7fbf29e0ae1e0d95b75903193114fce97ad18351c41a2e06bc287d86e86333"
    decision: version-bump
  - root: "event:team/message/queued"
    previous: "2026-09-21-v4"
    after: "3c172e2172241690c27e5a3fac4d6930ad8bcfe9b7060af088052c8e4332e94e"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-21-v4"
    after: "0620d01028827bca4cac6c6ae7894fd34681f70b41402e0c48ac6aaf301f2b75"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

V4 physical header validation rejects a draft field emitted by its own encoder. V5 admits that optional boolean and changes the required header version from 4 to 5. The adjacent V4-to-V5 migration preserves events, sequence numbers, inherited cuts, and the draft value while publishing only a new V5 generation on an explicit write. Existing V4 bytes remain untouched. Optional gatewayExecutionScope values may be absent in older messages; the new gateway/execution event is required for managed authorization but older V5 logs may omit it and then receive no privileged identity. V4 readers reject V5 headers, so these additions do not claim V4 forward reading.

<a id="verification"></a>
## Verification

The V4-to-V5 migration and JSONL draft/generation tests passed 101 tests across three files. Gateway execution projection and authority tests passed 41 tests across two files. Source typecheck for the affected Session, Gateway execution, Auto review, and Host packages passed.

<a id="dev-note"></a>
## Dev Note

None.
