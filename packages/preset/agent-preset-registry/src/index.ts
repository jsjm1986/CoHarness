/**
 * Agent presets: each session composes its model-facing plugin set from one
 * preset `cordis.yml`, mounted ONCE per preset under a standing scope and
 * joined by every agent that names it.
 *
 * The standing mount is what makes a preset one composition rather than one
 * per session: its plugin instances, tool registrations, prompt sections, and
 * projection units exist exactly once, keyed per session inside the plugins
 * themselves (they predate presets and were written for a shared world). An
 * agent joins by having its scope key parented to the mount's
 * ({@link bindScopeParent}), which makes the mount's registrations visible to
 * that agent's views and the mount's listeners receive that agent's events —
 * and a host reader with no agent at all (a cold transcript read) resolves
 * the same standing registrations by preset id.
 *
 * This package owns the preset vocabulary, filesystem discovery, and the
 * guarded standing mount. It does not decide when an agent is created — the
 * agent factory's `setup(agentCtx)` hook is the one supported call site,
 * because only there is the join installed while the agent is still
 * unpublished, so a rejected composition rolls the whole creation back.
 * @module @deepseek-ai/dsh-agent-preset-registry
 */

import { stat } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'
import z from '@deepseek-ai/schemastery'
import { bindScopeParent, createScope, scopeOf, scopeParentOf, type Scope, type ScopeKey, type ScopeParentBinding } from '@deepseek-ai/dsh-scope'
// Type-only: resolves the `agent/created` lifecycle event this service watches.
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: resolves ctx.pluginPackages for the resolution-generation package lookup.
import type {} from '@deepseek-ai/dsh-app-boot'
import { collaborationRemoteRefusal } from '@deepseek-ai/dsh-collaboration'
import type { CollaborationAuthority } from '@deepseek-ai/dsh-collaboration'
import { hasConversationContent } from '@deepseek-ai/dsh-session/surface'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { settingsNamespace, type SettingsScope, type default as SettingsService } from '@deepseek-ai/dsh-settings'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { resolve } from 'node:path'
import { discoverPresets, USER_PRESET_DIR } from './discovery.ts'
import { copyComposition, deleteComposition, readComposition } from './authoring.ts'
import { entryListProblem, type PresetDefinition } from './definition.ts'
import {
  auditRows, leakedServices, livePresetMounts, mountDefinition, mountPreset, serviceForAgent,
  standingMountFor, type PresetMount,
} from './mount.ts'
import { InvalidPresetIdError, PresetExistsError, PresetNotWritableError } from './authoring.ts'
import { PresetMountError, UnknownPresetError, type AgentPreset, type Config, type FileAgentPreset, type PresetRoot } from './preset.ts'
import {
  activeCompositionModules, definitionComposition, fileComposition, mountedCompositionRows,
  type AgentPresetComposition, type AgentPresetInspection,
} from './composition-inventory.ts'
import type { AgentPresetDocument, AgentPresetRoster } from './types.ts'
import { agentPresetProjectionDefinition, resolveSessionPreset } from './session.ts'
export type * from './types.ts'
export { agentPresetProjectionDefinition } from './session.ts'

/** Refuse an empty preset id before invoking a domain operation. */
function validatePresetId(value: string, field: 'agentPreset' | 'from'): void {
  if (value.length === 0) {
    throw new RemoteError('gateway/bad-request', `${field} must be a non-empty string`, {})
  }
}

/** Settings namespace carrying the user's chosen default preset. */
export const SETTINGS_NAMESPACE = 'agent-presets'

/** The user-writable slice of this plugin's config. */
export interface AgentPresetSettings {
  /** Preset mounted when a session names none and mode selection is shown. */
  default?: string
  /** Whether visible mode selection and the saved `default` govern unnamed new sessions. */
  modeSelectionEnabled?: boolean
}

/** Runtime schema for the user-writable slice. */
export const AgentPresetSettingsSchema: z<AgentPresetSettings> = z.object({
  default: z.string(),
  modeSelectionEnabled: z.boolean(),
})

export { COMPOSITION_FILE, discoverPresets, scanRoot } from './discovery.ts'
export { classifyRowSpecifier, type RowSpecifier } from './specifier.ts'
export {
  METADATA_FILE, readPresetMetadata, renderPresetMetadata, type PresetMetadata,
} from './metadata.ts'
export {
  auditRows, environmentForAgent, inactiveRows, leakedServices, livePresetMounts, mountDefinition,
  mountPreset, serviceForAgent, serviceForMount, standingMountFor,
  type JoinedPresetMount, type PresetMount, type RowAudit,
} from './mount.ts'
export {
  copyComposition, deleteComposition, InvalidPresetIdError, PresetExistsError,
  PresetNotWritableError, readComposition, writableRoot,
} from './authoring.ts'
export { entryListProblem, type PresetDefinition } from './definition.ts'
export { resolveSessionPreset, type PresetBearingSession } from './session.ts'
export { PresetMountError, UnknownPresetError } from './preset.ts'
export {
  activeCompositionModules, definitionComposition, fileComposition, mountedCompositionRows,
  type AgentPresetComposition, type AgentPresetCompositionRow, type AgentPresetInspection,
  type CompositionRowEnablement,
} from './composition-inventory.ts'
export type { AgentPreset, Config, FileAgentPreset, PresetRoot, PresetTrust } from './preset.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentPresets: AgentPresetRegistry
  }
}

/**
 * Registry over the deployment's agent presets.
 *
 * File discovery is unmemoized: `list()` and `resolve()` re-read the roots on
 * every call so a preset authored while the process runs is visible
 * immediately, and a preset deleted underneath a picker disappears from the
 * next read. A second source joins the same roster: plugins declaring a
 * `PresetDefinition` through {@link AgentPresetRegistry.register}, whose rows
 * mount under registry-owned generations the way upstream's declarative model
 * composes them.
 */
export class AgentPresetRegistry extends TypertRemoteService {
  static inject = ['loader']

  /** Runtime schema for the preset roster. */
  static Config = z.object({
    default: z.string().required(),
    roots: z.array(z.object({
      path: z.string().required(),
      trust: z.union(['system', 'user'] as const).default('user'),
    })).default([]),
    includeUserRoot: z.boolean().default(true),
  }) as z<Config>

