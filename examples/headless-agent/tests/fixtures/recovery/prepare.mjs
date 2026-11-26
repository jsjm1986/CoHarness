/** Built-runtime recovery preparation and bounded loopback model for the Python SDK mirror. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '../../../../../vendor/cordis/lib/index.js'
import { composeEntries, createRuntimeResolution, initProfile, inspectRecoveryComposition, loadOverlayPatches, loadProfileDirectory } from '../../../../../packages/boot/app-boot/lib/index.js'
import { startMockLlmServer } from '../../../../../packages/test-support/llm-mock-server/lib/index.js'
import { createUserMessage } from '../../../../../packages/llm/llm/lib/index.js'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '../../../../../packages/core/session/lib/index.js'
import * as Persistence from '../../../../../packages/session/session-persistence-jsonl/lib/index.js'

const cwd = process.argv[2]
if (!cwd) throw new Error('Recovery preparation requires an owned workspace')
const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const home = join(cwd, '.dsh'), profileDir = join(home, 'profiles', 'sdk-minimal')
const installAnchor = join(repo, 'apps/cli/package.json')
const fixture = fileURLToPath(new URL('../../../recovery.cordis.snapshot.yml', import.meta.url))
initProfile(profileDir, ['@deepseek-ai/dsh-sdk-minimal'])
const profile = loadProfileDirectory('recovery-python', profileDir, installAnchor)
const layers = profile.layers.flatMap(layer => layer.patches)
const trustedEntries = composeEntries([layers])
const entries = composeEntries([layers, loadOverlayPatches('recovery-python', fixture)])
const resolution = await createRuntimeResolution({ installAnchor, home, profile })
const modules = new Map(resolution.entries.map(entry => [entry.name, entry]))
const moduleFile = name => createRequire(modules.get(name)?.declarer ?? installAnchor).resolve(name)
const inspected = inspectRecoveryComposition({ entries, trustedEntries, parentURL: new URL('../../../recovery.cordis.snapshot.yml', import.meta.url).href,
  resolveModule: moduleFile, resolveTrustedModule: moduleFile })
const oldSessionIds = ['recovered-root', 'recovered-child']
const policy = { version: 1, mode: 'new-conversations-only', operationId: 'recovery-python', pointId: 'snapshot-point',
  runtimeId: 'restored-runtime', nodeId: 'replacement', writerEpoch: '2', reviewRevision: '00000000-0000-4000-8000-000000000001',
  oldSessionIds, approvedItems: [], composition: inspected.composition, compositionDigest: inspected.compositionDigest }
const policyFile = join(cwd, 'recovery-policy.json'), body = JSON.stringify(policy)
await writeFile(policyFile, body, { mode: 0o600 })
const storage = new Context()
const server = await startMockLlmServer({ sequence: ['success'], successText: 'New recovery conversation accepted.' })
const originals = new Map()
try {
  await storage.plugin(Persistence, { root: join(home, 'sessions'), compression: 'none' })
  for (const id of oldSessionIds) {
    const meta = { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, cwd, isSeeded: false,
      ...id === 'recovered-child' ? { parentSession: SessionId('recovered-root'), origin: 'subagent', delegationDepth: 1 } : { delegationDepth: 0 } }
    const writer = await storage.sessionPersistence.create(meta)
    try {
      await writer.append([{ type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 2,
        data: { target: 'next-turn', start: 0, inserted: [createUserMessage({ content: [{ type: 'text', text: 'Old pending work must remain paused.' }], source: { kind: 'user' } })] } }])
    } finally { await writer.close() }
    const location = storage.sessionPersistence.locate(meta)
    if (location?.kind !== 'jsonl') throw new Error('Recovery fixture requires JSONL persistence')
    originals.set(location.path, await readFile(location.path))
  }
  process.stdout.write(JSON.stringify({ patches: [fixture], policyFile, policySha256: createHash('sha256').update(body).digest('hex'), baseURL: server.baseURL }) + '\n')
  for await (const _chunk of process.stdin) { /* EOF joins the Python SDK before inspecting its durable results. */ }
  const history = await Promise.all(oldSessionIds.map(async id => {
    const stored = await storage.sessionPersistence.inspect(SessionId(id))
    return { id: stored.meta.id, events: stored.events.map(event => event.type) }
  }))
  const matches = await Promise.all([...originals].map(async ([file, bytes]) => (await readFile(file)).equals(bytes)))
  process.stdout.write(JSON.stringify({ history, oldHistoryUnchanged: matches.every(Boolean), modelRequests: server.requests.length }) + '\n')
} finally {
  try { await storage.fiber.dispose() } finally { await server.close() }
}
