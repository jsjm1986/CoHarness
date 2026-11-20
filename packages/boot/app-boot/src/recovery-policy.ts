/** Sealed disaster-recovery composition, inspected without importing plugin code. */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import { bundlePatchPaths, createRuntimeResolution, readProfileManifest, resolveBundleDir } from './profile.ts'
import { barePackageName } from './profile-resolution/resolver.ts'
import { recoveryCanonical as canonical, recoveryHash as hash } from './recovery-digest.ts'
import { inspectRecoveryConnections, type RecoveryConnection } from './recovery-connections.ts'
import { recoveryArtifactHasher } from './recovery-artifacts.ts'
import { resolvePluginResource } from './package-meta.ts'

/** One exact entry and its installed package bytes approved for execution. */
export interface RecoveryRowApproval {
  readonly name: string
  readonly entrySha256: string
  readonly artifactSha256: string
  readonly configurationSha256: string
  /** Custom or changed entries seal their installed runtime dependency closure. */
  readonly dependencyClosure?: true
}
/** Local, content-addressed permission for a composed plugin tree. */
export interface RecoveryComposition {
  readonly version: 1
  readonly rows: readonly RecoveryRowApproval[]
  readonly connections?: readonly RecoveryConnection[]
}
/** Private node-local startup permission; the Gateway supplies its expected SHA-256 separately. */
export interface RecoveryPolicy {
  readonly version: 1
  readonly mode: 'new-conversations-only'
  readonly operationId: string
  readonly pointId: string
  readonly runtimeId: string
  readonly nodeId: string
  readonly writerEpoch: string
  readonly reviewRevision: string
  readonly oldSessionIds: readonly string[]
  readonly approvedItems: readonly string[]
  readonly compositionDigest: string
  readonly composition: RecoveryComposition
}
/** Administrator-visible inspection without configuration values or Session content. */
export interface RecoveryReviewItem extends RecoveryRowApproval {
  readonly id: string
  readonly kind: 'plugin' | 'external-connection'
  readonly itemDigest: string
  readonly status: 'suspended' | 'eligible' | 'approved'
  readonly reason?: string
}
/** Pure inspection result; callers persist the sealed composition only on its owning computer. */
export interface RecoveryInspection {
  readonly compositionDigest: string
  readonly composition: RecoveryComposition
  readonly items: readonly RecoveryReviewItem[]
  readonly blockers: readonly string[]
}
declare module '@deepseek-ai/cordis' {
  interface Context { /** Immutable permission installed before any restored plugin is imported. */ recoveryPolicy?: RecoveryPolicy }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function expressions(value: unknown, path = ''): Map<string, string> {
  const found = new Map<string, string>()
  if (!record(value) && !Array.isArray(value)) return found
  if (record(value) && typeof value.__jsExpr === 'string') return new Map([[path, value.__jsExpr]])
  for (const [key, child] of Object.entries(value)) for (const [at, code] of expressions(child, `${path}/${key}`)) found.set(at, code)
  return found
}
function normalized(row: EntryOptions): EntryOptions {
  const copy = structuredClone(row)
  if (row.name === '@deepseek-ai/dsh-agent-loop') copy.config = { ...(record(row.config) ? row.config : {}), agents: [] }
  if (row.name === 'cordis:group' && Array.isArray(row.config)) copy.config = []
  return copy
}
const permanentSuspension = (name: string): boolean =>
  /(?:cordis-host-runner|cordis-client-runner|plugin-manager|plugin-market|tool-cordis)/.test(name)
const optionalExecution = (name: string): boolean => /(?:schedule|remote-desktop|computer-use)/.test(name)
function localModule(name: string, parentURL: string): string {
  if (name.startsWith('file:')) return realpathSync(fileURLToPath(name))
  try { return realpathSync(resolvePluginResource(name, parentURL)) } catch {
    // Offline inspectors have no installed Loader; Node's literal package resolver reads the installed artifact.
    return realpathSync(createRequire(parentURL).resolve(name))
  }
}
/** Inputs whose trusted rows come only from the current installation, never the restored profile. */
export interface RecoveryCompositionInput {
  readonly entries: readonly EntryOptions[]
  readonly trustedEntries: readonly EntryOptions[]
  readonly parentURL: string
  readonly approvedItems?: readonly string[]
  readonly cwd?: string
  /** Resolve bytes without evaluating the module; embedders use their actual installed resolver. */
  readonly resolveModule?: (name: string, parentURL: string) => string
  /** Resolve the independently installed artifact, never a restored profile's same-name package. */
  readonly resolveTrustedModule: (name: string) => string
  /** Gateway-owned package copies whose complete bytes must match the independently installed materialization. */
  readonly trustedMaterializedModules?: readonly string[]
}
/** Inspect effective rows before Loader can evaluate expressions or import code.
 * @param input Effective configuration and independently owned installation rows.
 * @returns Exact approved entry digests and suspended capabilities; no plugin is imported or started.
 */
export function inspectRecoveryComposition(input: RecoveryCompositionInput): RecoveryInspection {
  const resolveModule = input.resolveModule ?? localModule
  const approved = new Set(input.approvedItems)
  const trusted = new Map<string, EntryOptions[]>()
  const flatten = (rows: readonly EntryOptions[]): EntryOptions[] => rows.flatMap(row => row.group === true || row.name === 'cordis:group'
    ? Array.isArray(row.config) ? [row, ...flatten(row.config as EntryOptions[])] : [row] : [row])
  for (const row of flatten(input.trustedEntries)) trusted.set(row.name, [...trusted.get(row.name) ?? [], normalized(row)])
  const artifact = recoveryArtifactHasher()
  const items: RecoveryReviewItem[] = []
  const rows: RecoveryRowApproval[] = []
  const connections: RecoveryConnection[] = []
  for (const original of flatten(input.entries)) {
    const row = normalized(original)
    let reason: string | undefined
    let manual = false
    const reference = trusted.get(row.name)
    const requestedExpressions = expressions(row)
    if (row.name === 'cordis:include' || row.name === '@deepseek-ai/cordis-plugin-include') reason = 'include-unverifiable'
    else if (permanentSuspension(row.name) || row.group === true && row.name !== 'cordis:group') reason = 'dynamic-composition-unverifiable'
    else if ([...requestedExpressions].some(([path, code]) => !reference?.some(base => expressions(base).get(path) === code))) reason = 'expression-unverifiable'
    else if (reference === undefined || !reference.some(base => canonical(base) === canonical(row))) manual = true
    let artifactSha256 = ''
    let dependencyClosure = manual
    if (reason === undefined && row.name === 'cordis:group') artifactSha256 = hash('cordis:group:recovery-v1')
    else if (reason === undefined) {
      try {
        const file = resolveModule(row.name, input.parentURL)
        artifactSha256 = artifact(file)
        if (reference !== undefined) {
          try {
            const trustedFile = input.resolveTrustedModule(row.name)
            const materialized = input.trustedMaterializedModules?.includes(row.name) === true
            const trustedDigest = artifact(trustedFile, false, materialized)
            if (artifactSha256 !== trustedDigest || !materialized && realpathSync(file) !== realpathSync(trustedFile)) manual = true
          } catch { manual = true }
        }
        dependencyClosure = manual
        if (dependencyClosure) artifactSha256 = artifact(file, true)
      } catch { reason = 'artifact-unavailable' }
    }
    const entrySha256 = hash(canonical(row)), configurationSha256 = hash(canonical(row.config))
    const proof: RecoveryRowApproval = {
      name: row.name, entrySha256, artifactSha256, configurationSha256, ...dependencyClosure ? { dependencyClosure: true } : {},
    }
    const itemDigest = hash(canonical(proof))
    const optional = manual || optionalExecution(row.name) || /(?:hooks?|session-telemetry|plugin-package-inventory)/.test(row.name)
    const status = reason !== undefined || row.disabled === true ? 'suspended' : optional && !approved.has(itemDigest) ? 'eligible' : 'approved'
    const publicName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(row.name) || row.name === 'cordis:group' ? row.name : `custom-plugin:${hash(row.name).slice(0, 12)}`
    const item: RecoveryReviewItem = { ...proof, name: publicName, id: itemDigest, kind: /(?:remote-desktop|computer-use)/.test(row.name) ? 'external-connection' : 'plugin', itemDigest, status,
      ...reason === undefined ? status === 'eligible' ? { reason: reference === undefined ? 'custom-plugin-review-required' : 'execution-review-required' } : {} : { reason } }
    items.push(item)
    if (reason === undefined) {
      const targets = inspectRecoveryConnections(row, item, input.cwd, approved)
      connections.push(...targets.connections); items.push(...targets.items)
    }
    if (status === 'approved') rows.push(proof)
  }
  const unique = <T extends { entrySha256: string; name: string }>(values: T[]): T[] => [...new Map(values.map(row => [`${row.name}:${row.entrySha256}`, row])).values()]
  const composition: RecoveryComposition = {
    version: 1, rows: unique(rows),
    ...connections.length === 0 ? {} : { connections: [...new Map(connections.map(item => [canonical(item), item])).values()] },
  }
  return {
    composition, compositionDigest: hash(canonical(composition)),
    items: [...new Map(items.map(item => [item.itemDigest, item])).values()], blockers: [],
  }
}

/** Apply a sealed approval to detached rows; rejected rows cannot evaluate `!!js` or import their module.
 * @param ctx Context carrying the launch-time permission.
 * @param entries Profile or preset tree before import.
 * @param parentURL Exact module-resolution base.
 * @returns Sanitized rows; ordinary processes retain their original configuration.
 */
export function prepareRecoveryEntries(ctx: Context, entries: readonly EntryOptions[], parentURL: string): EntryOptions[] {
  const policy = ctx.get('recoveryPolicy')
  if (policy === undefined) return structuredClone(entries) as EntryOptions[]
  const approved = new Map(policy.composition.rows.map(row => [`${row.name}:${row.entrySha256}`, row]))
  const artifact = recoveryArtifactHasher()
  const visit = (original: EntryOptions): EntryOptions => {
    const row = normalized(original)
    const expected = approved.get(`${row.name}:${hash(canonical(row))}`)
    if (expected === undefined) return { ...row, disabled: true, group: false, config: undefined }
    if (row.name === 'cordis:group' && Array.isArray(original.config)) {
      if (expected.artifactSha256 !== hash('cordis:group:recovery-v1')) throw new Error('Recovery group permission is invalid')
      row.config = (original.config as EntryOptions[]).map(visit)
      return row
    }
    if (row.group === true) return { ...row, disabled: true, group: false, config: undefined }
    let file: string
    try { file = localModule(row.name, parentURL) } catch (error) {
      const profile = ctx.get('profileContext')
      if (profile === undefined) throw error
      file = localModule(row.name, pathToFileURL(profile.installAnchor).href)
    }
    const actual = artifact(file, expected.dependencyClosure === true)
    if (actual !== expected.artifactSha256) throw new Error(`Recovery plugin artifact changed: ${row.name}`)
    return row
  }
  return entries.map(visit)
}

function isRecoveryPolicy(value: unknown): value is RecoveryPolicy {
  const nonempty = (entry: unknown): entry is string => typeof entry === 'string' && entry.length > 0
  if (!record(value) || value.version !== 1 || value.mode !== 'new-conversations-only'
    || !['operationId', 'pointId', 'runtimeId', 'nodeId', 'compositionDigest'].every(key => nonempty(value[key]))
    || typeof value.writerEpoch !== 'string' || !/^[1-9]\d*$/.test(value.writerEpoch) || BigInt(value.writerEpoch) > 9223372036854775807n
    || typeof value.reviewRevision !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.reviewRevision)
    || !Array.isArray(value.oldSessionIds) || !value.oldSessionIds.every(nonempty)
    || !Array.isArray(value.approvedItems) || !value.approvedItems.every(nonempty)
    || !record(value.composition) || value.composition.version !== 1 || !Array.isArray(value.composition.rows)
    || !value.composition.rows.every(row => record(row) && nonempty(row.name)
      && ['entrySha256', 'artifactSha256', 'configurationSha256'].every(key => typeof row[key] === 'string' && /^[a-f0-9]{64}$/.test(row[key]))
      && (row.dependencyClosure === undefined || row.dependencyClosure === true))
    || value.composition.connections !== undefined && (!Array.isArray(value.composition.connections)
      || !value.composition.connections.every(item => record(item) && (item.kind === 'mcp' || item.kind === 'hook') && nonempty(item.id)
        && typeof item.configurationSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.configurationSha256)))
    || hash(canonical(value.composition)) !== value.compositionDigest) return false
  return true
}