  /**
   * The roots discovery and authoring actually scan: every configured root in
   * order, then the harness-home user root unless `includeUserRoot` is false.
   *
   * Derived once, because a root set that changed between `list()` and the
   * `copy()` acting on its answer would author into a directory the caller
   * never saw. Appending rather than prepending keeps an earlier configured
   * root winning a duplicate id, so a shipped preset still shadows a
   * locally authored directory that claimed its name.
   */
  private readonly resolvedRoots: readonly PresetRoot[]
  /** Base URL where installed package rows are resolved for discovery health. */
  private readonly harnessBase: string | undefined

  /**
   * The user layer over `config.default` and the picker-visibility base,
   * present only while a settings provider is composed. Held rather than
   * snapshotted so a hot-reloaded document takes effect without a restart.
   */
  private settings: SettingsScope<AgentPresetSettings> | undefined

  /**
   * The settings service behind {@link settings}, held for the one write this
   * service makes: clearing a user default it has just deleted.
   */
  private settingsService: SettingsService | undefined

  /**
   * The service's own untraced context. Methods invoked through the traceable
   * proxy see `this.ctx` rebound to the CALLER's context, which carries a
   * shadow; a subtree minted from it resolves every service through that
   * shadow's fiber instead of each entry's own inject store, so preset rows
   * would fail on the very services they declare. Standing mounts must hang
   * off the untraced original (the `jobs-local` selfCtx precedent).
   */
  private readonly selfCtx: Context

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentPresets')
    this.selfCtx = ctx
    if (ctx.baseUrl === undefined && (config.roots.length > 0 || config.includeUserRoot)) {
      throw new Error(
        'agent-presets: the roster needs `ctx.baseUrl` to resolve the plugins a composition names; '
        + 'compose it under a Loader, or set the base on the context this plugin is applied to',
      )
    }
    this.harnessBase = ctx.baseUrl
    this.resolvedRoots = config.includeUserRoot
      ? [...config.roots, { path: dshHomePath(USER_PRESET_DIR), trust: 'user' }]
      : [...config.roots]
    for (const root of this.resolvedRoots) {
      if (root.trust === 'user') registerManagedDataPath({
        owner: '@deepseek-ai/dsh-agent-preset-registry', kind: 'directory', path: resolve(expandHomePath(root.path)),
      }, process.env.DSH_MANAGED_DATA_MANIFEST)
    }
    // Deliberately not `installSettingsSection`: that helper exists to re-judge
    // what a consumer DERIVED from the source — memoized resolutions,
    // registration-level facts — across attach, detach, and change. Nothing
    // here is derived. `defaultId` reads through on every call, so both of its
    // hooks would be no-ops and the source thunk would restate this field.
    ctx.inject(['settings'], (settingsCtx) => {
      this.settings = settingsCtx.settings.register(
        settingsNamespace(SETTINGS_NAMESPACE),
        AgentPresetSettingsSchema,
        {
          base: { default: config.default, modeSelectionEnabled: true },
          owner: 'project', projectWrite: 'manager',
          projectWritePaths: [['default'], ['modeSelectionEnabled']],
        },
      )
      this.settingsService = settingsCtx.settings
      settingsCtx.effect(() => () => {
        this.settings = undefined
        this.settingsService = undefined
      }, 'agentPresets.settings()')
    })

