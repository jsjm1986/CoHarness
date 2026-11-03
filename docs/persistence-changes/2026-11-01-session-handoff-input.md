---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-session-handoff-input

English | [中文](2026-11-01-session-handoff-input.zh.md)

## Summary

Records each auxiliary handoff model input before dispatch in the calling Session.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-session-handoff-input
baseline: false
changes:
  - root: "event:session/handoff-llm-request"
    previous: null
    after: "e158e789d5f24a4b55c6de22ff22778917df7635ab0d4235ad87d19b282565f5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Adds the required session/handoff-llm-request event with source Session, requested route and complete input messages. Existing events remain valid. Older builds that do not know this event refuse affected logs under the existing unknown-required-event rule. No Session header or structural format change is introduced; committed generations are not rewritten.

<a id="verification"></a>
## Verification

The query-tool and real SQLite suites pass 156 tests, including all four replacement-token patterns and request logging failure. Actual source and built Node 22 TypeScript SDK compositions and the Python SDK each pass seven handoff cases, verifying literal input before physical dispatch and readback through the real persistence provider. A private complete original tool package fails all seven source cases because the request record is absent. A complete package with recording already present fails the literal-text case in source and built modes.

<a id="dev-note"></a>
## Dev Note

None.
