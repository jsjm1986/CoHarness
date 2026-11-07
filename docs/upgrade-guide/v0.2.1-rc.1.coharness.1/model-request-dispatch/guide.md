---
kind: upgrade-guide
description: "Model adapters must preserve runtime authorization after asynchronous provider preparation."
---

# Preserve model authorization until request dispatch

English | [中文](guide.zh.md)

## Change

`LlmAdapter.stream()` and `PreparedAdapterCall.stream()` receive an optional `dispatchRequest` callback. Runtime calls supply it to recheck retained authorization after asynchronous credentials, attachments and request extensions. DeepSeek and pi-ai implement these checks; a request revoked while preparing fails before provider dispatch. Direct adapter execution without the callback retains its independent behavior.

## Migration

1. Update external adapters and prepared-call wrappers to accept and forward the second argument. Wrap each provider request with it after asynchronous preparation; repeat the check on provider retries.
2. Preserve a callback refusal as its original structured failure. Do not translate it into transport recovery, image fallback or successful completion.
3. Verify a credential-resolution barrier: revoke access before returning the credential, then confirm the adapter sends no provider request and releases its resource permit.
