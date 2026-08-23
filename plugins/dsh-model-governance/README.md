# dsh-model-governance

English | [中文](README.zh.md)

Tree-external per-instance policy plugin. It loads the gateway-generated `model-governance.json`, publishes `ctx.modelAccess` and `ctx.modelProviderConfig`, registers Gateway-backed organization credentials as a read-only layer, enforces every `llm/stream` call before adapter dispatch, and commits usage to a crash-safe local outbox before reporting it to the bearer-authenticated loopback gateway intake. A running instance watches the policy's parent directory, so the Gateway's atomic replacement is applied without restarting the instance. Missing or malformed policy fails activation at boot; an invalid live replacement enters fail-closed mode until the next valid policy arrives.

The bundle mounts `dsh-gateway-runtime` for every Gateway-launched personal and project instance. Its peer service packages resolve from the host installation, so the plugin and the mounted runtime share one Cordis instance.

Policy and usage records contain no API key or prompt/response content. Organization credentials stay encrypted in the Gateway database and cross the authenticated loopback runtime API only when an adapter resolves their reference. Credential source is a non-secret layer id used only to distinguish company and personal cost. UUID-named outbox files are committed by same-directory rename and removed only after a successful intake response; intake deduplication makes retries safe.

Personal settings commits also produce `model-registration` records for Provider/model creation, modification, and deletion. On mount, the plugin emits deterministic baseline records for identities already present in the user settings layer; replaying that baseline is idempotent across restarts. The records contain only route identities, action, scope, and timestamps; they never contain credential references' values, profile bodies, headers, prompts, or responses. They use the same outbox and intake token as usage records, while Gateway storage and administrator queries keep registration history separate from call usage. Project runtimes do not emit personal registration records.

## Organization Providers and credentials

The policy's `providers` array is the immutable enabled organization Provider snapshot consumed by LLM adapters. Organization route ids occupy the reserved `org-*` namespace and never enter editable user settings. The Gateway administration page reuses the complete Models settings plugin, so an administrator configures the protocol, endpoint, API key, model list, and model discovery through the same editor as a personal Provider, then configures role, user, and project defaults or route-specific exceptions. Each saved profile is persisted through the organization facade and projected into the snapshot; the governance page does not maintain a second, reduced Provider form. The Gateway facade and runtime loader validate the same managed pi-ai fields before persistence or publication: `compat` contains only `thinkingFormat` and `supportsReasoningEffort`, non-empty compat applies only to `openai-completions`, reasoning maps and thinking budgets use supported levels, retry policies use bounded backoff, and stream-idle timers fit Node's timer range. The publisher clones and recursively freezes the complete profile, so adapter Consumers cannot mutate headers, reasoning maps, retry configuration, modalities, or model entries in an active snapshot.

The `DSH_` credential-reference namespace belongs only to organization Providers. Editable personal `llm-pi-ai` settings reject both `DSH_` references and `org-*` routes. The credential layer exclusively claims every reference in the current snapshot and resolves it through `/internal/runtime/model-credential` once per model request. The Gateway applies user or project model authorization before returning a value. An absent value or request failure never falls through to same-named personal storage, and personal configuration surfaces see the organization reference as read-only.

Organization routes enumerate their models explicitly. `modelOverrides` is a catalog-route feature and is omitted from the organization editor; a non-empty value is rejected by both the Gateway settings facade and the runtime policy loader.

Personal runtimes combine authorized organization routes with user-declared personal BYOK routes. Project runtimes set `userDeclaredAllowed: false`; their model permissions come from the project default mode plus explicit route exceptions, so every member of one project runtime sees the same organization model set.

## Authorization decision order

For each `(provider, model)` route, the plugin decides in this order:

1. **Policy file unavailable** (invalid live reload) → deny with `POLICY_UNAVAILABLE`.
2. **Route listed in the policy catalog** → the catalog entry's `allowed` flag decides (a catalog denial cannot be overturned by a user-layer declaration).
3. **Route absent from the catalog and `userDeclaredAllowed` is `true`** → authorize if the instance's own settings user layer declares the provider (personal BYOK), deny otherwise.
4. **Fallback to `defaultAllowed`** (the gateway now writes `false` for every role).

A forbidden route terminates the stream with `MODEL_FORBIDDEN` before provider dispatch. The `userDeclaredAllowed` flag is written by the gateway: `true` for personal runtimes, `false` for shared project runtimes.

## User-declared provider discovery

The plugin tracks provider routes the user layer of the instance's own settings document carries. The set is refreshed from `ctx.llm.listConfigurableProviders()` and `ctx.settings.describe()` on every `llm/adapters-updated` and `settings/document-updated` event, so a user adding a provider through the Settings UI takes effect without a restart.

## Model Experience

A forbidden route terminates the stream with `MODEL_FORBIDDEN` before provider dispatch. An initiating Agent whose identity disagrees with an explicit `sessionId` terminates with `MODEL_ATTRIBUTION_CONFLICT`. The plugin adds no prompt content.

#### KV Cache effect

No direct effect.

## Live policy reload

The Gateway writes a complete policy to a temporary file and renames it into place. The plugin watches the parent directory, adds new Provider routes before replacing authorization, removes retired routes after authorization changes, and updates the usage intake destination from the same validated document. An `llm/stream` call keeps the authorization decision and Provider profile it read at admission, so a policy update cannot change an already-running stream halfway through. A malformed or missing live document denies new model requests and retains the last valid usage-intake destination until a valid document is published.

## Known Limitations and Deferred Work

- **Advisory quotas** — 80%/100% quota crossings notify but never reject an otherwise authorized call.
