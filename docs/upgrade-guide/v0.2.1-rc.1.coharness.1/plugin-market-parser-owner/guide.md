---
kind: upgrade-guide
description: "Plugin market parsing refuses resource providers changed while process admission waits."
---

# Retry market searches after resource provider replacement

English | [中文](guide.zh.md)

## Change

The plugin market retains its parser's resource provider before process admission. Withdrawal or replacement during that wait rejects with `plugin-market/fetch-failed`, caused by `ResourceAdmissionError` reason `unavailable`. The unused permit returns to the original provider before any body transfer or Worker creation. Previously, the parser could start with a stale grant and cache the resulting index.

Running parsers retain their existing termination and accounting obligations. Configuration, index formats and successful market results remain compatible.

## Migration

1. Deploy matching `@deepseek-ai/dsh-plugin-market` `lib/index.js` and `lib/worker.cjs` artifacts. Keep the [managed resource startup procedure](../managed-resource-admission/guide.md).
2. After a refused search, restore admission and issue a fresh search. Do not transfer the old grant to a replacement provider.
3. Confirm replacement during admission starts no parser thread and a fresh search succeeds. See the [market reference](../../../../packages/boot/plugin-market/README.md).