    // The projection unit is optional so the compact/headless composition can
    // keep resolving the current preset by scanning the log
    // (`resolveSessionPreset`). Assemblies with the registry get the eagerly
    // maintained `agentPreset` projection for client reads.
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(agentPresetProjectionDefinition)
    })

    // Advisory, not fatal: a synchronous `agent/created` listener that throws
    // VETOES publication, and this service must not, because composing an agent
    // outside the roster is legal — `recompose` binds exactly such a bare agent
    // below, and the ACP, SDK-server, and headless entry points all create one.
    // This listener is the check: it logs one warning per bare published agent.
    // Why an unjoined agent matters at all has one home: the [Agent
    // Note](../../../../.agents/notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.md).
    //
    // Known false positive: a session created bare and bound later by
    // `recompose` is warned about once, before its first bind. No shipped flow
    // does that today — the Web surface mounts in `setup` and children join
    // through `composeFrom` before publication.
    ctx.on('agent/created', ({ agent }) => {
      if (this.resolvedRoots.length === 0) return
      if (this.composedPreset(agent.ctx) !== undefined) return
      ctx.logger.warn(
        `agent "${agent.id}" was published without joining an agent preset; `
        + 'its tools, prompt sections, and skill catalog resolve against the empty global layer '
        + '(join through AgentPresets.mount() or composeFrom() in the agent factory setup)',
      )
    })

    // The durable record is the commit point. Its public notification carries
    // only the stable identity needed by clients, never the live Session.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent-preset/selected') return
      ctx.emit('agent-preset/selected', session.id, event.data.agentPreset)
    })
  }

  /**
   * The preset id mounted when a caller names none.
   *
   * Read per call rather than cached: the settings document is hot-reloaded, so
   * changing the default takes effect on the next session created and leaves
   * every running session on the preset it was composed from.
   */
  get defaultId(): string {
    // Hiding the picker is also the product's safe-default boundary: a saved
    // choice must not silently compose a non-standard new session while no
    // control reports that choice.
    return this.selectionPolicy().defaultId
  }

  /** Read one internally consistent snapshot of the selection policy. */
  private selectionPolicy(): { enabled: boolean; defaultId: string } {
    const settings = this.settings?.get()
    if (settings === undefined) return { enabled: true, defaultId: this.config.default }
    const enabled = settings.modeSelectionEnabled ?? true
    return {
      enabled,
      defaultId: enabled ? settings.default ?? this.config.default : this.config.default,
    }
  }

  /**
   * Every preset the roster currently supplies.
   *
   * Declared presets are deliberate composition and read as the first root: a
   * file preset id one declares is shadowed, not duplicated.
   * @returns the presets, declared first then first-root-wins per id.
   */
  async list(): Promise<AgentPreset[]> {
    const declared = await Promise.all([...this.declarations.values()].map(record => this.declaredRow(record)))
    const packages = this.ctx.get('pluginPackages')
    const found = packages === undefined
      ? await discoverPresets(this.resolvedRoots, this.harnessBase)
      : await discoverPresets(
        this.resolvedRoots,
        this.harnessBase,
        (specifier, base) => packages.packageOf(specifier, base) !== undefined,
      )
    const rows = [...declared, ...found.filter(preset => !this.declarations.has(preset.id))]
    return rows.sort((left, right) => {
      const byOrder = (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY)
      return byOrder === 0 ? left.id.localeCompare(right.id) : byOrder
    })
  }

  /** One declared record as a roster row, audited live. */
  private async declaredRow(record: DeclaredRecord): Promise<AgentPreset> {
    const broken = await this.declaredDiagnostic(record)
    return {
      id: record.config.id,
      trust: 'system',
      ...(record.config.name === undefined ? {} : { name: record.config.name }),
      ...(record.config.description === undefined ? {} : { description: record.config.description }),
      ...(record.config.order === undefined ? {} : { order: record.config.order }),
      ...(broken === undefined ? {} : { broken }),
    }
  }

  /**
   * Read every preset's flattened composition for a read-only inventory.
   * Live standing mounts answer from their Loader tree; an unmounted preset is
   * parsed from disk and never activated merely because it is listed.
   * @returns preset identities and composition rows in roster order.
   */
  async compositionInventory(): Promise<AgentPresetComposition[]> {
    const defaultId = this.defaultId
    const evaluateExpression = (expression: string): unknown => {
      // Loader expressions are deployment-owned config, not model input. A
      // failed evaluation remains conditional rather than becoming enabled.
      return evaluate(this.selfCtx.loader.ctx, expression)
    }
    const rootFiber = this.ctx.root.fiber
    const result: AgentPresetComposition[] = []
    for (const preset of await this.list()) {
      const identity = {
        id: preset.id,
        trust: preset.trust,
        ...preset.name === undefined ? {} : { name: preset.name },
        isDefault: preset.id === defaultId,
      }
      const mounted = livePresetMounts(rootFiber).findLast(candidate => candidate.presetId === preset.id && candidate.tree !== undefined)
      if (mounted?.tree !== undefined) {
        result.push({ ...identity, rows: mountedCompositionRows(mounted.tree) })
        continue
      }
      if (preset.broken !== undefined) {
        result.push({ ...identity, broken: preset.broken, rows: [] })
        continue
      }
      const record = this.declarations.get(preset.id)
      if (record !== undefined) {
        const read = definitionComposition(record.config.plugins, evaluateExpression)
        result.push('broken' in read
          ? { ...identity, broken: read.broken, rows: [] }
          : { ...identity, rows: read.rows })
        continue
      }
      const read = await fileComposition((preset as FileAgentPreset).path, evaluateExpression)
      result.push('broken' in read
        ? { ...identity, broken: read.broken, rows: [] }
        : { ...identity, rows: read.rows })
    }
    return result
  }

  /**
   * Resolve one preset by id.
   *
   * A broken preset resolves — deleting one, reading one, and reporting one
   * all need the row — and the mounting paths refuse it AFTER resolution
   * through {@link resolveMountable}.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved preset.
   * @throws when no configured root supplies that id.
   */
  async resolve(id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.defaultId
    const record = this.declarations.get(wanted)
    if (record !== undefined) return await this.declaredRow(record)
    const presets = await this.list()
    const found = presets.find(preset => preset.id === wanted)
    if (found === undefined) {
      throw new UnknownPresetError(wanted, presets.map(preset => preset.id))
    }
    return found
  }

  /**
   * Resolve one preset that is about to compose an agent, refusing a broken
   * one with its discovery-reported reason. Failing here rather than inside
   * the loader keeps the answer the same for every unloadable shape — ghost
   * directory, unparsable YAML, rowless list — and spends no mount attempt
   * on a composition discovery already read as unusable.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved, mountable preset.
   * @throws when the preset is unknown or discovery reports it broken.
   */
  private async resolveMountable(id?: string): Promise<AgentPreset> {
    const preset = await this.resolve(id)
    if (preset.broken !== undefined) {
      throw new PresetMountError(preset.id, preset.broken)
    }
    return preset
  }

  /**
   * Standing mounts by preset id and realm, single-flight so two agents
   * racing the first use of one composition share one mount. A settled
   * failure is removed so a later session retries a preset whose file has
   * been fixed; a settled success serves until the composition FILE visibly
   * changes — each generation records its file stamp, and a stale stamp
   * starts the next generation for sessions created afterwards. Sessions
   * already joined keep the generation they run on; a superseded one is
   * never disposed while the process lives (reclaimed only by whole-tree
   * teardown), so editing files is bounded by how often compositions change,
   * not by session count.
   */
  private readonly standing = new Map<string, Map<string | undefined, Promise<StandingMount>>>()

  /**
   * Realm mount hooks by realm key. A hook runs inside a fresh standing
   * scope before the composition loads, which is where a host installs the
   * environment the composition's service lookups resolve against — an SSH
   * target's providers shadowing `fs`/`subprocess`/`sandbox` for every agent
   * joined to that realm's generation.
   */
  private readonly realms = new Map<string, StandingRealmHook>()

  /**
   * Parent bindings of the agents this roster composed, keyed by the agent's
   * scope key. The binding is dsh-scope's only re-link capability; holding it
   * here makes this service the sole authority that can move an agent between
   * standing compositions. WeakMap: entries die with their agents. An agent
   * joined to a declared generation also records that generation, so a rebind
   * or agent teardown releases its user count.
   */
  private readonly bindings = new WeakMap<ScopeKey, { parent: ScopeParentBinding; generation?: DeclaredGeneration }>()

  /** Plugin-declared presets by id, registered through {@link register}. */
  private readonly declarations = new Map<string, DeclaredRecord>()
  /** Live declared generations by their scope key. */
  private readonly declaredGenerations = new Map<ScopeKey, DeclaredGeneration>()

  /**
   * Preset switches per session, queued so two racing `select` calls cannot
   * interleave the blankness re-check with the recompose: each turn re-reads
   * visibility inside the queue before it swaps.
   */
  private readonly switches = new Map<SessionId, Promise<unknown>>()

  /**
   * Compose one agent from a preset: ensure the preset's standing mount, then
   * parent the agent's scope key to it so the mount's registrations and
   * listeners cover this agent.
   *
   * Call from the agent factory's `setup(agentCtx)`; a rejection there rolls
   * the agent creation back, so a broken preset never yields a half-composed
   * session.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @param realm - registered realm key whose generation the agent joins, or
   *   `undefined` for the host-local composition.
   * @returns the preset that was composed, for the caller to record.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async mount(agentCtx: Context, id?: string, realm?: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const preset = await this.resolveMountable(id)
    const record = this.declarations.get(preset.id)
    if (record !== undefined) {
      const generation = await this.retainDeclared(record, realm)
      await this.bindDeclared(agentCtx, agentKey, generation)
      return preset
    }
    const standing = await this.ensureStanding(preset as FileAgentPreset, realm)
    // The one bind of this agent's ancestry. The binding is the only re-link
    // authority, held privately so nothing outside this roster can move a
    // composed agent to another preset; a later recompose layer re-links
    // through it under the caller-owned blank-session contract.
    this.bindings.set(agentKey, { parent: bindScopeParent(agentKey, standing.key) })
    return preset
  }

  /**
   * Join one agent to the SAME standing composition another already runs on.
   *
   * This is how a child agent inherits its parent's capabilities. It is a bind,
   * not a mount: the parent's generation is already composed, so the child gets
   * that exact instance — the same plugin objects, the same tool registrations,
   * the same prompt sections. Re-resolving the parent's preset by id instead
   * would re-read the roster, and a composition file edited since the parent
   * started would hand the child a DIFFERENT generation than the one its
   * parent's history was produced under (and a preset deleted since would fail
   * the child outright while its parent keeps running).
   *
   * Synchronous, and with no composition failure mode of its own — it reads no
   * roster, mounts nothing, and touches no file — which is what lets a child
   * creation window use it: the two in-process subagent drivers compose their
   * children inside a synchronous `setup`. It still rejects a caller error, as
   * the `@throws` below record.
   *
   * A parent that joined no preset — a rosterless deployment — yields no join
   * and no error: there, the model-facing rows sit in the host composition and
   * the child already sees them through the global layer.
   * @param agentCtx - the joining agent's scope context.
   * @param parentCtx - the scope context of the agent whose composition to join.
   * @returns the preset id joined, or undefined when the parent joined none.
   * @throws when `agentCtx` carries no scope, or has already joined a preset.
   */
  composeFrom(agentCtx: Context, parentCtx: Context): string | undefined {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const standing = standingMountFor(parentCtx)
    if (standing === undefined) return undefined
    const generation = this.declaredGenerations.get(standing.key)
    if (generation !== undefined) {
      this.joinDeclared(agentCtx, agentKey, generation)
      return standing.presetId
    }
    this.bindings.set(agentKey, { parent: bindScopeParent(agentKey, standing.key) })
    return standing.presetId
  }

  /**
   * The preset one live agent runs on.
   *
   * Read from the live scope chain rather than from the session, so it answers
   * for an agent whose session has not recorded a preset yet — a child agent
   * whose durable header is being built from its parent's composition.
   * @param agentCtx - the agent's scope context.
   * @returns the preset id, or undefined when the agent joined none.
   */
  composedPreset(agentCtx: Context): string | undefined {
    return standingMountFor(agentCtx)?.presetId
  }

  /**
   * The roots this roster scans, which is not `config.roots`: it is every
   * configured root in order, then the harness-home user root unless
   * `includeUserRoot` is false. Read this — not the config field — to answer
   * whether a roster is composed at all, so one derivation decides it.
   */
  get roots(): readonly PresetRoot[] {
    return this.resolvedRoots
  }

  /** Whether this deployment has a root locally authored presets go to. */
  get authorable(): boolean {
    return this.resolvedRoots.some(root => root.trust === 'user')
  }

  /**
   * The roster with the authoring capability this caller may use.
   *
   * Read addressing only: the roster itself is deployment-wide, while
   * `authorable` reports what the CALLER may write — a project member without
   * manage rights reads `false` even when a writable root exists, matching the
   * enforcement the privileged authoring Remote methods apply. The authority
   * is re-captured inside the call because the wire carrier, not this service,
   * owns request scope.
   * @returns the presets and the caller-scoped authoring hint.
   */
  @Remote('list')
  async remoteExportList(): Promise<AgentPresetRoster> {
    const collaboration = this.ctx.get('collaboration')
    let authority: CollaborationAuthority | undefined
    try {
      authority = collaboration?.capture()
    } catch (error: unknown) {
      throw collaborationRemoteRefusal(error, 'read')
    }
    const projectManager = authority?.participant.scope.kind === 'project'
      && authority.participant.scope.canManage === true
    // Keep the visible policy and marked default from the same settings
    // snapshot even when discovery yields while settings are hot-reloaded.
    const policy = this.selectionPolicy()
    return {
      presets: (await this.list()).map(preset => ({
        id: preset.id,
        trust: preset.trust,
        isDefault: preset.id === policy.defaultId,
        ...preset.name === undefined ? {} : { name: preset.name },
        ...preset.description === undefined ? {} : { description: preset.description },
        ...preset.broken === undefined ? {} : { broken: preset.broken },
      })),
      authorable: (authority?.participant.scope.kind !== 'project' || projectManager) && this.authorable,
      modeSelectionEnabled: policy.enabled,
    }
  }

  /**
   * One preset's composition text with the roster row it belongs to.
   * @param agentPreset - the preset id.
   * @returns the composition beside its trust and published metadata.
   * @throws {RemoteError} `gateway/bad-request` for an empty id, or
   * `agent-preset/not-found` when no configured root supplies it.
   */
  @Remote('read')
  async readDocument(agentPreset: string): Promise<AgentPresetDocument> {
    validatePresetId(agentPreset, 'agentPreset')
    try {
      const preset = await this.resolve(agentPreset)
      return {
        agentPreset: preset.id,
        trust: preset.trust,
        content: await this.read(preset.id),
        ...preset.name === undefined ? {} : { name: preset.name },
        ...preset.description === undefined ? {} : { description: preset.description },
      }
    } catch (error: unknown) {
      throw this.presetRefusal(agentPreset, error)
    }
  }

  /**
   * Copy one preset through the Remote API.
   * @param from - the source preset id.
   * @param id - the new preset id.
   * @param name - the copy's optional display name.
   * @returns once the copy is stored.
   * @throws {RemoteError} with the corresponding stable preset code and
   * details when the copy is refused.
   */
  @Remote('copy')
  async remoteExportCopy(from: string, id: string, name?: string): Promise<void> {
    validatePresetId(from, 'from')
    validatePresetId(id, 'agentPreset')
    try {
      await this.copy(from, id, name)
    } catch (error: unknown) {
      throw this.presetRefusal(id, error)
    }
  }

  /**
   * Delete one preset through the Remote API.
   * @param id - the preset id.
   * @returns once the preset is deleted.
   * @throws {RemoteError} with the corresponding stable preset code and
   * details when deletion is refused.
   */
  @Remote('deletePreset')
  async remoteExportDelete(id: string): Promise<void> {
    validatePresetId(id, 'agentPreset')
    try {
      await this.remove(id)
    } catch (error: unknown) {
      throw this.presetRefusal(id, error)
    }
  }

  /**
   * Switch one agent's preset through the Remote API.
   *
   * Recomposing is limited to a session with no visible conversation content
   * because its history is produced under its preset's tools; the agent and
   * the session survive, only the composition is swapped. A Session whose log
   * records the preset and whose Agent runs its current generation keeps its
   * composition; nothing is logged or announced. Switches on one session queue
   * so a stale blankness read cannot interleave two swaps.
   * @param agent - exact live agent whose composition is swapped.
   * @param agentPreset - the preset to compose instead.
   * @returns the preset id that was recorded.
   * @throws {RemoteError} with `gateway/bad-request`, `agent-preset/locked`,
   * `agent-preset/not-found`, or `agent-preset/invalid` when refused.
   */
  @Remote('select')
  async select(agent: Agent, agentPreset: string): Promise<string> {
    validatePresetId(agentPreset, 'agentPreset')
    const queued = this.switches.get(agent.id) ?? Promise.resolve()
    const turn = queued.then(() => this.swap(agent, agentPreset))
    const guard = turn.catch(() => undefined)
    this.switches.set(agent.id, guard)
    try {
      return await turn
    } finally {
      if (this.switches.get(agent.id) === guard) this.switches.delete(agent.id)
    }
  }

  /** One queued switch: re-check, recompose, then record what the agent runs. */
  private async swap(agent: Agent, agentPreset: string): Promise<string> {
    // Re-read inside the queue: an earlier switch may have run, and visible
    // content may have arrived, since this call was queued. Standalone plugin
    // events and empty turns keep a fresh session blank.
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = agent.session.snapshotEvents()
    if (events.some(hasConversationContent)) {
      throw new RemoteError(
        'agent-preset/locked',
        `session "${agent.id}" has already started; its agent preset is fixed`,
        { sessionId: agent.id, agentPreset },
      )
    }
    // A Session whose log records the preset and whose Agent runs its current
    // generation keeps its composition; nothing is logged or announced. An
    // unscoped agent cannot prove either half, so it always recomposes.
    const agentKey = scopeOf(agent.ctx)
    if (agentKey !== undefined && resolveSessionPreset({ header: agent.session.header, events }) === agentPreset) {
      const preset = await this.resolveMountable(agentPreset)
      const parent = scopeParentOf(agentKey)
      const realm = parent !== undefined && 'realm' in parent && typeof parent.realm === 'string'
        ? parent.realm
        : undefined
      const currentKey = this.declarations.get(preset.id)?.generations.get(realm)?.key ??
        (await this.standing.get(preset.id)?.get(realm))?.key
      if (currentKey !== undefined && parent === currentKey) return agentPreset
    }
    try {
      const preset = await this.recompose(agent.ctx, agentPreset)
      // Recorded only after the swap committed: the log states what the agent
      // runs, and a rejected mount leaves the previous composition.
      agent.session.append('agent-preset/selected', { agentPreset: preset.id })
      return preset.id
    } catch (error: unknown) {
      throw this.presetRefusal(agentPreset, error)
    }
  }

  /** Map one domain refusal onto its stable wire code; unexpected failures stay internal. */
  private presetRefusal(agentPreset: string, error: unknown): RemoteError {
    if (error instanceof UnknownPresetError) {
      return new RemoteError('agent-preset/not-found', error.message, {
        agentPreset: error.presetId, available: [...error.available],
      })
    }
    if (error instanceof PresetNotWritableError) {
      return new RemoteError('agent-preset/read-only', error.message, {
        agentPreset: error.presetId, reason: error.message,
      })
    }
    if (error instanceof InvalidPresetIdError || error instanceof PresetExistsError) {
      return new RemoteError('agent-preset/invalid', error.message, {
        agentPreset: error.presetId, reason: error.message,
      })
    }
    if (error instanceof PresetMountError) {
      return new RemoteError('agent-preset/invalid', error.message, {
        agentPreset: error.presetId, reason: error.reason,
      })
    }
    return new RemoteError('gateway/internal', `agent preset "${agentPreset}": ${String(error)}`, {}, { cause: error })
  }

  /**
   * Read one preset's composition text.
   * @param id - the preset id.
   * @returns the composition exactly as stored.
   * @throws when no configured root supplies that id.
   */
  async read(id: string): Promise<string> {
    const preset = await this.resolve(id)
    const record = this.declarations.get(preset.id)
    if (record !== undefined) {
      return dump({ plugins: record.config.plugins }, { schema: entryListSchema })
    }
    return await readComposition(preset as FileAgentPreset)
  }

  /**
   * Create a locally authored preset by copying an existing one whole.
   *
   * Copy is the only authoring write. Composition text never crosses this
   * seam: the source is named by id and its directory is copied as it stands,
   * so the copy is exactly as loadable as its source and authoring grants no
   * capability the roster did not already carry. The copy is NOT mounted to
   * validate — a source that mounts today yields a copy that mounts today.
   * @param from - the preset the copy starts from; shipped presets are the
   * primary source, so any trust is accepted.
   * @param id - the new preset's id, which becomes its directory name.
   * @param name - display name for the copy; absent falls back to the id.
   * @throws when the source is unknown, the id is unusable or already taken,
   * or the deployment configures no writable root.
   */
  async copy(from: string, id: string, name?: string): Promise<void> {
    const source = await this.resolve(from)
    // The roster check refuses ids any root supplies — shipped ones included,
    // since a user directory named like a shipped preset is shadowed by it.
    // The disk check inside copyComposition only sees the writable root.
    if ((await this.list()).some(preset => preset.id === id)) {
      throw new PresetExistsError(id)
    }
    if (source.path === undefined) {
      throw new PresetNotWritableError(from, 'it is declared by a plugin')
    }
    await copyComposition(this.resolvedRoots, source as FileAgentPreset, id, name)
    // A settled mount under this id can only be stale (its preset was deleted
    // from disk outside `remove`); the new preset must not inherit it. Every
    // session already joined keeps the generation it runs on regardless.
    this.standing.delete(id)
  }

  /**
   * Delete a locally authored preset.
   * @param id - the preset id.
   * @throws when the preset is unknown or ships with the deployment.
   */
  async remove(id: string): Promise<void> {
    const preset = await this.resolve(id)
    if (preset.path === undefined) {
      throw new PresetNotWritableError(id, preset.trust === 'system'
        ? 'it ships with the deployment'
        : 'it is declared by a plugin')
    }
    await deleteComposition(this.resolvedRoots, preset as FileAgentPreset)
    // Sessions on the deleted preset keep their standing mount; only new
    // sessions see the roster without it.
    this.standing.delete(id)
    // Storing a default that does not exist YET is deliberate — the roster is a
    // live directory, so a name absent now may exist by the time a session asks
    // for it, and `resolve` reports it then. A default this call just deleted is
    // not that case: nothing will ever supply it again, and left in place every
    // session created without an explicit pick would fail to start. Clearing it
    // exposes the deployment's own default underneath, which is the layering.
    if (this.settings?.get().default !== id) return
    await this.settingsService?.mutate(
      settingsNamespace(SETTINGS_NAMESPACE),
      [{ op: 'unset', path: ['default'] }],
    )
  }

  /**
   * One agent's instance of a service its preset mounted.
   *
   * A preset publishes services behind `isolate` realms, which are invisible
   * outside the group that declares them — including to the host. This is how a
   * caller holding the agent reads one anyway: a request that is ABOUT a
   * session but arrives from outside it, which is every browser RPC.
   *
   * Read addressing only. A host row that `inject`s a service cannot use this,
   * because injection resolves before any session exists and has no agent to
   * key by; such a service belongs on the host plane instead.
   * @param agent - the agent whose composition to look inside.
   * @param name - the service name as the preset's rows resolve it.
   * @returns the agent's instance, or undefined when its preset mounts none.
   */
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined {
    return serviceForAgent(this.ctx, agent, name)
  }

  /**
   * Inspect the composition trees this roster mounted, or the one an agent
   * runs on.
   * @param ctx - an agent's scope context, or undefined for every live mount.
   * @returns preset ids with the plugins their trees activated.
   */
  async inspectCompositions(ctx?: Context): Promise<AgentPresetInspection[]> {
    const report = (mount: PresetMount): Promise<AgentPresetInspection> => Promise.resolve({
      id: mount.presetId,
      modules: mount.tree !== undefined ? activeCompositionModules(mount.tree) : [],
      leakedServices: leakedServices(mount.fiber.ctx, mount.fiber),
    })
    if (ctx !== undefined) {
      const mount = standingMountFor(ctx)
      return mount === undefined ? [] : [await report(mount)]
    }
    const mounts = livePresetMounts(this.ctx.root.fiber).filter(mount => mount.tree !== undefined)
    return await Promise.all(mounts.map(report))
  }

  /**
   * Re-link one agent to a different preset's standing composition.
   *
   * Only valid while the agent has produced nothing: swapping tools mid
   * conversation would leave logged tool calls the new composition cannot
   * make. The CALLER owns that check — this method does not read session
   * history.
   *
   * The swap is a parent re-link, not an unmount: standing mounts are shared
   * and permanent, so the old composition stays for its other agents and the
   * new one is ensured BEFORE the link moves. An unknown or unusable preset
   * therefore throws with the agent exactly as it was — there is no torn-down
   * state to restore. The re-link runs through the binding this roster kept
   * from the agent's mount — dsh-scope's only re-link authority. An agent
   * that never composed one has nothing to re-link: the switch is then the
   * agent's first bind, exactly a mount.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset to compose the agent from instead.
   * @returns the preset now installed.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async recompose(agentCtx: Context, id: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to recompose an unscoped context')
    }
    const preset = await this.resolveMountable(id)
    // The current parent carries the realm the agent runs in, so a preset
    // switch re-ensures a generation under the SAME realm: an SSH-bound
    // session may swap its tool set but never its execution environment.
    const parent = scopeParentOf(agentKey)
    const realm = parent !== undefined && 'realm' in parent && typeof parent.realm === 'string' ? parent.realm : undefined
    const declared = this.declarations.get(preset.id)
    if (declared !== undefined) {
      const generation = await this.retainDeclared(declared, realm)
      await this.bindDeclared(agentCtx, agentKey, generation)
      agentCtx.emit('agent-preset/recomposed')
      return preset
    }
    const standing = await this.ensureStanding(preset as FileAgentPreset, realm)
    const binding = this.bindings.get(agentKey)
    if (binding === undefined) {
      this.bindings.set(agentKey, { parent: bindScopeParent(agentKey, standing.key) })
    } else {
      binding.parent.rebind(standing.key)
      const released = binding.generation
      if (released !== undefined) {
        delete binding.generation
        released.users--
        await this.collectDeclared(released)
      }
    }
    // Scope re-linking changes inherited registries without changing a tool
    // registration itself. Notify consumers that reconcile Agent-owned rows
    // after the new chain is live.
    agentCtx.emit('agent-preset/recomposed')
    return preset
  }

  /**
   * The standing scope key of one preset, for a host reader with no agent.
   *
   * A cold transcript read resolves tool presenters against the composition
   * the session recorded, and the standing mount makes that possible without
   * resuming anything: ensuring the mount composes plugins but starts no
   * agent, no session, and no turn.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the standing scope key readers pass as a registry view scope.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async standingKeyFor(id?: string): Promise<ScopeKey> {
    const preset = await this.resolveMountable(id)
    const record = this.declarations.get(preset.id)
    if (record !== undefined) {
      const generation = await this.retainDeclared(record)
      generation.users--
      await this.collectDeclared(generation)
      return generation.key
    }
    return (await this.ensureStanding(preset as FileAgentPreset)).key
  }

  /**
   * Acquire the standing scope one preset composes under.
   *
   * The returned lease is a read boundary, not a mount: release it when the
   * cold read ends so a retired generation can collect.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the scope key and its release.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async acquireScope(id?: string): Promise<{ key: ScopeKey; dispose: () => Promise<void> }> {
    const preset = await this.resolveMountable(id)
    const record = this.declarations.get(preset.id)
    if (record !== undefined) {
      const generation = await this.retainDeclared(record)
      return {
        key: generation.key,
        dispose: async () => {
          generation.users--
          await this.collectDeclared(generation)
        },
      }
    }
    return { key: (await this.ensureStanding(preset as FileAgentPreset)).key, dispose: async () => {} }
  }

  /**
   * Install the environment hook one realm key resolves to.
   *
   * The hook runs inside each NEW standing generation created under `realm`,
   * before the preset subtree loads, so provider registrations it makes are
   * what the composition's rows resolve. Re-registering replaces the hook for
   * future generations; live generations keep the environment they mounted.
   * @param realm - the realm key `mount()` callers name.
   * @param mount - environment installer for a fresh standing scope.
   * @returns a disposer that unregisters the hook; generations already
   *   mounted are unaffected.
   */
  registerRealm(realm: string, mount: StandingRealmHook): () => void {
    this.realms.set(realm, mount)
    return () => {
      if (this.realms.get(realm) === mount) this.realms.delete(realm)
    }
  }

  /**
   * Drop every standing generation created under `realm`.
   *
   * Invalidation retires the POINTER only — joined agents keep the mounted
   * subtree, whose providers fail closed on their own — so the next join
   * re-runs the realm hook and re-resolves the environment's admission. An
   * SSH revocation uses this: the dead generation stops accepting new
   * sessions while the already-joined ones unwind through their own
   * teardown.
   * @param realm - the realm key to retire.
   */
  invalidateRealm(realm: string): void {
    for (const generations of this.standing.values()) {
      generations.delete(realm)
    }
  }

  /**
   * Register and eagerly activate one declared preset.
   * @param definition - parsed configuration supplied by the declaring plugin.
   * @returns definition disposer after activation or its diagnostic settles;
   * the declaring plugin owns it.
   */
  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    if (!definition.id.trim()) throw new Error('Preset id must not be empty')
    if (this.declarations.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
    const record: DeclaredRecord = {
      config: definition,
      context: this.selfCtx,
      ready: Promise.resolve(undefined),
      generations: new Map(),
    }
    this.declarations.set(definition.id, record)
    let disposed = false
    const unregister = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      this.declarations.delete(definition.id)
      await record.ready
      for (const generation of record.generations.values()) {
        generation.retired = true
        await this.collectDeclared(generation)
      }
    }
    record.ready = this.activateDeclared(record, undefined)
    await record.ready
    return unregister
  }

  private async activateDeclared(record: DeclaredRecord, realm: string | undefined): Promise<DeclaredGeneration | undefined> {
    const key: ScopeKey = realm === undefined ? { agentPreset: record.config.id } : { agentPreset: record.config.id, realm }
    const scope = createScope(this.selfCtx, key)
    try {
      const problem = entryListProblem(record.config.plugins)
      if (problem !== undefined) throw new Error(problem)
      if (realm !== undefined) {
        const environment = this.realms.get(realm)
        if (environment === undefined) throw new Error(`agent-presets: unknown standing realm "${realm}"`)
        await environment(scope.ctx)
      }
      const context = scope.ctx.extend({ baseUrl: record.context.baseUrl })
      const mount = await mountDefinition(context, record.config.id, record.config.plugins)
      const generation: DeclaredGeneration = { scope, key, mount, users: 0, retired: false }
      record.generations.set(realm, generation)
      this.declaredGenerations.set(key, generation)
      return generation
    } catch (error) {
      record.broken = (error as Error).message
      this.selfCtx.logger.warn(`agent preset ${record.config.id}: ${record.broken}`)
      await scope.dispose()
      return undefined
    }
  }

  /**
   * Current activation diagnostic of a declared record. A mount failure is
   * final; a mounted tree is re-audited on read because rows waiting on a
   * Host service activate once that provider settles.
   */
  private async declaredDiagnostic(record: DeclaredRecord): Promise<string | undefined> {
    await record.ready
    const generation = record.generations.get(undefined)
    if (generation === undefined) return record.broken
    const tree = generation.mount.tree
    if (tree === undefined) return record.broken
    let audit = await auditRows(tree)
    if (audit.pending.length > 0) {
      await this.selfCtx.loader.await()
      audit = await auditRows(tree)
    }
    const lines = [...audit.failed, ...audit.pending]
    return lines.length === 0 ? undefined : lines.join('\n')
  }

  /** Dispose a retired declared generation once its last user is gone. */
  private async collectDeclared(generation: DeclaredGeneration): Promise<void> {
    if (!generation.retired || generation.users !== 0) return
    this.declaredGenerations.delete(generation.key)
    await generation.scope.dispose()
  }

  /** Ensure the declared record's generation under `realm`, audited and user-counted. */
  private async retainDeclared(record: DeclaredRecord, realm?: string): Promise<DeclaredGeneration> {
    let generation = record.generations.get(realm)
    if (generation === undefined) {
      generation = await this.activateDeclared(record, realm)
      if (generation === undefined) {
        const reason = record.broken ?? 'the declared composition failed to mount'
        throw new PresetMountError(record.config.id, reason)
      }
    }
    generation.users++
    return generation
  }

  /** Join `ctx`'s scope to a declared generation; agent teardown releases its user count. */
  private joinDeclared(ctx: Context, key: ScopeKey, generation: DeclaredGeneration): void {
    const binding = { parent: bindScopeParent(key, generation.key), generation }
    generation.users++
    this.bindings.set(key, binding)
    ctx.effect(() => async () => {
      if (this.bindings.get(key) !== binding) return
      this.bindings.delete(key)
      generation.users--
      await this.collectDeclared(generation)
    }, 'agent-preset.binding')
  }

  /** Bind `ctx` to a declared generation, releasing any generation it leaves. */
  private async bindDeclared(ctx: Context, key: ScopeKey, generation: DeclaredGeneration): Promise<void> {
    const binding = this.bindings.get(key)
    if (binding?.generation === generation) return
    if (binding !== undefined) {
      binding.parent.rebind(generation.key)
      const released = binding.generation
      generation.users++
      binding.generation = generation
      if (released !== undefined) {
        released.users--
        await this.collectDeclared(released)
      }
      return
    }
    this.joinDeclared(ctx, key, generation)
  }

  /** Resolve (or create, single-flight) the standing mount of one preset. */
  private async ensureStanding(preset: FileAgentPreset, realm?: string): Promise<StandingMount> {
    let generations = this.standing.get(preset.id)
    if (generations === undefined) {
      generations = new Map()
      this.standing.set(preset.id, generations)
    }
    const pending = generations.get(realm)
    if (pending !== undefined) {
      const mounted = await pending
      // Files are the only composition editor (authoring is copy/delete), so
      // the stamp is what notices an edit: a changed file starts the next
      // generation here, for this and later sessions. An unreadable stamp
      // serves the current generation — a mount must survive its file
      // disappearing, and failing the session over a stat would not.
      const current = await compositionStamp(preset.path)
      if (current === undefined || sameStamp(mounted.stamp, current)) return mounted
      // TODO: reclaim the superseded generation once the last agent joined to
      // it is gone. The subtree is not inert — `dsh-skill-filesystem` watches its
      // roots — and the settings-page authoring flow turns "a composition
      // changed" into a per-save event. This needs a joined-agent count on
      // StandingMount, incremented in `mount`/`composeFrom`/`recompose` and
      // decremented when the agent's scope key dies.
      // Guarded delete: a caller that raced this one may have already started
      // the next generation, and dropping THAT pointer would fork a third.
      if (generations.get(realm) === pending) generations.delete(realm)
      return this.ensureStanding(preset, realm)
    }
    const created = (async (): Promise<StandingMount> => {
      const key: ScopeKey = realm === undefined
        ? { agentPreset: preset.id }
        : { agentPreset: preset.id, realm }
      const scope = createScope(this.selfCtx, key)
      try {
        // Stamped before the file is read: an edit racing the mount makes the
        // stamp stale rather than silently current, so the next session
        // refreshes instead of trusting a composition older than its stamp.
        const stamp = await compositionStamp(preset.path)
        if (stamp === undefined) {
          throw new PresetMountError(preset.id, `composition file is unreadable: ${preset.path}`)
        }
        if (realm !== undefined) {
          const environment = this.realms.get(realm)
          if (environment === undefined) {
            throw new Error(`agent-presets: unknown standing realm "${realm}"`)
          }
          // The realm hook installs the environment the composition resolves
          // services from — SSH providers shadowing `fs`/`subprocess`/
          // `sandbox` — BEFORE the rows load, so their inject captures the
          // shadowed implementations rather than the host's.
          await environment(scope.ctx)
        }
        await mountPreset(scope.ctx, preset)
        return { key, scope, stamp }
      } catch (error) {
        await scope.dispose()
        throw error
      }
    })()
    generations.set(realm, created)
    // Guarded delete: a copy/remove may have cleared this pointer and a later
    // ensureStanding installed the next generation already — dropping THAT
    // pointer would fork a third standing mount.
    void created.catch(() => {
      if (generations.get(realm) === created) generations.delete(realm)
    })
    return created
  }
}

