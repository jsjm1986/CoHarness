/** Translation joins the GUI's ordinary Agent ownership without creating a model turn. */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ApiSessionController } from '@deepseek-ai/dsh-api-remotes/session-controller'
import Translator from '@deepseek-ai/dsh-experimental-translator'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import CotTranslationController from '../src/index.ts'

/** Real stored-session reads; this fixture does not provide full-text search. */
class ReadOnlySessionQuery extends SessionQuery {
  searchSessions(): never { throw new Error('Unexpected full-text Session search') }
  searchEvents(): never { throw new Error('Unexpected full-text event search') }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixture(origin?: 'subagent') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cot-activation-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const requests: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([{ translations: [{ text: 'Saved translation', to: 'zh-Hans' }] }]))
    })
  })
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }))
    server.closeAllConnections()
    await closed
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected allocated loopback listener')

  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(ReadOnlySessionQuery, {})
  await mountAgentLoopTestHarness(ctx)
  // The sessionController seam: a cold top-level identity resumes through the
  // registry's factory; a delegated (subagent-origin) Session refuses ordinary
  // GUI ownership, mirroring the apiproxy resolver's admission rule.
  ctx.provide('sessionController', {
    resolveAgent: async (sessionId): Promise<Awaited<ReturnType<ApiSessionController['resolveAgent']>>> => {
      const live = ctx.agents.get(sessionId)
      if (live !== undefined) return { agent: live }
      const snapshot = await ctx.sessionPersistence.stat(sessionId)
      if (snapshot === undefined) {
        return { error: { code: 'session-not-found', message: 'Session not found', details: { sessionId } } }
      }
      if (snapshot.header.origin === 'subagent' || (snapshot.header.delegationDepth ?? 0) > 0) {
        return { error: { code: 'session-not-found', message: 'Delegated Sessions do not join GUI ownership', details: { sessionId } } }
      }
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId })
      return { agent: handle.agent }
    },
  })
  await ctx.plugin(Translator, Translator.Config({ bingEndpoint: `http://127.0.0.1:${address.port}/bing` }))
  const ui = ctx.plugin(CotTranslationController, {})
  await ui

  const id = SessionId('saved-conversation')
  const original = [
    { type: 'turn/start' as const, seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end' as const, seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' as const } } },
  ]
  await using writer = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd: root, isSeeded: false,
    delegationDepth: origin === undefined ? 0 : 1,
    ...origin === undefined ? {} : { origin, parentSession: SessionId('parent-conversation') },
  })
  await writer.append(original)
  await writer.flush()
  return { ctx, id, original, ui, requests }
}

it('shares normal GUI activation and leaves the resumed Agent owned by the GUI after translation is disabled', async () => {
  const b = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  cleanups.push(async () => { release.resolve(undefined) })
  const open = b.ctx.sessionPersistence.open.bind(b.ctx.sessionPersistence)
  const writerOpen = vi.spyOn(b.ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) => {
    if (access === 'write') { entered.resolve(undefined); await release.promise }
    return open(id, access, options)
  })
  const startups: Array<{ id: SessionId; source: string }> = []
  b.ctx.on('agent/created', ({ agent, source }) => { startups.push({ id: agent.id, source }) })
  const stream = vi.spyOn(b.ctx.llm, 'stream')
  const request = { text: 'Original reasoning', targetLanguage: 'zh', sessionId: b.id }
  const translation = b.ctx.cotTranslation.translate(request, new AbortController().signal)
  await entered.promise
  expect(b.requests).toEqual([])
  expect(b.ctx.agents.get(b.id)).toBeUndefined()

  release.resolve(undefined)
  await expect(translation).resolves.toBe('Saved translation')

  expect(startups).toEqual([{ id: b.id, source: 'resume' }])
  expect(writerOpen.mock.calls.filter(([, access]) => access === 'write')).toHaveLength(1)
  expect(stream).not.toHaveBeenCalled()
  expect(b.requests).toEqual(['["Original reasoning"]'])
  expect(b.ctx.agents.get(b.id)).toBeDefined()
  await b.ui.dispose()
  expect(b.ctx.agents.get(b.id)).toBeDefined()
  await using saved = await b.ctx.sessionPersistence.open(b.id, 'read')
  const events = (await saved.read()).events
  expect(events.slice(0, b.original.length)).toEqual(b.original)
  expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(events.filter(event => event.type.startsWith('plugin:translator/')).map(event => event.type))
    .toEqual(['plugin:translator/request', 'plugin:translator/result'])
})

it('keeps an uncached inactive subagent unchanged when ordinary Session activation refuses ownership', async () => {
  const b = await fixture('subagent')
  const open = vi.spyOn(b.ctx.sessionPersistence, 'open')
  const resume = vi.spyOn(b.ctx.agents, 'resume')
  const stream = vi.spyOn(b.ctx.llm, 'stream')
  const failure = await b.ctx.cotTranslation.translate({
    text: 'Original child reasoning', targetLanguage: 'zh', sessionId: b.id,
  }, new AbortController().signal).catch((error: unknown) => error)

  expect(failure).toBeInstanceOf(RemoteError)
  expect(failure).toMatchObject({ code: 'cotTranslation/failed', message: 'Translation failed', details: {} })
  expect(resume).not.toHaveBeenCalled()
  expect(stream).not.toHaveBeenCalled()
  expect(b.requests).toEqual([])
  expect(b.ctx.agents.get(b.id)).toBeUndefined()
  expect(b.ctx.sessions.get(b.id)).toBeUndefined()
  expect(open.mock.calls.every(([, access]) => access === 'read')).toBe(true)
  await using saved = await b.ctx.sessionPersistence.open(b.id, 'read')
  expect((await saved.read()).events).toEqual(b.original)
})
