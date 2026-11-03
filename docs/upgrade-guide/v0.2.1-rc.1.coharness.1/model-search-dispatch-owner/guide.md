---
kind: upgrade-guide
description: "Independent model search checks resource and policy ownership after asynchronous credentials and before HTTP."
---

# Retry independent model search after ownership changes

English | [中文](guide.zh.md)

## Change

Independent Messages and Sonar searches retain their resource provider across model admission and credential resolution. Withdrawal, replacement, newly installed admission or a newly required model policy refuses stale HTTP with `WEB_PROVIDER_ERROR`. Any unused grant returns to its original provider. Previously, queued or credential-waiting searches could still dispatch after these changes.

Successful results, Session request fields, per-user authorization and configured model defaults remain compatible. Required policy absence continues to deny default governed routes.

## Migration

1. Deploy matching `@deepseek-ai/dsh-web`, `@deepseek-ai/dsh-web-search-deepseek` and `@deepseek-ai/dsh-web-search-perplexity` artifacts.
2. Custom `ModelSearchImplementation.independent` implementations receive an ownership check as their fourth argument. Invoke it after asynchronous preparation, immediately before HTTP and around caller-owned recording callbacks.
3. Restore authorization or admission and create a fresh search after refusal; do not transfer the old grant. See the [Web reference](../../../../packages/web/web/README.md).
