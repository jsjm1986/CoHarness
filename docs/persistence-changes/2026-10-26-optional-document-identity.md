---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-26-optional-document-identity

English | [中文](2026-10-26-optional-document-identity.zh.md)

## Summary

Adds optional document-incarnation metadata to UserDocRef values retained by nine existing Session event roots.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-26-optional-document-identity
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-19-fixture-message-source"
    after: "dcedf7a96cc3d58d0a3001dce539a3835d06c9086d866a063b0b6d7ba85ec7c1"
    decision: same-version
  - root: "event:auto-review/request"
    previous: "2026-10-25-codex-native-model-input"
    after: "9f2b11ddeb29ba848535a33a54ec572eca60d65538d41a1862c8344886e443c4"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-request"
    previous: "2026-10-25-codex-native-model-input"
    after: "af6ee918571c78d55fd34900128dbf535ed254b7bfb61a36695f14814b83d0d0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-19-fixture-message-source"
    after: "4bd538afe289a64b354a9c678e61e5249ff1ab7f8c91cc949fb450eb2c1f2207"
    decision: same-version
  - root: "event:memory/curation-request"
    previous: "2026-10-25-codex-native-model-input"
    after: "bc58adc1207058cdc18c3155dd57173917ba7b97ca00791117f20a57af9f545b"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: "2026-10-25-codex-native-model-input"
    after: "0f63e4e5f609d6318d1797ad0af2493c4ae3265f8833263005037d14fa80c070"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-19-fixture-message-source"
    after: "a4036ca87bc3831360c19754075a79702874caa46e76ec42d48ad99defe854c2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-19-fixture-message-source"
    after: "bdfeb66094a5f96e7157fe586dc9c416f7633d313e47156d32913df0876acb2d"
    decision: same-version
  - root: "event:userdoc/attached"
    previous: "2026-09-18-coharness"
    after: "7578271fabb3d5d4bcae41075cf1a5a901c4fe4f6e517c9c01caf971b4cb41de"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The identity property is optional. Existing document references omit it and remain valid; new references may retain incarnation id, revision, publication actor and origin as JSON metadata. The field does not replace document paths, frozen prompt representations, or current access checks, and it grants no authorization. Readers that do not inspect identity retain the existing document rendering. No required field, event name or SessionHeader.version changes, so this optional addition uses the existing format version and requires no generation rewrite.

<a id="verification"></a>
## Verification

The focused document-context and storage-contract check passed 27 tests. Both omitted and present identity metadata survive JSON serialization and Session replay, and produce the same frozen model text. See [the executed check](../../.agents/audits/receipts/document-optional-identity-persistence-compatibility.json). This evidence concerns metadata compatibility, not cross-account document authority.

<a id="dev-note"></a>
## Dev Note

None.