/** Read and authenticate a node-private policy before any plugin import.
 * @param filename Node-private JSON file.
 * @param expectedSha256 Digest supplied through the authenticated launch channel.
 * @returns Validated startup permission.
 */
export function readRecoveryPolicy(filename: string, expectedSha256: string): RecoveryPolicy {
  const bytes = readFileSync(filename)
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || hash(bytes) !== expectedSha256) throw new Error('Recovery policy digest does not match the authorized launch')
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (!isRecoveryPolicy(value)) throw new Error('Recovery policy is invalid')
  return value
}
/** Install immutable recovery composition permission before the root Loader tree mounts.
 * @param ctx Bootstrap-owned context.
 * @param policy Authenticated node-private permission.
 * @param installAdmission Installs the required old-Session execution restriction before composition permission is published.
 */
export function installRecoveryPolicy(
  ctx: Context, policy: RecoveryPolicy, installAdmission: (ctx: Context, ids: readonly string[]) => void,
): void {
  if (typeof installAdmission !== 'function') throw new Error('Recovery requires Session execution admission before plugin imports')
  const copy = structuredClone(policy)
  const freeze = (value: unknown): void => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } }
  freeze(copy)
  installAdmission(ctx, copy.oldSessionIds)
  ctx.effect(() => ctx.provide('recoveryPolicy', copy), 'recovery composition permission')
}

