# Agent Note: Classify pi-ai transport truncations from flattened message text

Status: implemented

English | [中文](2026-07-22-pi-ai-transport-truncation-classification.zh.md)

## Problem

A TUI run whose model connection dropped mid-stream surfaced the single notice `terminated`, and a truncated Anthropic response surfaced `Anthropic stream ended before message_stop`. Both are transport truncations — the connection died before the provider's terminal SSE event — yet `classifyPiAiError` in `dsh-llm-pi-ai` mapped neither, falling through to the catch-all `PI_AI_ERROR`. Because `PI_AI_ERROR` is not in `llm-retry`'s `DEFAULT_RETRYABLE_CODES` (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`), a recoverable drop was treated as a permanent failure and never retried.

The same terminal-event wording can also follow a response that was never an SSE stream. An OpenAI-compatible base URL missing its deployment's `/v1` prefix can return `200 text/html`; pi-ai consumes the landing page as a stream and reports `Stream ended without finish_reason`. The adapter needs to distinguish that clear path mismatch from a genuine transport truncation, then try the one alternate prefix without exposing an internal retry to the agent.

The detail loss is upstream and unrecoverable in the adapter: pi-ai reduces a caught error to `error.message` (`api/anthropic-messages.js`: `errorMessage = error instanceof Error ? error.message : JSON.stringify(error)`) before pushing the terminal `error` event, discarding the original `Error` and its `cause` chain. undici carries the actionable `SocketError` on `cause` but hands the fetch wrapper a bare `terminated`; pi-ai keeps only that word. pi-ai `SimpleStreamOptions` exposes no fetch/dispatcher/client hook we could use to capture the `cause` ourselves before it is flattened.

## Decision

- `classifyPiAiError` recognizes two more transport wordings and maps both to `TRANSPORT` when the response metadata is absent or identifies an SSE response:
  - a mid-stream socket drop rendered as a bare `terminated` (undici) or `Premature close` (Node stream layer);
  - a stream truncated before its terminal event, which each pi-ai provider throws with its own wording (`Anthropic stream ended before message_stop`, `… before a terminal response event`, `… ended without a terminal event`, `Stream ended without finish_reason`), matched on `stream ended before/without`.
- The classifier carries an `XXX(pi-ai upstream)` note naming the flattening site and stating the intended fix: classify on `code`/`cause` if pi-ai ever forwards the original `Error` or a hook that lets us capture the `cause`. Classification stays best-effort text matching until then.
- `PiAiAdapter` captures the per-request `ProviderResponse` through pi-ai's `onResponse` callback. A terminal-event parser error after an explicit non-`text/event-stream` response maps to `MALFORMED_RESPONSE`, retains the HTTP status, and names the provider, content type, protocol, and `baseURL` correction. OpenAI-compatible diagnostics mention that these endpoints commonly require a `/v1` suffix.
- OpenAI-compatible requests derive the entered prefix and one trailing `/v1` toggle from the shared endpoint helper. A 404/405 or an explicit non-SSE successful response aborts the current SDK attempt, suppresses its terminal chunks, and tries the alternate once; 401/403, 429, 5xx, network failures, missing content type, and SSE truncation do not switch URLs. A successful candidate is retained in a process-local cache shared with model discovery, and a profile snapshot change clears that cache without rewriting settings.
- `PiAiAdapter` captures the per-request `ProviderResponse` through pi-ai's `onResponse` callback. A terminal-event parser error after an explicit non-`text/event-stream` response maps to `MALFORMED_RESPONSE`, retains the HTTP status, and names the provider, content type, protocol, and `baseURL` correction. OpenAI-compatible diagnostics mention that these endpoints commonly require a `/v1` suffix. The OpenAI SDK does not call that callback for non-2xx responses, so the adapter recognizes only 404/405 from the flattened terminal status text.
- `llm-pi-ai/README.md` records both the cause-chain loss and the limited response metadata retained for response-format diagnostics.

Classification stays on message text because that is the only signal pi-ai delivers; the `XXX` marks it as a workaround, not the desired end state.

## Alternatives considered

**Capture the `cause` via a pi-ai fetch/dispatcher/client hook.** Rejected: pi-ai exposes none. `onResponse` fires before the body stream is consumed, so it can retain status and content type but cannot observe or explain a mid-stream drop. The Anthropic path accepts a `client` object, but constructing and injecting a provider SDK client per request to intercept transport errors reaches around the adapter boundary for one diagnostic string.

**Leave both as `PI_AI_ERROR` and widen `llm-retry`'s retryable set.** Rejected: `PI_AI_ERROR` is the catch-all for genuinely unclassified failures, including non-retryable ones (a malformed provider response, an unexpected SDK bug). Making the catch-all retryable would retry failures that will never succeed; the fix is to classify the recoverable case, not to blur the bucket.

**Wrap the flattened error in an `LlmError('TRANSPORT', { cause })` in the adapter, mirroring the DeepSeek adapter.** Rejected here: the DeepSeek adapter wraps a *pre-response* `fetch` rejection whose `cause` is still intact, so chaining preserves real detail. In the pi-ai path the terminal event's `errorMessage` is already a flattened string with no `cause` to chain, so wrapping would add a layer without recovering anything; classifying the code is the only value left to add.

**Automatically append `/v1` to every OpenAI-compatible base URL.** Rejected: valid gateways can serve Chat Completions directly below their configured prefix or use another deployment path. The adapter probes the exact prefix first, tries only its one explicit toggle after a path mismatch, and keeps the configured value unchanged.

## Testing

`packages/llm/llm-pi-ai/tests/adapter.spec.ts` distinguishes an HTML response from a genuinely truncated SSE stream at the adapter boundary, and pins both URL directions, cache reuse, profile invalidation, and Anthropic normalization. `examples/headless-agent/malformed-provider.cordis.snapshot.yml` boots the assembled headless app with the real pi-ai adapter against a local endpoint that returns HTML at the root and a valid SSE stream at `/v1`; its transcript pins transparent fallback, the two request paths, and the absence of an `llm/retry` event.

## Consequences

- A mid-stream transport drop and an SSE response truncated before its terminal event carry `TRANSPORT`, so a composed `llm-retry` policy retries them by default instead of failing the turn.
- A response with an explicit non-SSE content type followed by terminal-event parser text either selects the one alternate prefix or, when both candidates fail, carries `MALFORMED_RESPONSE` with the HTTP status and configuration hint.
- Genuine transport notices remain unchanged (`terminated` / `Anthropic stream ended before message_stop`): the cause detail is gone before the adapter sees it, so `errorChain` has nothing more to render.
- Classification remains string-matching and provider-wording-dependent: a future pi-ai release that rewords these errors would silently fall back to `PI_AI_ERROR` until the patterns are updated. The `XXX` note points at the durable fix (route on a forwarded `code`/`cause`).
