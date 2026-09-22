# Permission Presets

English | [中文](permission-presets.zh.md)

The permission-preset layer of [dsh-permission-presets](../../packages/interaction/permission-presets) (`ctx.permissionPresets`, `PermissionPresetService`) bundles the two independent enforcement knobs — [sandbox mode](sandbox.md) (`sandbox/mode`) and [approval policy](approval.md) (`approval/policy`) — into named presets a client offers as one Permissions selector. It is one optional capability, not part of the agent-loop spine, and it owns no enforcement: execution, prompt narration, and replay keep reading their knob folds, and a preset switch only records intent and writes through each knob's canonical setter. The [package README](../../packages/interaction/permission-presets/README.md) owns composition status and limitations; the [sandbox switching design](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) owns the rationale.

Source: [`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)

## The preset table

A preset is a table key mapping to one sandbox/approval bundle plus optional client presentation; the default table ships `workspace-write` (`workspace-write` + `ask`) and `danger-full-access` (`danger-full-access` + `never`).

```ts type-equiv
/** One preset's sandbox/approval bundle and optional client presentation. */
interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}
```

```ts type-equiv
/** The {@link PermissionPresetService} config: preset table and composition default. */
interface Config {
  /**
   * The preset table: name → knob bundle. Defaults to `workspace-write`
   * (workspace-write + ask) and `danger-full-access` (danger-full-access +
   * never). The names `custom` and `auto` are reserved for derived state and
   * the Auto review integration respectively.
   */
  presets?: Record<string, PresetSpec>
  /**
   * Default for new sessions. When omitted, the preset matching the composed
   * sandbox and approval defaults is used.
   */
  defaultPreset?: string
}
```

The service requires a confining `ctx.shell` executor and `ctx.approval`, and misconfiguration fails at plugin load: a table entry named `custom` throws (the name is reserved for the derived not-a-preset state), and composing over a bash executor that does not confine (no `sandboxMode` capability fact) throws, because presets bundle a sandbox mode.

## Current preset and the derived `custom`

`current(events)` derives the effective preset from the knobs, not from its own event alone: it folds the session's effective sandbox mode (falling back to the executor's configured mode) and effective approval policy (falling back to the approval service config, then `ask`), prefers a still-matching recorded selection, then the first matching table entry in declaration order, and otherwise returns `CUSTOM_PRESET` (`'custom'`). `custom` is derived-only: clients may display it as the current value, but it is never a switch target or an event payload.

`names` lists the switchable presets in table declaration order; `optionOf(name)` builds the option a client renders for a table key (label falls back to the key) or for `custom`, and throws for any other name.

```ts type-equiv
/** Presentation for an available preset or the derived `custom` current value. */
interface PresetOption {
  /** Stable option value: a configured preset key, live `auto`, or derived `custom`. */
  value: string
  /** The display label. */
  name: string
  /** One user-facing sentence on what the value means; omitted when not configured. */
  description?: string
}
```

## Switching and the `permission/preset` event

`set(session, name)` resolves the preset (unknown names throw), appends a log-only `permission/preset` event unless `name` is already the effective preset, then writes each knob through its own setter — `setSandboxMode` from [dsh-sandbox-policy](../../packages/sandbox/sandbox-policy) and `setApprovalPolicy` from [dsh-user-approval](../../packages/interaction/user-approval) — only when that knob's effective value changes. The selection event precedes the knob events in the same turn, and re-selecting the effective preset appends nothing at all.

`permission/preset` is durable, log-only user intent: it stays out of the model transcript (the knob events own the model-visible consequences through their consumers), and it exists so `current()` can preserve WHICH preset the user chose when two presets share a bundle; `effectivePermissionPreset(events)` folds the last one, and replay needs no catch-up state. The complete event declaration is in the [persistence log event catalog](../persistence-catalog.md); the method signatures are in the generated [service catalog](#ctxpermissionpresets--permissionpresetservice).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpermissionpresetauthorization--permissionpresetauthorization"></a>

### `ctx.permissionPresetAuthorization` — `PermissionPresetAuthorization`

Optional policy supplied by a deployment that owns the request identity.

```ts cordis-catalog
/**
 * Return whether the current request may select a named preset.
 * @param name - preset table key requested by the account.
 * @returns whether the request may select the preset.
 */
