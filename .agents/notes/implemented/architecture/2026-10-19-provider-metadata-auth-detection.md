# Agent Note: Provider metadata drives native authentication detection in the Models editor

Status: implemented

English | [中文](2026-10-19-provider-metadata-auth-detection.zh.md)

## Problem

A catalog route could authenticate through environment variables the pi-ai resolver reads natively — `OPENAI_API_KEY`, `ANTHROPIC_AUTH_TOKEN` — but the Models editor only described the reference the card would write itself, so a configured environment looked identical to a missing credential. Routes that authenticate through OAuth flows, or whose endpoint is constructed from environment variables, had no representation at all: the editor offered an API-key field they cannot use and no indication of the endpoint's real source.

## Decision

`LlmConfigurableProvider` now carries three directory facts generated from the installed pi-ai catalog: `defaultBaseURL`, `baseURLEnv`, and `nativeAuth` (`env` names plus an `oauth` flag). `llm-pi-ai/scripts/gen-provider-data.ts` emits `provider-data.generated.ts` deterministically and `pnpm verify-provider-data` rejects a stale staged file; `directoryEntries` merges the per-route supplement into every configurable route. The API proxy projects the same three fields onto `ConfigurableProviderView`, and the settings store describes each keyless row's native references — `nativeAuth.env` minus `baseURLEnv` names, which construct the endpoint rather than carry a credential — in the same batched `credentials.describe`, folding them onto the row as `credentialChecks`.

The editor keeps the fork's scoped-credential model rather than upstream's wire shape: the card still derives its write reference per management scope, but its single describe now covers that reference plus every auth reference the route would read. Detection is method-neutral — an OAuth-named variable is checked but never displayed, yielding the hidden "env var detected" hint — while a profile that names `apiKeyEnv` masks native authentication entirely, since the named reference is the only credential the adapter reads. A route whose only native authentication is OAuth shows no API-key field it could never satisfy, and the endpoint field falls back through configured `baseURL`, catalog `defaultBaseURL`, then the `baseURLEnv` hint line.

## Alternatives considered

**Copy upstream's prop-driven editor and drop the card's own describe.** Rejected: the fork's scope model means the write reference exists only where the editor derives it (`personal`/`organization`/`project` prefixes differ from every native name), so the card still describes its own references; the row's `credentialChecks` act as a pre-described fallback, not a replacement.

**Treat a configured scope reference as native detection.** Rejected: an organization- or project-scoped reference is a stored credential this page writes, not a route-native environment name; only the catalog's `nativeAuth.env` members feed the detection chain, while the scope reference supplies the saved-credential signal through its `file` source.

**Show OAuth-capable variable names in the help text.** Rejected: an OAuth token name is not a place a user pastes an API key into; `visibleRefs` filters them from display while leaving them in the check chain so their configured state still produces the hidden-detection hint.

## Consequences

Every pi-ai catalog route reports the credentials its native resolver actually reads: detected, missing, unchecked, or file-saved, and the Models seat badge counts native detection toward `keyConfigured`. OAuth-only routes stay configurable without a dead input. `declared` routes keep the plain key field — an adapter that reports no native authentication earns no hint. The generated file is staged and verified like other catalogs; bumping the pinned pi-ai version reruns `gen-provider-data` or fails verification.

## Verification

`native-auth.spec.ts` asserts the generated table agrees with the installed catalog's resolver environment metadata for every route and that no credential executes during a metadata read. `components.client.spec.tsx` covers the OAuth-only field suppression, named-reference masking, method-neutral fallback lists, hidden detection, endpoint-variable exclusion, endpoint hint placement, and all three checked states. `catalog.spec.ts` and `dynamic-config.spec.ts` pin the wire exposure on real directory entries.
