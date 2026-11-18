/** Manager configuration through a real profile, ConfigEditor, and Loader. */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import McpServerManager from '../src/index.ts'

type JsonObject = Record<string, unknown>

function merge(base: JsonObject, patch: JsonObject): JsonObject {
  const result: JsonObject = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const before = result[key]
    result[key] = before !== null && typeof before === 'object' && !Array.isArray(before)
      && value !== null && typeof value === 'object' && !Array.isArray(value)
      ? merge(before as JsonObject, value as JsonObject) : value
  }
  return result
}

function unsetPath(document: JsonObject, path: readonly string[]): void {
  const parent = path.slice(0, -1).reduce<unknown>((node, key) =>
    node !== null && typeof node === 'object' ? (node as JsonObject)[key] : undefined, document)
  if (parent !== null && typeof parent === 'object') Reflect.deleteProperty(parent, path[path.length - 1]!)
}

/** One `mutate` operation: `unset` removes the path; `set` writes it. */
export interface SettingsPathOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/**
 * Settings-form semantics over the local ConfigEditor: `update` merges into the
 * entry's raw config, `replace` merges onto the inherited layer, `mutate`
 * applies path operations, and `describe` reports a content revision for
 * optimistic-conflict checks. Upstream's dsh-settings SettingsForms service has
 * no local counterpart; the profile-patch write path it exercises is the same.
 */
export function settingsAdapter(ctx: Context) {
  const entryOf = (ns: string): Entry => {
    const entry = ctx.configEditor?.entries().find(row => row.options.id === ns)
    if (entry === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    return entry
  }
  const revisionOf = (entry: Entry): string => JSON.stringify(entry.options.config ?? {})
  const assertRevision = (current: JsonObject, expected?: string): void => {
    if (expected !== undefined && JSON.stringify(current) !== expected) {
      throw new Error('Plugin entry configuration changed since it was read')
    }
  }
  const edit = (ns: string, expected: string | undefined,
    change: (current: JsonObject, inherited: JsonObject) => JsonObject): Promise<void> =>
    ctx.configEditor.edit(entryOf(ns), (current, inherited) => {
      assertRevision(current, expected)
      return change(current, inherited)
    })
  return {
    /** Configurable entries with a content revision for optimistic-concurrency checks. */
    describe(): Array<{ ns: string; revision: string }> {
      return (ctx.configEditor?.entries() ?? []).map(entry => ({ ns: entry.options.id, revision: revisionOf(entry) }))
    },
    /** Deep-merge `patch` into the entry's effective configuration. */
    update(ns: string, patch: JsonObject, expectedRevision?: string): Promise<void> {
      return edit(ns, expectedRevision, current => merge(current, patch))
    },
    /** Rebase the entry on its inherited layer plus `section`, dropping prior live edits. */
    replace(ns: string, section: JsonObject, expectedRevision?: string): Promise<void> {
      return edit(ns, expectedRevision, (_current, inherited) => merge(inherited, section))
    },
    /** Apply ordered path operations (`set`/`unset`) to the entry's configuration. */
    mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: string): Promise<void> {
      return edit(ns, expectedRevision, (current, inherited) => {
        const next = structuredClone(current)
        // `unset` drops the user-layer value so the inherited layer shows
        // through under local shallow composition — merge restores it below.
        for (const op of ops) {
          if (op.op === 'unset') {
            unsetPath(next, op.path)
            continue
          }
          const parent = op.path.slice(0, -1).reduce<JsonObject>((node, key) => {
            const child = node[key]
            return (child !== null && typeof child === 'object' && !Array.isArray(child) ? child : node[key] = {}) as JsonObject
          }, next)
          parent[op.path[op.path.length - 1]!] = op.value !== undefined ? op.value : (op.path.reduce<unknown>((node, key) =>
            node !== null && typeof node === 'object' ? (node as JsonObject)[key] : undefined, inherited))
        }
        return merge(inherited, next)
      })
    },
  }
}

/** The settings-form adapter returned by {@link settingsAdapter}. */
export type SettingsAdapter = ReturnType<typeof settingsAdapter>

/**
 * Mount the manager from an inherited bundle and optional user patch.
 * @param ctx - Test context carrying tools and optional credentials.
 * @param options - Manager entry id, base configuration, and user overrides.
 * @returns The profile, manager entry, and settings adapter owned by the test.
 */
export async function managerProfile(ctx: Context, options: { id?: string; base?: unknown; user?: unknown } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-')))
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const context of contexts) await context.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profile')
  initProfile(dir, ['test-mcp-bundle'])
  const bundle = join(dir, 'node_modules', 'test-mcp-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-mcp-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  const id = options.id ?? 'mcp'
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id, name: 'cordis:mcp-manager', config: options.base ?? {} },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-mcp-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  if (options.user !== undefined) writeFileSync(profile.patchPath, JSON.stringify([{ id, config: options.user }]))
  const start = async (context: Context) => {
    contexts.push(context)
    context.baseUrl = pathToFileURL(home).href + '/'
    context.provide('profileContext', profile)
    await context.plugin(Loader)
    context.loader.builtins['mcp-manager'] = McpServerManager
    await context.plugin(ConfigEditor)
    await mountRootInclude(context, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
    await context.loader.await()
    return context.configEditor.entries().find(entry => entry.options.id === id)!
  }
  return { profile, entry: await start(ctx), start, settings: settingsAdapter(ctx) }
}
