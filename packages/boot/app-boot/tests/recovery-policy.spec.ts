/** Recovery admission observes actual Loader imports without executing denied modules. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { expect, it, onTestFinished } from 'vitest'
import { boot, initProfile, inspectRecoveryComposition, inspectRecoveryProfile, installRecoveryPolicy, prepareProfileEntries, readRecoveryPolicy, recoveryMcpConnection, type RecoveryPolicy } from '../src/index.ts'
import { recoveryCanonical, recoveryHash } from '../src/recovery-digest.ts'

function fixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-recovery-')))
  const contexts: Context[] = []
  onTestFinished(async () => {
    try { for (const ctx of contexts.reverse()) await ctx.fiber.dispose() }
    finally { rmSync(temp, { recursive: true, force: true }) }
  })
  const effects = join(temp, 'effects.txt')
  const root = join(temp, 'cordis.yml')
  writeFileSync(root, '[]\n')
  const modulePath = (name: string): string => join(temp, 'node_modules', name, 'index.mjs')
  const plugin = (name: string, source?: string): string => {
    const file = modulePath(name)
    mkdirSync(join(temp, 'node_modules', name), { recursive: true })
    writeFileSync(join(temp, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1', type: 'module', exports: './index.mjs' }))
    writeFileSync(file, source ?? `import { appendFileSync } from 'node:fs';const out = new URL(${JSON.stringify(pathToFileURL(effects).href)});appendFileSync(out, ${JSON.stringify(`import:${name}\n`)});export function apply(ctx,config){appendFileSync(out, ${JSON.stringify(`apply:${name}:`)}+JSON.stringify(config)+'\\n')}`)
    return file
  }
  const parentURL = pathToFileURL(join(temp, 'package.json')).href
  const policy = (entries: EntryOptions[], trustedEntries = entries, approvedItems?: string[]): RecoveryPolicy => {
    const result = inspectRecoveryComposition({
      entries, trustedEntries, parentURL, ...approvedItems === undefined ? {} : { approvedItems }, resolveTrustedModule: modulePath,
    })
    return { version: 1, mode: 'new-conversations-only', operationId: 'operation', pointId: 'point', runtimeId: 'runtime', nodeId: 'target',
      writerEpoch: '9007199254740993', reviewRevision: '00000000-0000-4000-8000-000000000001', oldSessionIds: ['root', 'child'], approvedItems: approvedItems ?? [],
      composition: result.composition, compositionDigest: result.compositionDigest }
  }
  const run = async (entries: EntryOptions[], permission: RecoveryPolicy): Promise<Context> => {
    const ctx = await boot('recovery-test', root, [{ insert: entries }], (ctx) => {
      installRecoveryPolicy(ctx, permission, (_ctx, ids) => { expect(ids).toEqual(['root', 'child']) })
    })
    contexts.push(ctx)
    return ctx
  }
  const output = (): string => existsSync(effects) ? readFileSync(effects, 'utf8') : ''
  return { temp, root, contexts, plugin, modulePath, parentURL, policy, run, output }
}

it('imports the approved base while unknown plugins, dynamic Includes, hooks and unproved expressions remain inert', async () => {
  const f = fixture()
  for (const name of ['safe-plugin', 'unknown-plugin', '@deepseek-ai/dsh-hook-codex', 'expression-plugin']) f.plugin(name)
  const trusted: EntryOptions[] = [{ id: 'safe', name: 'safe-plugin' }, { id: 'hook', name: '@deepseek-ai/dsh-hook-codex' }, { id: 'expression', name: 'expression-plugin' }]
  const entries: EntryOptions[] = [...trusted, { id: 'unknown', name: 'unknown-plugin' }, { id: 'include', name: 'cordis:include', config: { path: { __jsExpr: 'throw new Error("unexpected")' } } }]
  entries[2] = { id: 'expression', name: 'expression-plugin', config: { value: { __jsExpr: 'throw new Error("unexpected")' } } }
  await f.run(entries, f.policy(entries, trusted))
  expect(f.output()).toBe('import:safe-plugin\napply:safe-plugin:undefined\n')
})

it('clears configured startup agents before any expression can run, and denies changed configuration during recomposition', async () => {
  const f = fixture()
  f.plugin('@deepseek-ai/dsh-agent-loop')
  const base: EntryOptions[] = [{ id: 'loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } }]
  const rows: EntryOptions[] = [{ id: 'loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: { __jsExpr: 'throw new Error("old inbox")' } } }]
  const ctx = await f.run(rows, f.policy(rows, base))
  expect(f.output()).toContain('apply:@deepseek-ai/dsh-agent-loop:{"agents":[]}')
  const changed = prepareProfileEntries(ctx, [{ id: 'loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [], extra: 'changed' } }], f.parentURL)
  expect(changed[0]).toMatchObject({ disabled: true, group: false })
})

it('does not trust a same-name profile package with different installed bytes', () => {
  const f = fixture()
  const module = f.plugin('safe-plugin')
  const independent = join(f.temp, 'trusted.mjs')
  writeFileSync(independent, 'export function apply() {}')
  const result = inspectRecoveryComposition({ entries: [{ id: 'safe', name: 'safe-plugin' }], trustedEntries: [{ id: 'safe', name: 'safe-plugin' }], parentURL: f.parentURL,
    resolveModule: () => module, resolveTrustedModule: () => independent })
  expect(result.composition.rows).toHaveLength(0)
  expect(result.items[0]).toMatchObject({ status: 'eligible', reason: 'execution-review-required' })
})

it.each(['code', 'manifest', 'extra-file'])('verifies a Gateway-owned package copy against its independent materialization and rejects %s drift', async (change) => {
  const f = fixture(), name = 'managed-policy'
  const original = f.plugin(name), source = readFileSync(original, 'utf8')
  const copiedRoot = join(f.temp, 'node_modules', name), trustedRoot = join(f.temp, 'installation', name)
  rmSync(original)
  const manifest = { name, type: 'module', main: 'lib/index.mjs', peerDependencies: { 'deployment-provided-peer': '*' } }
  for (const root of [copiedRoot, trustedRoot]) {
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib/index.mjs'), source)
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(root, 'cordis.patch.yml'), '[]\n')
  }
  mkdirSync(join(trustedRoot, 'src')); writeFileSync(join(trustedRoot, 'src/index.ts'), 'installation source')
  writeFileSync(join(trustedRoot, 'README.md'), 'installation documentation')
  const rows = [{ id: 'managed', name }]
  const inspect = (trustedMaterializedModules: string[] = []) => inspectRecoveryComposition({
    entries: rows, trustedEntries: rows, parentURL: f.parentURL,
    trustedMaterializedModules, resolveTrustedModule: () => join(trustedRoot, 'lib/index.mjs') })
  expect(inspect().composition.rows).toHaveLength(0)
  const approved = inspect([name])
  expect(approved.composition.rows).toHaveLength(1)
  expect(approved.composition.rows[0]?.dependencyClosure).toBeUndefined()
  const ctx = await f.run(rows, { ...f.policy([]), composition: approved.composition, compositionDigest: approved.compositionDigest })
  expect(f.output()).toContain('import:managed-policy')
  if (change === 'code') writeFileSync(join(copiedRoot, 'lib/index.mjs'), 'throw new Error("unreviewed")')
  else if (change === 'manifest') writeFileSync(join(copiedRoot, 'package.json'), JSON.stringify({ ...manifest, main: 'lib/elsewhere.mjs' }))
  else writeFileSync(join(copiedRoot, 'unreviewed.mjs'), 'throw new Error("unreviewed")')
  expect(() => prepareProfileEntries(ctx, rows, f.parentURL)).toThrow()
  expect(inspect([name]).composition.rows).toHaveLength(0)
})

it('seals group isolation before importing its approved children', async () => {
  const f = fixture()
  f.plugin('safe-plugin')
  const entries: EntryOptions[] = [{ id: 'realm', name: 'cordis:group', group: true, isolate: { sample: true }, config: [{ id: 'safe', name: 'safe-plugin' }] }]
  const ctx = await f.run(entries, f.policy(entries))
  expect(f.output()).toContain('import:safe-plugin')
  const altered = structuredClone(entries)
  altered[0]!.isolate = { sample: 'changed-scope' }
  expect(prepareProfileEntries(ctx, altered, f.parentURL)[0]).toMatchObject({ disabled: true, group: false })
})

it('requires explicit approval for installed schedules and refuses changed approved artifact bytes', async () => {
  const f = fixture()
  const file = f.plugin('@deepseek-ai/dsh-schedule')
  const entries: EntryOptions[] = [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule' }]
  const first = inspectRecoveryComposition({ entries, trustedEntries: entries, parentURL: f.parentURL, resolveTrustedModule: f.modulePath })
  expect(first.items[0]?.status).toBe('eligible')
  const policy = f.policy(entries, entries, [first.items[0]!.itemDigest])
  expect(policy.composition.rows).toHaveLength(1)
  writeFileSync(file, 'throw new Error("must not import")')
  await expect(f.run(entries, policy)).rejects.toThrow('artifact changed')
})

it('reviews a custom plugin separately and invalidates its approval when a declared dependency changes', async () => {
  const f = fixture()
  const file = f.plugin('custom-plugin')
  const dependency = f.plugin('custom-dependency', 'export const value = 1')
  writeFileSync(join(f.temp, 'node_modules/custom-plugin/package.json'), JSON.stringify({ name: 'custom-plugin', type: 'module', exports: './index.mjs', dependencies: { 'custom-dependency': '1' } }))
  const entries = [{ id: 'custom', name: 'custom-plugin' }]
  const inspection = inspectRecoveryComposition({ entries, trustedEntries: [], parentURL: f.parentURL, resolveTrustedModule: f.modulePath })
  expect(inspection.items[0]).toMatchObject({ status: 'eligible', reason: 'custom-plugin-review-required' })
  await f.run(entries, f.policy(entries, []))
  expect(f.output()).toBe('')
  const permission = f.policy(entries, [], [inspection.items[0]!.itemDigest])
  const ctx = await f.run(entries, permission)
  expect(f.output()).toContain('import:custom-plugin')
  expect(readFileSync(file, 'utf8')).toContain('apply')
  writeFileSync(dependency, 'export const value = 2')
  expect(() => prepareProfileEntries(ctx, entries, f.parentURL)).toThrow('artifact changed')
})

it('refuses an oversized custom artifact without consuming the following baseline package budget', () => {
  const f = fixture()
  f.plugin('oversized-plugin'); f.plugin('safe-plugin')
  const payload = join(f.temp, 'node_modules/oversized-plugin/payload.bin')
  writeFileSync(payload, ''); truncateSync(payload, 256 * 1024 * 1024 + 1)
  const safe = { id: 'safe', name: 'safe-plugin' }
  const result = inspectRecoveryComposition({ entries: [{ id: 'oversized', name: 'oversized-plugin' }, safe], trustedEntries: [safe], parentURL: f.parentURL, resolveTrustedModule: f.modulePath })
  expect(result.items[0]).toMatchObject({ status: 'suspended', reason: 'artifact-unavailable' })
  expect(result.composition.rows.map(row => row.name)).toEqual(['safe-plugin'])
})

it('reviews each literal MCP server and hook command independently of its host plugin', () => {
  const f = fixture()
  f.plugin('@deepseek-ai/dsh-mcp-manager'); f.plugin('@deepseek-ai/dsh-hooks-codex')
  const hookFile = join(f.temp, 'hooks.json')
  writeFileSync(hookFile, JSON.stringify({ UserPromptSubmit: [{ hooks: [{ command: 'printf reviewed' }] }] }))
  const entries = [{ id: 'mcp', name: '@deepseek-ai/dsh-mcp-manager', config: { servers: { first: { transport: 'stdio', command: 'first-server' }, second: { transport: 'streamable-http', url: 'https://second.invalid/mcp' } } } },
    { id: 'hooks', name: '@deepseek-ai/dsh-hooks-codex', config: { configPath: 'hooks.json' } }]
  const inspect = (approvedItems: string[] = []) => inspectRecoveryComposition({
    entries, trustedEntries: entries, parentURL: f.parentURL, cwd: f.temp, approvedItems, resolveTrustedModule: f.modulePath,
  })
  const initial = inspect(), targets = initial.items.filter(item => item.kind === 'external-connection')
  expect(targets).toHaveLength(3)
  expect(targets.every(item => item.status === 'eligible')).toBe(true)
  expect(targets.every(item => !item.name.includes(f.temp) && !item.name.includes('first') && !item.name.includes('second'))).toBe(true)
  const approved = inspect([targets[0]!.itemDigest, targets.find(item => item.name.includes('UserPromptSubmit'))!.itemDigest])
  expect(approved.composition.connections).toHaveLength(2)
  expect(approved.composition.connections?.some(item => item.id === 'second')).toBe(false)
  writeFileSync(hookFile, JSON.stringify({ UserPromptSubmit: [{ hooks: [{ command: 'printf changed' }] }] }))
  expect(inspect(targets.map(item => item.itemDigest)).composition.connections?.every(item => item.kind === 'mcp')).toBe(true)
})

it('enumerates MCP servers saved only in the Settings-owned profile patch without starting them', async () => {
  const f = fixture(), profileDir = join(f.temp, 'profiles', 'web')
  const repo = fileURLToPath(new URL('../../../../', import.meta.url))
  f.plugin('@deepseek-ai/dsh-mcp-manager')
  initProfile(profileDir, ['@deepseek-ai/dsh-web-app'])
  const server = { transport: 'stdio' as const, command: 'never-start-during-recovery-inspection', args: ['private-argument'] }
  writeFileSync(join(profileDir, 'cordis.patch.yml'), JSON.stringify([{ id: 'mcp-manager', config: { servers: { 'saved-only-in-settings': server } } }]))
  const inspection = await inspectRecoveryProfile({ home: f.temp, profileDir, installAnchor: join(repo, 'apps/cli/package.json'),
    trustedPatchFiles: [join(repo, 'packages/bundle/base/cordis.patch.yml'), join(repo, 'packages/bundle/web-app/cordis.patch.yml')] })
  const target = recoveryMcpConnection({ ...server, serverName: 'saved-only-in-settings', expandTemplates: true })
  const item = inspection.items.find(item => item.kind === 'external-connection' && item.configurationSha256 === target.configurationSha256)
  expect(item).toMatchObject({ status: 'eligible', reason: 'execution-review-required' })
  expect(item?.name).not.toContain('saved-only-in-settings')
  expect(inspection.composition.connections ?? []).toEqual([])
  expect(f.output()).toBe('')
})

it('checks the file digest, composition digest, exact bigint epoch, and required admission provider', () => {
  const f = fixture()
  const value = f.policy([])
  const file = join(f.temp, 'permission.json')
  const write = (policy: unknown): string => { const bytes = JSON.stringify(policy); writeFileSync(file, bytes); return createHash('sha256').update(bytes).digest('hex') }
  expect(readRecoveryPolicy(file, write(value)).writerEpoch).toBe('9007199254740993')
  expect(() => readRecoveryPolicy(file, '0'.repeat(64))).toThrow('digest')
  expect(() => readRecoveryPolicy(file, write({ ...value, writerEpoch: '9223372036854775808' }))).toThrow('invalid')
  expect(() => readRecoveryPolicy(file, write({ ...value, composition: { version: 1, rows: [{ name: 'unsafe' }] } }))).toThrow('invalid')
  for (const composition of [
    { version: 1, rows: [{ name: 'plugin', entrySha256: 'a'.repeat(64), artifactSha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64), dependencyClosure: false }] },
    { version: 1, rows: [], connections: [{ kind: 'unreviewed-protocol', id: 'target', configurationSha256: 'd'.repeat(64) }] },
  ]) {
    const invalid = { ...value, composition, compositionDigest: recoveryHash(recoveryCanonical(composition)) }
    expect(() => readRecoveryPolicy(file, write(invalid))).toThrow('invalid')
  }
  const ctx = new Context(); f.contexts.push(ctx)
  // A JavaScript embedder must not authorize composition without the mandatory execution provider.
  expect(() => { Reflect.apply(installRecoveryPolicy, undefined, [ctx, value]) }).toThrow('Session execution admission')
})

it('refuses nonempty root configuration before a recovered module can import', async () => {
  const f = fixture()
  f.plugin('safe-plugin')
  const rows = [{ id: 'safe', name: 'safe-plugin' }]
  writeFileSync(f.root, JSON.stringify(rows))
  await expect(f.run(rows, f.policy(rows))).rejects.toThrow('empty profile root')
  expect(f.output()).toBe('')
})
