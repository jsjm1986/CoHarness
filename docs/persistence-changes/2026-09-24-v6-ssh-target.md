---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-v6-ssh-target

English | [中文](2026-09-24-v6-ssh-target.zh.md)

## Summary

Advances Session storage to V6 so JSONL can read the optional sshTarget header binding that the V5 writer emitted, and acknowledges the optional header field as durable Session metadata.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-v6-ssh-target
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-22-v5-execution"
    after: "9136dd6271b5aba11b4748a03cb05bdb0cc9b05f17be5af3d87a86406177033c"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-09-22-v5-execution"
    after: "4e26a4a482d42df86166259d181b53f33e1a52e735968253d79d9a743aa0b9fa"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

V5 readers reject a physical header carrying sshTarget because their JsonlHeaderLine whitelist does not name the key, so the wire change requires a format version bump. The V5-to-V6 adjacent migration accepts every V5 header, preserves sshTarget when present, and republishes the artifact at version 6 without altering event rows, sequence values, inherited cuts, or payloads.

<a id="verification"></a>
## Verification

packages/session/session-format-v5-to-v6/tests/migration.spec.ts covers V5 headers with and without sshTarget, invalid sshTarget values, unknown header keys, and byte-identical event preservation; the JSONL admission, migration, and publication specs exercise the installed V6 catalog against stored V0 through V5 generations.

<a id="dev-note"></a>
## Dev Note

None.