/** The composition file identity one standing generation was mounted from. */
interface CompositionStamp {
  /** Modification time in milliseconds, as `stat` reports it. */
  readonly mtimeMs: number
  /** File size in bytes, the tiebreak for edits within one mtime tick. */
  readonly size: number
}

/** Read one composition file's stamp, or undefined when it cannot be statted. */
async function compositionStamp(path: string): Promise<CompositionStamp | undefined> {
  try {
    const { mtimeMs, size } = await stat(path)
    return { mtimeMs, size }
  } catch {
    // Deleted, replaced by an unreadable entry, or otherwise unstattable all
    // mean the same to the caller: the file offers no identity to compare.
    return undefined
  }
}

/** Whether two stamps name the same file state. */
function sameStamp(a: CompositionStamp, b: CompositionStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/**
 * Environment installer for one registered standing realm.
 *
 * Runs inside a fresh standing scope before the preset subtree mounts, so
 * the services the composition's rows resolve — `fs`, `subprocess`,
 * `sandbox`, `ssh` — can be shadowed with realm-private providers. Throwing
 * or rejecting fails the generation; the scope is disposed and no agent can
 * join it.
 * @param scopeCtx - the standing scope context the preset mounts under.
 */
export type StandingRealmHook = (scopeCtx: Context) => unknown

/** One preset's standing composition. */
interface StandingMount {
  /** Scope key agents are parented to; also the mount's registration scope. */
  readonly key: ScopeKey
  /** Disposal boundary; held for whole-tree teardown, never per-session. */
  readonly scope: Scope
  /** Stamp of the composition file this generation was mounted from. */
  readonly stamp: CompositionStamp
}

/** One plugin-declared preset's registration record. */
interface DeclaredRecord {
  /** The configuration the declaring plugin validated. */
  config: PresetDefinition
  /** The declaring plugin's context; its `baseUrl` resolves row specifiers. */
  context: Context
  /** The default generation's activation, awaited by diagnostics and joins. */
  ready: Promise<DeclaredGeneration | undefined>
  /** Live generations by realm; absent means the mount is not or not yet. */
  generations: Map<string | undefined, DeclaredGeneration>
  /** Final mount failure reason, when activation rejected. */
  broken?: string
}

/** One mounted generation of a declared preset. */
interface DeclaredGeneration {
  /** Disposal boundary; released when retired and its last user leaves. */
  scope: Scope
  /** Scope key agents are parented to. */
  key: ScopeKey
  /** The registered mount under this generation. */
  mount: PresetMount
  /** Joined agents plus outstanding leases. */
  users: number
  /** Set once the declaring plugin unregisters. */
  retired: boolean
}

export default AgentPresetRegistry
