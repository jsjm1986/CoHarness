---
description: "Producer-source and tool-role migration from Session V6 to V7 with native V7 framing"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v6-to-v7

English | [中文](README.zh.md)

## Summary

The adjacent V6 → V7 Session migration and the released V7 codec. V7 rewrites producer-source declarations and lifts tool results onto first-class tool messages in place. Every event coordinate carries over: `seq`, `surfaceOp`, and `sourceEventSeqs` keep their values and no event is inserted, removed, or renumbered.

## Table of Contents

- [Use this package](#use-this-package)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The generated first-party Session format catalog imports this edge through `dsh.sessionFormatMigration` metadata. Persistence providers read V6 through the released V6 codec and reconstruct V7 in memory for reads; an explicit write open publishes a separate V7 generation. Existing V6 generation bytes, inode, and modification time remain unchanged; their presence never permits fallback from a broken V7 generation.

V6 `kind: 'plugin'` message sources are rewritten to the namespaced `plugin:<name>` form using the producer's plugin identity; sources already carrying a qualified kind keep their value. Tool-result blocks nested inside assistant messages move to their own `tool`-role messages, and opaque producer events whose type no V6 writer could emit are admitted under a `plugin:` namespace instead of failing admission.

<a id="implementation"></a>
## Implementation

The migration forwards each V6 event through source rewriting, tool-result lifting, and content migration, then validates the result under the V7 delivery rules: header fields, message sources, developer data, system-message fields, lifecycle relationships, fork results, and retired-syntax rejection. A header-only migration changes only `version`; whole-artifact validation applies the V7 event rules after conversion.

No runtime invariant companion is published: this pure library has no registrations or independently mutable state to compare. Its codec and migration behavior is exercised by direct conversion tests and the JSONL provider's immutable-generation tests.

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

Existing event content is preserved, including every recorded model input and output. `tool/result` payloads keep their content; only their message placement changes.

#### Token effect

None. The migration rewrites source declarations and message placement without summarizing or dropping event payloads.

#### KV Cache effect

The migration preserves historical request content and does not change prompt prefixes.

## Known Limitations and Deferred Work

- V7 is a CoHarness format successor. Upstream V4 builds cannot consume it.
- This package does not publish files, repair old generations, or guess producer identities for V6 sources that carry no plugin name.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
