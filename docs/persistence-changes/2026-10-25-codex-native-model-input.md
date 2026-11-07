---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-25-codex-native-model-input

English | [中文](2026-10-25-codex-native-model-input.zh.md)

## Summary

Adds the required subagent/codex-model-request audit event and the native-stream operation request variant.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-25-codex-native-model-input
baseline: false
changes:
  - root: "event:auto-review/request"
    previous: "2026-10-24-prepared-model-operations"
    after: "e82dda6502239905b3f16f6bff1befdf88299fbfae97bc21d70b347297baad35"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-request"
    previous: "2026-10-24-prepared-model-operations"
    after: "63544291e7527fddea2c7301917c56761af465066a87eedeaa84974cd747142d"
    decision: same-version
  - root: "event:memory/curation-request"
    previous: "2026-10-24-prepared-model-operations"
    after: "a7d8d0fe1542797067ca18ed0f5265132be29d72c4438c5128e98ee4aec32f84"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: "2026-10-24-prepared-model-operations"
    after: "339d49829f86b05174848c3e8208f25bf2c11b0e293906cd12fa94377c117bcf"
    decision: same-version
  - root: "event:subagent/codex-model-request"
    previous: null
    after: "60869a3ae5731975dcac7bcc65c0b33600e25389f987eff85d7ee4830a554f9c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The new event records a complete secret-free Responses input outside the parent conversation projection. Existing records remain valid. Readers that do not know this required event refuse the log. The operation union also appears in auto-review, Stagehand and memory request audit metadata; those fields do not derive conversation messages, and their existing variants are unchanged. The native Codex Consumer writes native input only through its new event. No header, envelope or committed generation changes, and no downgrade support is implied.

<a id="verification"></a>
## Verification

native-codex-sdk-source-advertised-command passes the runnable TypeScript SDK transcript and fresh-process continuation; native-codex-sdk-python-current passes the same Python projection. native-codex-private-model-lifetime passes5 actual native cases. native-codex-gateway-postgres-resumed-session passes3 real PostgreSQL actor, queued policy and execution revocation compositions.

<a id="dev-note"></a>
## Dev Note

None.
