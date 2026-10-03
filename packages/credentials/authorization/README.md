---
description: "Authorization seam (ctx.authorization): plugin-owned flows that obtain a credential through a conversation with the human"
kind: "package-reference"
---

# dsh-authorization

English | [中文](README.zh.md)

Authorization Service Definition (`ctx.authorization`). Some credentials cannot be configured, only obtained: getting one means a conversation with a human — open this page, paste that code, pick an account. This seam owns that conversation and the lifecycle around it, and never the protocol.

**A flow is a plugin's knowledge of how to get its own credential.** It is registered under the [`CredentialKey`](../credentials/README.md#two-key-spaces-two-questions) it writes, so a flow says which record it produces and, through that key's scope, which plugin answers for the format inside it. A second authorization protocol arrives as another flow, not as another seam.

**The flow owns the write, through `session.commit`.** `run()` resolving means the record is already committed through the session's `commit(mutate)` — a serialized read-modify-write fixed to the flow's key — and the seam refuses a flow that resolved without one, so an unrelated same-key write or a stale record can never stand in for a fresh commit. Cancellation retires the attempt only before admission: a replacement that passes the final checkpoint ignores withdrawal and finishes in storage, so an admitted write reports `authorized`, a storage failure propagates as the attempt's own error, and a declined mutation returns the current record without writing. The caller hears `cancelled` promptly, while the key stays reserved until the flow and its queued commits quiesce. Committing inside the flow is what lets a library that persists through its own store adapter stay the single writer instead of being copied back out and written twice.

**The interaction travels with the request, not a registry.** Whoever starts an authorization is the one who can talk to the human about it, so prompts reach exactly the surface that asked and a headless caller supplies an interaction that declines. There is no ambient provider to be absent, and no question about which of two open pages a prompt belongs to.

## Summary

`dsh-authorization` lets a configuration UI or another caller obtain credentials through a human-guided sign-in, code entry, or question. Each attempt sends notices and prompts only to the surface that started it. It reports `authorized` only after the new credential has been stored; a refusal or withdrawal reports `cancelled`, while failures remain errors. Choose it for credentials that cannot be supplied through configuration. It requires the credential store and an integration that defines the available authorization methods; the package provides no provider-specific methods itself.

## Table of Contents

- [Surface](#surface)
- [The interaction vocabulary](#the-interaction-vocabulary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="surface"></a>
## Surface

```ts
import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError, type AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context
declare const exchange: (signal: AbortSignal) => Promise<CredentialRecord>

const key = credentialKey('llm-pi-ai', 'openai-codex')

const dispose = ctx.authorization.registerFlow({
  key,
  label: 'ChatGPT (Codex)',
  methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
  async run(session: AuthorizationSession) {
    session.notify({ message: 'Continue in your browser', url: 'https://auth.example/start' })
    const code = await session.prompt({ kind: 'text', message: 'Paste the code' })
    const credential = await exchange(session.signal)
    await session.commit(async () => credential)
    void code
  },
})

ctx.authorization.list()                    // [{ key, label, methods, inFlight }]
ctx.authorization.describe(key)             // the same entry, or undefined
await ctx.authorization.begin({             // { status: 'authorized' | 'cancelled' }
  key,
  interaction: { notify: () => {}, prompt: () => Promise.reject(new AuthorizationDeclinedError()) },
})
ctx.authorization.cancel(key)               // withdraw whatever is running for the key
dispose()
```

One attempt per key at a time. A second caller is refused with `ALREADY_IN_FLIGHT` rather than joined, because the two would be prompting different humans through one flow and the second would be answering questions the first was asked. `inFlight` is on the entry so a surface renders the button disabled instead of discovering this by error.

`cancel(key)` exists beside the request's own signal because a request/response transport answers a Cancel button on a second call, holding no handle on the first one's signal. A flow whose registration is disposed mid-attempt is withdrawn the same way: its runner belongs to a plugin that is going away.

An attempt whose caller has already withdrawn never claims the key and never starts the flow — relying on each flow to check its signal before the first await would let one that does not hang holding the key. Validation still runs first, so a caller naming a key or method that does not exist hears about it whether or not it also gave up.

A human's "no" is an outcome, not a breakage. An interaction that declines rejects its prompt with `AuthorizationDeclinedError`, and an attempt that fails after a declined prompt settles as `cancelled`, exactly as a withdrawn signal does; any other prompt rejection stays a flow failure that reaches the caller. A notice is fire-and-forget on the same principle, held at the seam: a surface that cannot render one loses the notice, never the attempt.

`authorization/settled (key, settlement)` fires after the key is released, for every terminal outcome. `settlement` adds `failed` to the two statuses `begin()` can return: a failure reaches its own caller as a thrown error, so the event stream is the only place a watcher that did not start the attempt can tell a refusal from a breakage. Listener failures are contained: every listener runs, a throw or rejection is logged without changing the finished attempt's outcome, and only an `INVARIANT`-coded failure rethrows after the rest ran.

<a id="the-interaction-vocabulary"></a>
## The interaction vocabulary

A notice is one-way and never carries a secret: a message, optionally the page the human must open and the code they must enter there. A prompt is a question the flow cannot answer — `text`, `secret`, or `select` — and `secret` differs from `text` only in presentation. A prompt carries its own `signal` so a flow that races a typed code against a browser callback can withdraw the losing question while the attempt continues; the request's signal withdraws the whole attempt instead.

The vocabulary is deliberately smaller than any one provider's: it describes what a surface must render, so a surface that renders one flow renders all of them.

<a id="model-experience"></a>
## Model Experience

None, as authorization is a configuration-time conversation with a human and no flow, notice, or prompt reaches a model request.

#### KV Cache effect

No invalidation; no authorization state enters a request prefix.

## Known Limitations and Deferred Work

- **No flow is resumable** — an attempt lives in the process that started it, so a browser reload during a login abandons it and the human starts over. Durable attempts need a store this seam does not have.
- **Nothing revokes** — signing out is `ctx.credentials.deleteRecord(key)`, which forgets the local record without telling the issuer. A provider that needs a server-side revoke has no place to declare it yet.
- **A key with no flow is inert** — the seam reports what is registered, so a record left by an uninstalled plugin can be deleted but not re-authorized. Recognizing that orphan is the caller's join, as it is for [`listRecords()`](../credentials/README.md#surface).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
