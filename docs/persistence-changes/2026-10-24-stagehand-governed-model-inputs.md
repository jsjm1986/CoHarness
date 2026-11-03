---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-24-stagehand-governed-model-inputs

English | [中文](2026-10-24-stagehand-governed-model-inputs.zh.md)

## Summary

Records the exact host-routed model input of each Stagehand browser inference before dispatch.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-stagehand-governed-model-inputs
baseline: false
changes:
  - root: "event:browser-use/stagehand-llm-request"
    previous: null
    after: "25c645080c2da89aa1c6f386d7348d315e4c35c76883399268bd5e227495e33e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Adds the required log-only browser-use/stagehand-llm-request event without changing the Session structure or version. Existing logs remain valid. Older builds that do not know the event refuse affected logs rather than omitting model-visible inputs. Browser state is not restored by this record.

<a id="verification"></a>
## Verification

Browser provider tests pass 146 cases with 100% statements, branches, functions and lines in five affected sources. Source and built headless and TypeScript SDK scenarios, Python SDK projection, three installed Chromium cases and model-governance billing/queued-denial cases pass.

<a id="dev-note"></a>
## Dev Note

None.
