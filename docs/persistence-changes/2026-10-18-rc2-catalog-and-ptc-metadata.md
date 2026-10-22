---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-18-rc2-catalog-and-ptc-metadata

English | [中文](2026-10-18-rc2-catalog-and-ptc-metadata.zh.md)

## Summary

Records payload version 2 of `subagent/catalog` for external executions and optional tool-owned JSON presentation metadata on `tool/ptc-dispatch` settlement events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-18-rc2-catalog-and-ptc-metadata
baseline: false
changes:
  - root: "event:subagent/catalog"
    previous: "2026-09-18-coharness"
    after: "53750b9abf61efb7992b0aadc3e247ec927449c63266df28230fd1139f5590ac"
    decision: same-version
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-30-v7-tool-result"
    after: "d66e11dddf5dfa3c71547e2cbd7b0608824cd8d6243fc16f532017ff28e8fba5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Catalog payload versions 0 and 1 retain their fields and meanings. Version 2 identifies an external execution, which is a discovery leaf rather than a local child Session; readers must support that payload version and reject mismatched version/mode pairs. The current V7 codec already validates these versions, so this acknowledgement adds no Session-format migration and rewrites no stored generation. PTC metadata is optional; older events without it retain their behavior. Metadata is detached from mutable tool values and remains separate from model-visible content.

<a id="verification"></a>
## Verification

`pnpm exec vitest run packages/subagent/subagent/tests/catalog.spec.ts packages/core/tools/tests/ptc.spec.ts` passed 136 tests. Coverage includes mixed catalog versions, invalid version/mode combinations, and detached PTC metadata surviving Session restoration without changing the binding result or logged-content policy.

<a id="dev-note"></a>
## Dev Note

None.