/** Parse a file-backed preset as inert rows for the recovery preflight.
 * @param filename Static YAML or JSON preset file.
 * @returns Literal entry rows; no plugin or expression is evaluated.
 */
export function readRecoveryPresetEntries(filename: string): EntryOptions[] {
  const parsed: unknown = load(readFileSync(filename, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error('Recovery preset must contain a static entry list')
  return parsed as EntryOptions[]
}

/** Filesystem-only profile inspection inputs. Trusted files belong to the installation, not the restored home. */
export interface RecoveryProfileInput {
  readonly home: string
  readonly profileDir: string
  readonly installAnchor: string
  readonly trustedPatchFiles: readonly string[]
  readonly trustedPatchText?: string
  readonly trustedPackageDirectories?: readonly string[]
  readonly presetFiles?: readonly string[]
  readonly approvedItems?: readonly string[]
  readonly cwd?: string
}
/** Inspect a restored Web profile and the installation's presets without importing any plugin.
 * @param input Source locations and independent trusted installation patches.
 * @returns A permission for the inspected effective configuration and its review items.
 */
export async function inspectRecoveryProfile(input: RecoveryProfileInput): Promise<RecoveryInspection> {
  const patches = (text: string): PatchOptions[] => {
    const parsed: unknown = load(text, { schema: entryListSchema })
    if (!Array.isArray(parsed)) throw new Error('Recovery configuration must contain a patch list')
    return parsed as PatchOptions[]
  }
  const read = (file: string): PatchOptions[] => patches(readFileSync(file, 'utf8'))
  const trustedPatches = [
    ...input.trustedPatchFiles.flatMap(read), ...input.trustedPatchText === undefined ? [] : patches(input.trustedPatchText),
  ]
  const manifest = readProfileManifest('recovery', input.profileDir)
  const layers = (manifest.dsh?.profile?.bundles ?? []).map((name) => {
    const dir = resolveBundleDir('recovery', name, input.installAnchor, input.profileDir)
    const bundle = readProfileManifest('recovery', dir).dsh?.bundle
    if (bundle === undefined) throw new Error(`Recovery bundle has no static patch: ${name}`)
    const patchPaths = bundlePatchPaths(dir, bundle)
    return { packageName: name, packageDir: dir, patchPaths, patches: patchPaths.flatMap(read) }
  })
  const bundlePatches = layers.flatMap(layer => layer.patches)
  const resolution = await createRuntimeResolution({ installAnchor: input.installAnchor, home: input.home,
    profile: { name: basename(input.profileDir), dir: input.profileDir, layers, patchPath: join(input.profileDir, 'cordis.patch.yml'), patches: [], skippedBundles: [] } })
  const installed = new Map(resolution.entries.filter(entry => entry.scope === 'installation').map(entry => [entry.name, entry]))
  const resolved = new Map(resolution.entries.map(entry => [entry.name, entry]))
  const mapped = (name: string, trusted: boolean): string => {
    const entry = (trusted ? installed : resolved).get(barePackageName(name) ?? name)
    if (entry === undefined) throw new Error(`Recovery module has no installed resolution: ${name}`)
    return localModule(name, pathToFileURL(entry.declarer).href)
  }
  const actual = [...bundlePatches, ...[join(input.profileDir, 'cordis.patch.yml'), join(input.home, 'cordis.patch.yml')].flatMap(file => existsSync(file) ? read(file) : [])]
  const effective = applyEntryPatches([], actual, () => {})
  const derivePresetRoot = (rows: EntryOptions[]): void => {
    const registry = rows.find(row => row.id === 'agent-preset-registry')
    if (registry === undefined) return
    const config: unknown = registry.config ?? {}
    if (!record(config) || !Array.isArray(config.roots ?? [])) throw new Error('Recovery preset roots must be literal')
    registry.config = { ...config, roots: [{ path: join(dirname(input.installAnchor), 'config', 'agent-presets'), trust: 'system' }, ...(config.roots as unknown[] | undefined ?? [])] }
  }
  derivePresetRoot(effective)
  const presetRows = (input.presetFiles ?? []).flatMap(readRecoveryPresetEntries)
  const trustedEntries = [...applyEntryPatches([], trustedPatches, () => {}), ...presetRows]
  derivePresetRoot(trustedEntries)
  const parentURL = pathToFileURL(join(input.profileDir, 'package.json')).href
  const trustedDirectories = new Map((input.trustedPackageDirectories ?? []).map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; main?: string }
    return [pkg.name, join(dir, pkg.main ?? 'index.js')]
  }))
  const result = inspectRecoveryComposition({ entries: [...effective, ...presetRows], trustedEntries, parentURL,
    ...input.approvedItems === undefined ? {} : { approvedItems: input.approvedItems },
    ...input.cwd === undefined ? {} : { cwd: input.cwd },
    trustedMaterializedModules: [...trustedDirectories.keys()],
    resolveTrustedModule: name => trustedDirectories.get(name) ?? mapped(name, true),
    resolveModule: (name, parent) => {
      try { return localModule(name, parent) } catch { return mapped(name, false) }
    } })
  const runtime = effective.find(row => row.id === 'gateway-runtime')
  const required = ['agent', 'agent-loop', 'api-remotes', ...(record(runtime?.config) && Array.isArray(runtime.config.requiredPlugins)
    ? runtime.config.requiredPlugins as string[] : [])]
  const allowed = new Set(result.composition.rows.map(row => row.entrySha256))
  const blockers = required.filter(id => !effective.some(row => row.id === id && allowed.has(hash(canonical(normalized(row))))))
    .map(id => `Required recovery plugin is unavailable: ${id}`)
  if (!effective.some(row => ['@deepseek-ai/dsh-session-persistence-gateway', '@deepseek-ai/dsh-session-persistence-jsonl'].includes(row.name)
    && allowed.has(hash(canonical(normalized(row)))))) blockers.push('Recovery has no approved Session persistence provider')
  return { ...result, blockers }
}
