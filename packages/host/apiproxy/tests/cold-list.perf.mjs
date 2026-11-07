/** Read-only synthetic listing diagnostic through the built ApiProxy and JSONL provider. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const release = process.cwd()
const [label, output, cacheMode = 'default'] = process.argv.slice(2)
if (!/^[a-z0-9-]+$/u.test(label ?? '') || !output || !isAbsolute(output)
  || !['default', 'disabled'].includes(cacheMode)) throw new Error('Usage: node cold-list.perf.mjs <label> <absolute-output.json> [default|disabled] from a built repository root')
const out = output
try { await readFile(out); throw new Error('Evidence exists') }
catch (error) { if (error.code !== 'ENOENT') throw error }
const load = path => import(pathToFileURL(join(release, path)).href)
const { Context } = await load('vendor/cordis/lib/index.js')
const sessions = await load('packages/core/session/lib/index.js')
const jsonl = await load('packages/session/session-persistence-jsonl/lib/index.js')
const format = await load('packages/session/session-persistence-jsonl/lib/types/format.js')
const zstd = await load('packages/session/session-persistence-jsonl/lib/types/zstd.js')
const { default: UserQuestions } = await load('packages/interaction/user-questions/lib/index.js')
const { createApiProxy } = await load('packages/host/apiproxy/lib/index.js')
const { createUserMessage, createAssistantMessage, MessageId } = await load('packages/llm/llm/lib/index.js')
const root = await mkdtemp(join(tmpdir(), 'dsh-phase33-cold-list-'))
const ctx = new Context()
const headers = []
const metrics = {}
try {
  for (let index = 0; index < 123; index++) {
    const id = sessions.SessionId(`synthetic-${String(index).padStart(3, '0')}`)
    const header = { version: sessions.SESSION_FORMAT_VERSION, id, createdAt: 1000,
      cwd: `/synthetic/project-${String(index % 27).padStart(2, '0')}`, isSeeded: false, delegationDepth: 0 }
    headers.push(header)
    const events = [
      { type: 'turn/start', seq: 0, time: 1001, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1002,
        data: createUserMessage({ id: MessageId(`user-${String(index)}`), content: [{ type: 'text', text: 'Synthetic request' }], source: { kind: 'user' } }), surfaceOp: 'append' },
      { type: 'step/start', seq: 2, time: 1003, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 3, time: 1004, data: { turn: 1, step: 1,
        message: createAssistantMessage({ id: MessageId(`assistant-${String(index)}`), content: [{ type: 'text', text: 'Synthetic response' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
        stream: [
          { type: 'chunk', time: 1003, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'text-chunks', time0: 1003, index: 0, dt: [], texts: ['Synthetic response'] },
          { type: 'chunk', time: 1004, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic response' } } },
          { type: 'chunk', time: 1004, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ] }, surfaceOp: 'append' },
      { type: 'step/end', seq: 4, time: 1005, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: 1006, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const path = format.generationLogPath(root, header.cwd, id, sessions.SESSION_FORMAT_VERSION, 'zstd')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, Buffer.concat([
      await zstd.compressZstdFrame(JSON.stringify(format.toHeaderLine(header)) + '\n'),
      await zstd.compressZstdFrame(events.map(event => JSON.stringify(event)).join('\n') + '\n'),
    ]), { flag: 'wx', mode: 0o600 })
  }
  await ctx.plugin(sessions.default)
  await ctx.plugin(UserQuestions)
  await ctx.plugin(jsonl, { root, compression: 'zstd' })
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: header => {
      const index = Number(header.id.slice(-3))
      if (index >= 64) return undefined
      return { asOfSeq: 5, values: { sessionListMetadata: {
        blank: index >= 46, visibleContentSeq: index >= 46 ? null : 3,
        lastPromptAt: index >= 46 ? null : 1002,
      } } }
    },
    cachedPredecessorTitle: () => undefined,
  })
  const service = ctx.sessionPersistence
  for (const name of ['list', 'readFrom', 'findLog', 'listProjectDirs', 'resolveGenerationInDirectory', 'readGenerationHeader']) {
    const original = service[name]
    assert.equal(typeof original, 'function')
    service[name] = async function (...args) {
      const entry = metrics[name] ??= { calls: 0, milliseconds: 0 }
      entry.calls++
      const start = performance.now()
      try { return await Reflect.apply(original, this, args) }
      finally { entry.milliseconds += performance.now() - start }
    }
  }
  const api = createApiProxy(ctx, { cwd: '/synthetic', defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    ...(cacheMode === 'disabled' ? { coldSummaryCacheMaxEntries: 0 } : {}) })
  const samples = []
  let baseline
  for (let index = 0; index < 4; index++) {
    for (const key of Object.keys(metrics)) delete metrics[key]
    const start = performance.now()
    const result = await api.sessions.list({ rpcId: `listing-${String(index)}`, payload: {} })
    const milliseconds = performance.now() - start
    assert.equal(result.result.ok, true)
    const items = result.result.value.items
    assert.equal(items.length, 123)
    assert.ok(items.every(item => item.blank === false && item.updatedAt === 1002 && item.visibleContentSeq === 3))
    const canonical = JSON.stringify(items)
    baseline ??= canonical
    assert.equal(canonical, baseline)
    samples.push({ state: index === 0 ? 'first' : 'repeat', milliseconds,
      metadataSha256: createHash('sha256').update(canonical).digest('hex'),
      work: structuredClone(metrics), rss: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS })
  }
  const record = { at: new Date().toISOString(), label, cacheMode, release, node: process.version, samples,
    workload: { projectDirectories: 27, currentGenerationSessions: 123, cachedNonblankHints: 46, staleBlankHints: 18, absentHints: 59,
      eventsPerSession: 6, compression: 'zstd' },
    entry: 'Built published createApiProxy -> SessionPersistence -> built JSONL provider; no copied discovery or listing algorithm',
    clock: 'Per-call metadata response object, including discovery and body verification; imports, setup and JSON encoding excluded',
    memory: 'Node RSS endpoint/maxRSS with fixture headers and final metadata reachable; no forced GC',
    excludes: ['HTTP', 'authentication', 'browser', 'historical format migration', 'large or tool-heavy logs', 'capacity'],
    nestedWorkDurationCaveat: 'Method timings overlap across nested and concurrent calls and must not be added',
    threshold: null, privateUserDataRead: false, productionStateChanged: false }
  await writeFile(out, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ label, samples: samples.map(row => ({ milliseconds: row.milliseconds, reads: row.work.readFrom?.calls ?? 0 })) }))
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
