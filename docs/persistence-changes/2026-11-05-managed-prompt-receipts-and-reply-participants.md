---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-05-managed-prompt-receipts-and-reply-participants

English | [中文](2026-11-05-managed-prompt-receipts-and-reply-participants.zh.md)

## Summary

Records optional durable admission digests on Host-submitted inputs and authenticated participant attribution on continued user-question replies.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-managed-prompt-receipts-and-reply-participants
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-26-optional-document-identity"
    after: "fd4bf2fe1c0a983948fbd7bce58ed68db3109dfa9ec5d7212c3ebdda2fbed7c1"
    decision: same-version
  - root: "event:auto-review/request"
    previous: "2026-10-26-optional-document-identity"
    after: "62f160ea12a92d75e9013efb75f15489851ebe70d186acf95b067b26356b27c4"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-request"
    previous: "2026-10-26-optional-document-identity"
    after: "1158a4a17d3196e3269140507d8bf238a3a963ec8fdd91beb9313dbb858a5e71"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-26-optional-document-identity"
    after: "63e462325bdc12edb05a83f056772b94a35c45fa053b1ec1dfd877ad321ccf12"
    decision: same-version
  - root: "event:memory/curation-request"
    previous: "2026-10-26-optional-document-identity"
    after: "c454a447df270a2300cd87fd87cf2a63cb2e572b0c959a45b95cbe76cc5fdfa3"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: "2026-10-26-optional-document-identity"
    after: "bee19ec1298c5710078bf11d6db83dd7c5bce95f550d630173212319b2c27e97"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-26-optional-document-identity"
    after: "9df385243c17515c9ddeef9086ffc3472f91755e9ce78358718793c1d751f671"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-26-optional-document-identity"
    after: "e98aeb2e42895e6a60e3c7677da4e25fc0b95006c33af095dac396e26a76198d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

An ordinary input may omit admission, and an existing question reply may omit participant. The operation and payload digests let the owning Host confirm an already persisted input. Project membership and actor checks still apply on each request. Reply attribution identifies the participant when recorded. Neither addition changes message content, event order, the Session header or a committed generation.

<a id="verification"></a>
## Verification

The installed R49 and R50 CoHarness JSONL readers restored v7 artifacts containing the original source, a source with admission digests, and a question reply with participant metadata. Both the inbox splice and user message retained the recorded source and text. Real Host admission and retry checks returned one durable input after a lost response.

<a id="dev-note"></a>
## Dev Note

None.
