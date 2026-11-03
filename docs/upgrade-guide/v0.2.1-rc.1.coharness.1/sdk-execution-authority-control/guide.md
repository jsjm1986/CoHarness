---
kind: upgrade-guide
description: "SDK children retain parent model authorization when execution authority is the only installed policy service."
---

# Retain parent execution authority in SDK children

English | [中文](guide.zh.md)

## Change

SDK delegation installs mandatory parent control when the initiating Agent has execution authority, including when resource admission and model-access policy are absent. Each child model request passes through the captured parent's middleware and live authorization before its adapter dispatches. Previously this combination started an independent child that skipped those checks.

## Migration

1. Rebuild the matching SDK provider and managed-child entry.
2. Supply the parent's normal LLM runtime and a CLI supporting the private bootstrap. A child that does not acknowledge it refuses startup.
3. Keep execution authority installed for managed delegation. Use the [SDK provider reference](../../../../packages/subagent/subagent-dsh-sdk/README.md) to configure its parent-control limits.
