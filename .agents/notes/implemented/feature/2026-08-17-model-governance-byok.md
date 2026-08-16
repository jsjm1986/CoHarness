# Agent Note: Model governance default-deny and user-declared (BYOK) route authorization

Status: implemented

English | [中文](2026-08-17-model-governance-byok.zh.md)

## Problem

Model governance originally had a `defaultAllowed` bypass for the `admin` role: routes absent from the governance catalog were authorized for administrators, so their usage could appear in the ledger with zero price, distorting cost statistics. Users who configured their own providers in Settings (DeepSeek API key, a custom OpenAI-compatible gateway) were denied by the governance plugin's fail-closed semantics (`defaultAllowed: false` for regular users), producing a confusing dead end: the Settings page showed the provider as configured, but the model picker never displayed its models and every prompt returned `MODEL_FORBIDDEN`. Meanwhile, the admin Models page could register a `(provider, model)` route for authorization and pricing, but that did nothing to make the provider available for actual use — the base URL, protocol, and API key still had to be configured in the user's own Settings. The split between "admin authorizes" and "user configures" meant getting a new model online required two separate steps in two different UIs, possibly by two different people.

## Decision

1. **Remove the admin `defaultAllowed` bypass.** The governance catalog is the sole authorization source for every role. Out-of-catalog routes are denied for everyone. In-catalog role defaults (the per-route `adminAllowed`/`userAllowed` flags set at upsert time) are unaffected.

2. **Personal runtimes allow user-declared (BYOK) routes.** A route absent from the governance catalog is authorized when the instance's own settings user layer declares the provider. Usage is recorded with the same ledger: the catalog has no price, so the estimated cost is 0, and the personal credential attribution keeps the company cost at 0. Project runtimes stay catalog-only.

3. **Catalog routes take precedence.** A route present in the governance catalog always follows the catalog entry's `allowed` flag, even if the user layer also declares the same provider. A catalog denial cannot be overturned by a user-layer redeclaration.

4. **The DeepSeek provider editor records `apiKeyEnv` in the user layer.** The existing pi-ai materialization (writing the conventional credential reference when a key is typed onto a fresh profile) now also applies to the `llm-deepseek` section root, so both adapter families produce a consistent "user configured this route" signal for the BYOK mechanism.

## Mechanism

- The gateway writes `userDeclaredAllowed: true` for personal runtimes and `false` for project runtimes into the policy file (the single `writeProjection` function in `apply-model-governance.ts`).
- The plugin validates the new field and fails loud at boot when it is absent or non-boolean.
- `ReloadableModelAccess` gains a `userDeclared` lookup callback. The decision order is: unavailable → catalog routes → (userDeclaredAllowed && provider has a user-layer profile) → defaultAllowed.
- A `UserDeclaredRoutes` class tracks the provider id set, refreshed from `ctx.llm.listConfigurableProviders()` + `ctx.settings.describe()` on `llm/adapters-unpdated` and `settings/document-updated` events.
- `dsh-settings` is a compile-time (type-only) dependency; the emitted lib retains the no-runtime-imports constraint.

## Alternatives considered

- **Gateway-level policy projection** (parsing the user's settings.yaml on the gateway side and writing the BYOK route set into the policy file). Rejected because it would require the gateway to watch each user's settings file, duplicating the settings seam's hot-reload.
- **`declared` flag on configurable-provider directory entries** as the BYOK signal. Rejected because a shipped route (e.g., `deepseek-official`) with a user-typed key is not `declared` (pi-ai ships it), but the user's own key should count as BYOK.
- **Keeping the admin `defaultAllowed` bypass** and relying on the catalog's role defaults for containment. Rejected because the bypass made cost statistics unreliable for any model the admin tested without registering.

## Related files

- `plugins/dsh-model-governance/src/policy.ts` — `userDeclaredAllowed` field + validation
- `plugins/dsh-model-governance/src/user-routes.ts` — new
- `plugins/dsh-model-governance/src/access.ts` — decision order
- `plugins/dsh-model-governance/src/index.ts` — event wiring
- `gateway/src/postgres/model-governance-service.ts` — `defaultAllowed: false`
- `gateway/src/model-governance.ts` — `defaultAllowed: false`
- `gateway/src/services.ts` — tightened return type
- `gateway/src/apply-model-governance.ts` — projection field
- `packages/client/ui-settings-models/src/client/ProviderEditor.tsx` — deepseek apiKeyEnv materialization

## Consequences

The governance catalog is now the sole authorized model source for every role, so cost statistics are reliable. Users who configure their own providers in Settings (BYOK) see them appear in the model picker immediately and can use them; usage is recorded with personal-cost attribution and no catalog price. Project runtimes remain catalog-only, so shared project members cannot add personal providers. The DeepSeek provider editor also writes the credential reference into the user layer, so both adapter families produce a consistent "user configured this route" signal. The new `userDeclaredAllowed` field is required in the policy file — gateways that write it are compatible with the updated plugin, but the plugin rejects a missing field at boot with a clear error message. The `defaultAllowed` field is written as `false` for every role, so the admin bypass is gone; administrators who need to test an unregistered model must register it in the catalog first.