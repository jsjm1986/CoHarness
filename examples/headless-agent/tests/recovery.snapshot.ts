/** New-conversation recovery through the shipped SDK profile, real Loader, and Messages HTTP provider. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { composeEntries, initProfile, inspectRecoveryComposition, loadOverlayPatches, loadProfileDirectory, type RecoveryPolicy } from '@deepseek-ai/dsh-app-boot'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { resolveExampleMode } from '@deepseek-ai/dsh-loader-smoke'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { logPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { expect, it } from 'vitest'
import ts from 'typescript'

it('keeps restored root and child inboxes read-only while a new conversation receives a model reply', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-recovery-snapshot-'))
  const home = join(cwd, '.dsh'), profileDir = join(home, 'profiles', 'sdk-minimal')
  const repo = fileURLToPath(new URL('../../../', import.meta.url))
  const installAnchor = join(repo, 'apps/cli/package.json')
  const source = resolveExampleMode() === 'src'
  const server = await startMockLlmServer({ sequence: ['success'], successText: 'New recovery conversation accepted.' })
  const storage = new Context()
  let harness: DeepSeekHarness | undefined
  try {
    initProfile(profileDir, ['@deepseek-ai/dsh-sdk-minimal'])
    const profile = loadProfileDirectory('recovery-snapshot', profileDir, installAnchor)
    const fixture = fileURLToPath(new URL('../recovery.cordis.snapshot.yml', import.meta.url))
    const layers = profile.layers.flatMap(layer => layer.patches)
    const patch = loadOverlayPatches('recovery-snapshot', fixture)
    const trustedEntries = composeEntries([layers])
    const entries = composeEntries([layers, patch])
    const sourcePaths = ts.readConfigFile(join(repo, 'tsconfig.base.json'), path => ts.sys.readFile(path)).config as { compilerOptions: { paths: Record<string, string[]> } }
    const moduleFile = (name: string, parent = new URL('../recovery.cordis.snapshot.yml', import.meta.url).href): string => {
      const file = name.startsWith('.') || name.startsWith('file:') ? fileURLToPath(new URL(name, parent)) : source && sourcePaths.compilerOptions.paths[name]?.[0] !== undefined
        ? resolve(repo, sourcePaths.compilerOptions.paths[name][0]) : createRequire(installAnchor).resolve(name)
      return statSync(file).isDirectory() ? join(file, 'index.ts') : file
    }
    const inspection = inspectRecoveryComposition({ entries, trustedEntries, parentURL: new URL('../recovery.cordis.snapshot.yml', import.meta.url).href,
      resolveModule: moduleFile, resolveTrustedModule: moduleFile })
    expect(inspection.items.find(item => item.name.startsWith('custom-plugin:'))?.reason).toBe('custom-plugin-review-required')
    expect(inspection.composition.rows.some(row => row.name === '@deepseek-ai/dsh-sdk-jsonrpc-server')).toBe(true)
    const permission: RecoveryPolicy = { version: 1, mode: 'new-conversations-only', operationId: 'recovery-snapshot', pointId: 'snapshot-point',
      runtimeId: 'restored-runtime', nodeId: 'replacement', writerEpoch: '2', reviewRevision: '00000000-0000-4000-8000-000000000001',
      oldSessionIds: ['recovered-root', 'recovered-child'], approvedItems: [], composition: inspection.composition, compositionDigest: inspection.compositionDigest }
    const permissionFile = join(cwd, 'recovery-policy.json'), permissionBody = JSON.stringify(permission)
    await writeFile(permissionFile, permissionBody, { mode: 0o600 })
    await storage.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
    const before = new Map<string, Buffer>()
    for (const id of permission.oldSessionIds) {
      const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, cwd, isSeeded: false,
        ...id === 'recovered-child' ? { parentSession: SessionId('recovered-root'), origin: 'subagent' as const, delegationDepth: 1 } : { delegationDepth: 0 } }
      const event: SessionEvent = { type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 2,
        data: { target: 'next-turn', start: 0, inserted: [createUserMessage({ content: [{ type: 'text', text: 'Old pending work must remain paused.' }], source: { kind: 'user' } })] } }
      const writer = await storage.sessionPersistence.create(meta)
      try { await writer.append([event]) } finally { await writer.close() }
      const file = logPath(join(home, 'sessions'), cwd, SessionId(id), 'none')
      before.set(file, await readFile(file))
    }
    harness = new DeepSeekHarness({ dshBin: join(repo, 'apps/cli', source ? 'src/bin.ts' : 'lib/bin.js'), profile: 'sdk-minimal', dshHome: home,
      cwd, processCwd: cwd, patches: [fixture], initializeTimeoutMs: 110_000, requestTimeoutMs: 110_000,
      env: { ...process.env, DEEPSEEK_API_KEY: 'owned-recovery-fixture-key', DEEPSEEK_BASE_URL: server.baseURL, DSH_TELEMETRY_DISABLED: '1',
        DSH_AGENTS_HOME: join(cwd, '.agents'), HGW_RECOVERY_POLICY_FILE: permissionFile,
        HGW_RECOVERY_POLICY_SHA256: createHash('sha256').update(permissionBody).digest('hex'),
        ...source ? { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${import.meta.resolve('tsx/esm')}`].filter(Boolean).join(' '),
          TSX_TSCONFIG_PATH: join(repo, 'apps/cli/tsconfig.json') } : {} } })
    await harness.start()
    const denied: string[] = []
    for (const id of permission.oldSessionIds) {
      await expect(harness.resumeSession(id)).rejects.toThrow(/read.only|recovery|subagent session/i)
      await expect(harness.client.prompt(id, [{ type: 'text', text: 'Do not execute.' }])).rejects.toThrow(/read.only|recovery|subagent session/i)
      denied.push(id)
    }
    expect(server.requests).toHaveLength(0)
    const fresh = await harness.run('Reply briefly.', { sessionId: 'new-after-recovery' })
    await harness.close(); harness = undefined
    const history = await Promise.all(permission.oldSessionIds.map(async (id) => {
      const inspected = await storage.sessionPersistence.inspect(SessionId(id))
      return { id: inspected.meta.id, events: inspected.events.map(event => event.type) }
    }))
    for (const [file, bytes] of before) expect(await readFile(file)).toEqual(bytes)
    const output = { denied, oldHistoryUnchanged: true, history, modelRequests: server.requests.length, finalResponse: fresh.finalResponse,
      finishReason: fresh.finishReason, unreviewedPluginImports: 0 }
    const expected = new URL('./fixtures/recovery/expected.json', import.meta.url)
    if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, JSON.stringify(output, null, 2) + '\n')
    expect(output).toEqual(JSON.parse(await readFile(expected, 'utf8')))
  } finally {
    try { await harness?.close() } finally {
      try { await storage.fiber.dispose() } finally {
        try { await server.close() } finally { await rm(cwd, { recursive: true, force: true }) }
      }
    }
  }
})
