---
kind: upgrade-guide
description: "Process and terminal allocation refuse resource providers withdrawn or replaced during admission."
---

# Retry process allocation after resource provider replacement

English | [中文](guide.zh.md)

## Change

`ctx.subprocess.spawn()` and `spawnTerminal()` retain the resource provider that admitted their request. If that provider is withdrawn or replaced before physical start dispatch, including SSH preparation and stream connection waits, the operation rejects with `ResourceAdmissionError` reason `unavailable` and returns any unused permit to the original provider. An independent request also rejects if managed admission appears before allocation. Previously, these requests could start a child using stale admission or no permit.

This affects applications that replace `resourceBudget` or its required-provider flag during pending allocation. Existing children retain their cleanup obligations. Provider signatures, configuration and stored data do not change.

The local provider returns unused capacity when ordinary argument/grace validation, terminal empty-program validation or target environment validation rejects before launch. Null bytes in program names, arguments, directories and environment entries retain their `ERR_INVALID_ARG_VALUE` error. A later valid request can use that slot; failures with unconfirmed physical cleanup remain uncertain.

## Migration

1. Deploy matching `@deepseek-ai/dsh-subprocess`, `@deepseek-ai/dsh-subprocess-local` and `@deepseek-ai/dsh-subprocess-ssh` artifacts with the Runtime payload. Keep the [managed resource startup procedure](../managed-resource-admission/guide.md).
2. Await both allocation APIs. After an `unavailable` rejection, restore resource admission and make a new allocation request; do not transfer an old permit to another provider.
3. Asynchronous providers capture `captureAdmissionCheck(spec)` at entry and invoke it before start dispatch. After confirmed rollback, use `rejectAfterCleanup(failure)` to release admission and preserve the original failure; otherwise retain uncertain accounting.
4. Confirm replacement during a queued request launches no child, returns its original grant and allows a fresh request through the replacement provider. See the [subprocess reference](../../../../packages/subprocess/subprocess/README.md).