canSelect(name: string): boolean

/**
 * Recheck deployment authority before an explicit command commits its preset.
 * @param agent - Agent whose current Session receives the selection.
 * @param name - validated preset name.
 * @returns completion when selection is authorized; rejection leaves the Session unchanged.
 */
authorizeSelection?(agent: Agent, name: string): Promise<void>

/**
 * Authorize an explicit future-session default using the live account request.
 * @param name - schema-valid configured preset name; Auto is never a default.
 * @returns completion when the default may be persisted.
 */
authorizeDefault?(name: string): Promise<void>
```

Types: [Agent](core.md)

Source: [`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)

<a id="ctxpermissionpresets--permissionpresetservice"></a>

### `ctx.permissionPresets` — `PermissionPresetService`

Owns the deployment's configured permission presets, the fixed Auto integration hook, and their write path. Requires a confining `ctx.shell` executor and `ctx.approval`; unmatched knob values are reported as CUSTOM_PRESET, not an error.

```ts cordis-catalog
/**
 * Read the complete process-level catalog exposed to current-session UI.
 * @returns every currently selectable preset in contribution order.
 */
@Remote('catalog') catalog(): PermissionCatalog

/**
 * Publish the fixed current-session Auto preset for the calling
 * integration's effect lifetime.
 * @param admit - synchronous gate run before live Auto selection or restore.
 * @returns the async effect disposer that removes Auto.
 */
registerAuto(admit: () => void): () => Promise<void>

/**
 * Resolve the preset matching the effective knob values. A still-matching
 * last selection wins shared-bundle ties; otherwise the first configured
 * match wins. Returns
 * {@link CUSTOM_PRESET} when no available preset matches.
 * @param session - the session whose knob state is read.
 * @returns the effective preset name, or `custom` when nothing matches.
 */
current(session: Session): string

/**
 * Resolve an available preset's knob bundle.
 * @param name - the preset name to resolve.
 * @returns the configured bundle.
 * @throws when `name` is neither configured nor the currently live Auto preset.
 */
resolve(name: string): PresetSpec

/**
 * Build the client option for an available preset or {@link CUSTOM_PRESET}.
 * A missing label falls back to the preset key.
 * @param name - a configured preset key, live `auto`, or `custom`.
 * @returns the option a client renders.
 * @throws when `name` is neither a configured preset, live `auto`, nor `custom`.
 */
optionOf(name: string): PresetOption

/**
 * Record a changed preset, then update each changed knob through its own
 * setter. Selecting the effective preset again appends nothing.
 * @param session - the session the switch belongs to.
 * @param name - the preset to switch to; unknown names throw.
 */
set(session: Session, name: string): void

/**
 * Advance one blank session after the host has confirmed it as the exact
 * Web New Session reuse target. Only a still-effective
 * default-origin selection advances; a started session, an explicit pick,
 * legacy origin-less data, or independently changed knobs remain pinned.
 * This is the permission-side half of the Web candidate selection and the
 * host's blankness, membership, cwd, and archive verification.
 * @param session - the live session selected for Workspace blank reuse.
 */
refreshDefaultForReuse(session: Session): void
```

Types: [Session](session.md)

Source: [`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)

<a id="permission-presets-events"></a>

### `permission-presets/*` events

<a id="permission-presetscatalog-changed--emit"></a>

#### `permission-presets/catalog-changed` — emit

The selectable process catalog changed. Payload-free by design: consumers subscribe first, then re-read the complete catalog.

```ts cordis-catalog
/**
 * The selectable process catalog changed. Payload-free by design:
 * consumers subscribe first, then re-read the complete catalog.
 * @mode emit
 */
'permission-presets/catalog-changed'(): void
```

Source: [`packages/interaction/permission-presets/src/types.ts`](../../packages/interaction/permission-presets/src/types.ts)
<!-- END GENERATED cordis-surface -->
