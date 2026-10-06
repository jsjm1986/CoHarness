/** Candidate storage locations must preserve both data bytes and the consumers' recorded ownership. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { load as loadYaml } from 'js-yaml'
import { readManagedDataPaths, type ManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import type { GatewayConfig } from './config.ts'
import { compareManagedFiles, normalizeManagedRoots, snapshotManagedFiles } from './managed-files.ts'
import { NodeConfigurationError } from './node-config-store.ts'
import { collectDeploymentData, planDeploymentDataRelocation } from './postgres/deployment-data.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'

function within(root: string, path: string): boolean {
  const tail = relative(root, path)
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail))
}

const keys = (roots: readonly ManagedDataPath[]) => roots.map(root => JSON.stringify([root.owner, root.kind, root.path])).sort()

async function controlPaths(cfg: GatewayConfig): Promise<string[]> {
  const paths = [cfg.databaseUrlFile, cfg.defaultEnvFile].filter((path): path is string => path !== undefined && path !== '')
  return (await normalizeManagedRoots(paths.map(path => ({ owner: 'gateway', kind: 'file', path })))).map(root => root.path)
}

async function configurationText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 1024 * 1024) throw new NodeConfigurationError(409, 'runtime-configuration-requires-reviewed-data-migration')
    return await file.readFile('utf8')
  } finally { await file.close() }
}

function configurationStrings(path: string, text: string, environmentFile: boolean): string[] {
  let value: unknown
  try { value = environmentFile ? parseEnv(text) : path.endsWith('.json') ? JSON.parse(text) : loadYaml(text) }
  catch { throw new NodeConfigurationError(409, `runtime-configuration-requires-reviewed-data-migration:${path}`) }
  const pending = [value], seen = new Set<unknown>(), result: string[] = []
  while (pending.length > 0) {
    const item = pending.pop()
    if (typeof item === 'string') result.push(item)
    else if (item !== null && typeof item === 'object' && !seen.has(item)) {
      seen.add(item)
      for (const [key, child] of Object.entries(item)) { result.push(key); pending.push(child) }
    }
  }
  return result
}

/**
 * Validate copied data and reviewed inventories before publishing any new live location.
 * @param context - node identity with stopped writers and an active data-operation lease.
 * @param current - currently applied configuration.
 * @param next - saved candidate configuration; this check does not modify either location.
 * @param signal - lifetime of the data-operation lease.
 * @returns after matching data, inventory membership and supported configuration consumers.
 */
export async function verifyNodeDataRelocation(context: PostgresRuntimeContext, current: GatewayConfig, next: GatewayConfig, signal: AbortSignal): Promise<void> {
  const plan = await planDeploymentDataRelocation(context, current, next)
  const candidate = await collectDeploymentData(context, next).catch((error: unknown) => {
    throw new NodeConfigurationError(409, `candidate-inventory-requires-reviewed-data-migration:${error instanceof Error ? error.message : 'invalid-inventory'}`)
  })
  const controls = new Set([...(await controlPaths(current)), ...(await controlPaths(next))])
  if (JSON.stringify(keys(plan.roots.filter(root => !controls.has(root.path)))) !== JSON.stringify(keys(candidate.filter(root => !controls.has(root.path))))) {
    throw new NodeConfigurationError(409, 'candidate-inventory-does-not-cover-relocated-managed-data')
  }
  for (const inventory of plan.inventories) {
    const actual = await Promise.all(readManagedDataPaths(inventory.to).map(async row => (await normalizeManagedRoots([row]))[0]!))
    if (JSON.stringify(keys(actual)) !== JSON.stringify(keys(inventory.records))) throw new NodeConfigurationError(409, 'candidate-inventory-needs-complete-reviewed-replacement')
    const source = await snapshotManagedFiles([{ owner: 'gateway', kind: 'file', path: inventory.from }], undefined, signal)
    const copied = await snapshotManagedFiles([{ owner: 'gateway', kind: 'file', path: inventory.to }], undefined, signal)
    const before = source.files[0]!, after = copied.files[0]!
    if (before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid) throw new NodeConfigurationError(409, 'candidate-inventory-ownership-does-not-match')
  }
  const inventories = new Set(plan.inventories.map(inventory => inventory.from))
  const copies = plan.copies.filter(copy => !inventories.has(copy.from.path))
  const source = await snapshotManagedFiles(copies.map(copy => copy.from), undefined, signal)
  const relocate = (path: string): string => {
    const copy = copies.find(item => within(item.from.path, path))!
    return join(copy.to.path, relative(copy.from.path, path))
  }
  const configurationPaths = new Set<string>()
  for (const file of source.files) {
    const owner = copies.find(copy => within(copy.from.path, file.sourcePath))!.from.owner
    if (!owner.endsWith('/gateway') && !owner.endsWith('/app-boot') && !owner.endsWith('/@deepseek-ai/dsh-agent-presets')) continue
    if (!['.env', 'cordis.patch.yml', 'directory-grants.json', 'model-governance.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(basename(file.sourcePath))
      && !/\.ya?ml$/u.test(file.sourcePath)) continue
    configurationPaths.add(file.sourcePath)
  }
  if (next.defaultEnvFile !== '') configurationPaths.add(next.defaultEnvFile)
  for (const path of configurationPaths) {
    const text = await configurationText(path)
    const values = configurationStrings(path, text, basename(path) === '.env' || path === next.defaultEnvFile)
    const prefixes = [...plan.movements.map(move => move.from), ...plan.runtimeSources,
      ...(basename(path) === 'directory-grants.json' ? [] : plan.configuredSources)]
    // Executable YAML can compute paths without a literal old prefix; it needs an explicit migration.
    if (/!!js\b/u.test(text) || prefixes.some(prefix => text.includes(prefix) || values.some(value => value.includes(prefix)))) {
      throw new NodeConfigurationError(409, `runtime-configuration-requires-reviewed-data-migration:${path}`)
    }
  }
  const expected = { ...source, roots: copies.map(copy => copy.to), absent: source.absent.map(relocate),
    directories: source.directories.map(dir => ({ ...dir, path: relocate(dir.path) })),
    files: source.files.map(file => ({ ...file, sourcePath: relocate(file.sourcePath) })) }
  if ((await compareManagedFiles(expected, signal)).length > 0) {
    throw new NodeConfigurationError(409, 'relocated-managed-data-does-not-match: copy and verify data before applying paths')
  }
  signal.throwIfAborted()
}
