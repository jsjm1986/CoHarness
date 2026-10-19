---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-job-events

English | [中文](2026-10-19-job-events.zh.md)

## Summary

Adds the log-only `job/registered` and `job/settled` event roots for the jobs subsystem: producers register durable job identity and settle terminal outcomes through the job registry, which writes both records into the Session log.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-job-events
baseline: false
changes:
  - root: "event:job/registered"
    previous: null
    after: "f5520c1d261ca86ea03735799c311a0a9ede8babb588cf0a65422576d2ee0ad1"
    decision: same-version
  - root: "event:job/settled"
    previous: null
    after: "edd37b1e4974af648633014435572089b1e8fb71910468a0767a7e28fdd22abf"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both roots are new; existing records are unchanged. The events are additive SessionEventMap members written only by the job registry, so released logs never carry them and no Session format bump is required.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/test-support/session-snapshot/tests/suite.spec.ts: replayed Sessions keep the registered and settled job records byte-stable.

<a id="dev-note"></a>
## Dev Note

None.
