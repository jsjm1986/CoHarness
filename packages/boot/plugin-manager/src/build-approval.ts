/** Approve pnpm's pending dependency scripts in the current profile's workspace settings. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml'
import { ManagementFailure } from './failure.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  allowBuildKeyFromIgnoredBuild,
  createAllowBuildFunction,
  UNDECIDED_ALLOW_BUILD,
  unapprovedIgnoredBuilds,
} from '@pnpm/building.policy'

type IgnoredBuilds = NonNullable<Parameters<typeof unapprovedIgnoredBuilds>[0]>

interface ScalarPolicy {
  readonly entries: Record<string, boolean | string>
  readonly keys: Set<string>
}

function scalarPolicy(builds: unknown): ScalarPolicy {
  const entries: Record<string, boolean | string> = {}
  const keys = new Set<string>()
  if (isMap(builds)) {
    for (const { key, value } of builds.items) {
      const name = isScalar(key) ? key.value : undefined
      const rule = isScalar(value) ? value.value : undefined
      if (typeof name !== 'string' || (typeof rule !== 'boolean' && typeof rule !== 'string')) {
        throw new Error('allowBuilds entries must map a string name to a boolean or string scalar')
      }
      keys.add(name)
      entries[name] = rule
    }
  }
  return { entries, keys }
}

async function readIgnoredBuilds(dir: string): Promise<string[]> {
  let text: string
  try { text = await readFile(join(dir, 'node_modules', '.modules.yaml'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const document = parseDocument(text)
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (!isMap(document.contents)) throw new Error('node_modules/.modules.yaml must be a YAML mapping')
  const ignored = document.get('ignoredBuilds')
  if (ignored === undefined) return []
  if (!isSeq(ignored)) throw new Error('node_modules/.modules.yaml ignoredBuilds must be a YAML sequence')
  const entries: string[] = []
  for (const item of ignored.items) {
    if (!isScalar(item) || typeof item.value !== 'string' || item.value.length === 0) {
      throw new Error('node_modules/.modules.yaml ignoredBuilds must hold non-empty strings')
    }
    entries.push(item.value)
  }
  return entries
}

/**
 * Persist the pending-build keys pnpm recorded into `allowBuilds` before
 * rollback or `node_modules` removal discards `.modules.yaml`. The caller
 * holds the profile manifest lock and pnpm has already exited; no build
 * script runs and no true/false decision is rewritten.
 *
 * @param dir - Current profile directory.
 * @returns Every undecided `allowBuilds` key: prior placeholders plus captured ones, in existing order.
 * @throws On malformed `.modules.yaml` or `allowBuilds` rule values; nothing is written.
 */
export async function capturePendingBuilds(dir: string): Promise<string[]> {
  const { document, pending } = await readPolicy(dir)
  const ignored = await readIgnoredBuilds(dir)
  const policy = scalarPolicy(document.get('allowBuilds'))
  if (ignored.length === 0) return pending
  const allowBuild = createAllowBuildFunction({ allowBuilds: policy.entries })
  const undecided = unapprovedIgnoredBuilds(new Set(ignored) as IgnoredBuilds, allowBuild)
  const missing = [...new Set(undecided.map(allowBuildKeyFromIgnoredBuild))]
    .filter(key => !policy.keys.has(key))
  if (missing.length > 0) {
    for (const key of missing) document.setIn(['allowBuilds', key], UNDECIDED_ALLOW_BUILD)
    await writeFileAtomic(join(dir, 'pnpm-workspace.yaml'), String(document), { mode: 0o600 })
  }
  return [...new Set([...pending, ...missing])]
}

async function readPolicy(dir: string) {
  let text: string
  try { text = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '{}\n'
  }
  const document = parseDocument(text)
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (!isMap(document.contents)) throw new Error('pnpm-workspace.yaml must be a YAML mapping')
  const builds = document.get('allowBuilds')
  if (builds !== undefined && !isMap(builds)) throw new Error('allowBuilds must be a YAML mapping')
  visit(builds ?? null, (_key, node) => {
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) {
      throw new Error('allowBuilds must not contain YAML anchors or aliases')
    }
  })
  const pending = isMap(builds) ? builds.items.flatMap(({ key, value }) =>
    isScalar(key) && typeof key.value === 'string' && !/[*?]/.test(key.value)
      && isScalar(value) && value.value === 'set this to true or false' ? [key.value] : []) : []
  return { document, pending }
}

/** Read `allowBuilds` keys left undecided by pnpm, including after installation cleanup.
 * @param dir Current profile directory.
 * @returns Exact `allowBuilds` keys awaiting a build decision; wildcard rules are excluded.
 */
export async function readPendingBuilds(dir: string): Promise<string[]> {
  return (await readPolicy(dir)).pending
}

/** Persist approval without running scripts; the caller holds the profile manifest lock.
 * @param dir Current profile directory.
 * @param names Explicit `allowBuilds` keys from the pending build list.
 * @throws If a key is no longer pending or allowBuilds contains YAML anchors or aliases; no approvals are written.
 */
export async function approveBuilds(dir: string, names: readonly string[]): Promise<void> {
  const { document, pending } = await readPolicy(dir)
  if (names.some(name => !pending.includes(name))) throw new ManagementFailure('stale-approval')
  if (names.length === 0) return
  for (const name of names) document.setIn(['allowBuilds', name], true)
  await writeFileAtomic(join(dir, 'pnpm-workspace.yaml'), String(document), { mode: 0o600 })
}
