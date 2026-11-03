---
kind: upgrade-guide
description: "Native translations refuse a selected owner changed during resource or credential waits."
---

# Retain native translation eligibility through admission

English | [中文](guide.zh.md)

## Change

An uncached native translation rejects with `TRANSLATION_UNAVAILABLE` if its native owner, model configuration, Official credential reference or eligibility changes while awaiting resources or provider preparation. It sends no request under the rejected selection, returns quiescent resource permits and retains the already logged request without a result. Cached successful translations remain reusable. Native translations report purpose `translation` instead of the default `assistant`; custom purpose validators and usage reports must accept this value.

## Migration

Rebuild the LLM service, native API extensions, translator and SDK subagent provider together. Update custom purpose validators and confirm native translation usage records contain `translation`. Prepared stream consumers can supply the optional process-local `PreparedLlmCallGuard` through `stream(options, guard)`. Keep its callbacks outside model input; asynchronous eligibility and synchronous final ownership checks have separate timing requirements. No Session generation or database migration is required. Retry translation after the selected native route is available.
