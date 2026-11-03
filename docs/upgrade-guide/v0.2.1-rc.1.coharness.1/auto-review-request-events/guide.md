---
kind: upgrade-guide
description: "Auto review logs add a required request event that older Session readers refuse."
---

# Auto review retains its exact model request

English | [中文](guide.zh.md)

## Change

Auto review appends required log-only `auto-review/request` before dispatch, including the call id, resolved model configuration and complete reviewer input: policy, working directory, retained history and pending native or PTC action text. The event stays outside the primary conversation. Reviewer reasoning and raw responses remain unrecorded; optional denial reasons retain their structured error representation.

Session format version 7 remains unchanged. Existing logs remain readable, while builds unaware of the new event refuse affected logs. Committed generations are preserved without conversion or downgrade support.

Reviewer work retains its issuing execution authority through capacity and physical model dispatch. Replacing the authority refuses the pending action even when participant fields match. An optional authority establishes managed unload behavior before any reviewed call; removing Auto returns those Sessions to Workspace write. See the [package documentation](../../../../packages/experimental/auto-review/README.md) for eligibility and independent local behavior.

## Migration

1. Upgrade Session readers and writers together before enabling Auto review on the upgraded writer.
2. Update custom event consumers to retain `auto-review/request` and accept its fields from current Session definitions. Account for reviewer prompts in Session storage and retention.
3. Custom LLM services composed with Auto review must implement `prepareCall()` and retain the prepared call through dispatch.
4. Run a supported tool in Auto mode, confirm its request event precedes dispatch, then reopen the persisted Session with the upgraded reader.
5. Custom execution-authority providers must support `runCaptured()` with the exact tool participants returned by `authorize()`. Recheck revoked qualification after queued capacity and ensure a replacement cannot dispatch the pending tool.
