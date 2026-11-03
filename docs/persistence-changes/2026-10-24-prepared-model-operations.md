---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-24-prepared-model-operations

English | [中文](2026-10-24-prepared-model-operations.zh.md)

## Summary

Records native model operations in auxiliary inputs and the exact Sonar search request.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-prepared-model-operations
baseline: false
changes:
  - root: "event:auto-review/request"
    previous: "2026-10-24-auto-review-requests"
    after: "058810a9e5b06610cce18c0c41af56dbdf69b5f585fbae3f963ed43e71d497bf"
    decision: same-version
  - root: "event:browser-use/stagehand-llm-request"
    previous: "2026-10-24-stagehand-governed-model-inputs"
    after: "151fa0af6e87fabaa7e497fa6869f1821cf39ac50d3d0e500e6f1972a16259d0"
    decision: same-version
  - root: "event:memory/curation-request"
    previous: "2026-10-24-memory-auxiliary-requests"
    after: "3d9e1a1b04cd5fb5b031baa76257e76f5d4cba9d5f990acf695cc1f2c9324838"
    decision: same-version
  - root: "event:memory/recall-request"
    previous: "2026-10-24-memory-auxiliary-requests"
    after: "77b9228dffa9bf96867e702734391cdf528878e007b48253ca44c0d0c0dc709b"
    decision: same-version
  - root: "event:web/perplexity-search-llm-request"
    previous: null
    after: "0951068900ea2532daa58a0018ae60e013977ea692b9553e9f8b232527b49d03"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Optional operation descriptors extend Auto review, Stagehand and memory request payloads at Session format version7. The required web/perplexity-search-llm-request event records the exact Sonar endpoint and JSON body; readers that do not understand it refuse the log. Existing records remain valid. No structural generation conversion, committed JSONL rewrite or downgrade support is introduced.

<a id="verification"></a>
## Verification

219 focused native transport, admission, captured-generation and actual governance cases pass with100percent statements, branches, functions and lines across the changed modules. Source and built TypeScript SDK flows and the Python SDK run both Messages and Sonar through the real web tool, verify physically persisted input before owned loopback HTTP and resume in a fresh process. A separate actual built governance composition verifies one admitted request, one released model permit, file/personal usage and a denied follow-up without HTTP. The full build passes all8 stages. These fixtures do not establish paid external-provider behavior or full Gateway node-budget and PostgreSQL accounting.

<a id="dev-note"></a>
## Dev Note

None.
