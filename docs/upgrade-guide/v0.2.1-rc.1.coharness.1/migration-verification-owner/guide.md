---
kind: upgrade-guide
description: "Historical Session writes refuse resource providers changed while verification waits."
---

# Retry migration publication after resource provider replacement

English | [中文](guide.zh.md)

## Change

The JSONL persistence verifier retains its resource provider before local and node admission waits. Withdrawal, replacement or newly installed admission before Worker creation rejects the historical write open with `ResourceAdmissionError` reason `unavailable` and returns any unused permit to the original provider. Previously, pending verification could adopt a replacement provider or start with a stale permit.

Committed historical generations remain intact and a rejected verification publishes no successor. Already running threads retain their existing cleanup and accounting. Configuration, Session data formats and successful reads remain compatible.

## Migration

1. Deploy matching `@deepseek-ai/dsh-session-persistence-jsonl` `lib/index.js` and `lib/worker.cjs` artifacts. Keep the [managed resource startup procedure](../managed-resource-admission/guide.md).
2. Await historical write opens. After `unavailable`, restore admission and issue a fresh open; do not transfer an old grant to another provider.
3. Confirm a queued request starts no thread after provider replacement and a fresh request succeeds without changing historical source bytes. See the [JSONL reference](../../../../packages/session/session-persistence-jsonl/README.md).
