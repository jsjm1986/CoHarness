import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ExecutionAuthority, type ExecutionCapability, type ExecutionInheritance, type ExecutionInputId, type ExecutionState } from '@deepseek-ai/dsh-execution-authority'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type LlmOperationDispatch, type MessageId, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as Governance from '../src/index.ts'
import { UsageOutbox, type UsageRecord } from '../src/outbox.ts'
import { generateStagehandModel } from '@deepseek-ai/dsh-experimental-browser-use-stagehand-native/src/model.ts'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as NativeSearch from '@deepseek-ai/dsh-web-search-deepseek'
import * as DeepSeekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as SonarSearch from '@deepseek-ai/dsh-web-search-perplexity'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  vi.unstubAllEnvs()
  if (errors.length > 0) throw new AggregateError(errors, 'billing fixture cleanup failed')
})

/** Authorization-only fixture; input transports and captured callbacks remain unavailable. */
class Authority extends ExecutionAuthority {
  allowed = true
  readonly deniedSessions = new Set<SessionId>()
  readonly states = new Map<SessionId, ExecutionState>()
  readonly calls: Array<{ agent: Agent; capability: ExecutionCapability }> = []
  state: ExecutionState = { revision: '1', inputs: ['input-a' as ExecutionInputId, 'input-b' as ExecutionInputId], actors: [{ userId: 7 }, { userId: 8 }], primaryActorUserId: 7, unverifiedHistory: false }
  stamp(_session: Session, _message: UserMessage): Promise<UserMessage> { throw new Error('billing fixture has no input transport') }
  answer(_session: Session, _questionId: string, _answer: unknown): Promise<boolean> { throw new Error('billing fixture has no questions') }
  runCaptured<T>(_agent: Agent, _scope: ExecutionInheritance, _work: () => T): T {
    throw new Error('billing fixture does not run captured callbacks')
  }
  runRequest<T>(_agent: Agent, _input: unknown, _work: () => T): Promise<Awaited<T>> {
    throw new Error('billing fixture has no command transport')
  }
  capture(_agent: Agent): ExecutionInheritance { throw new Error('billing fixture does not delegate') }
  current(): ExecutionInheritance | undefined { return undefined }
  captureSession(_sessionId: SessionId): Promise<ExecutionInheritance> { throw new Error('billing fixture does not capture another Session') }
  inherit(_session: Session, _scope: ExecutionInheritance): void { throw new Error('billing fixture does not inherit') }
  relay(_session: Session, _scope: ExecutionInheritance, _messageId: MessageId): Promise<ExecutionInheritance> {
    throw new Error('billing fixture does not relay')
  }
  async authorize(capability: ExecutionCapability, agent: Agent): Promise<ExecutionState> {
    this.calls.push({ capability, agent })
    if (!this.allowed || this.deniedSessions.has(agent.id)) throw new Error('execution refused')
    return this.states.get(agent.id) ?? this.state
  }
  async authorizeSelection(_agent: Agent, _preset: string): Promise<void> { throw new Error('billing fixture has no preset selection') }
}

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  physical = 0
  beforePhysical: (() => Promise<void>) | undefined
  browserOutput = false
  async * stream(options: GenerateOptions, dispatchRequest?: LlmOperationDispatch): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.beforePhysical?.()
    const send = async () => { this.physical++ }
    if (dispatchRequest === undefined) await send()
    else await dispatchRequest(send)
    if (this.browserOutput) yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Observed browser state' } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'organization' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(managed = true, withoutAuthority = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-execution-billing-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', root)
  await writeFile(join(root, 'model-governance.json'), JSON.stringify({ version: 1, defaultAllowed: false,
    userDeclaredAllowed: false, models: [{ provider: 'p', model: 'm', allowed: true }], providers: [],
    intakeUrl: 'http://127.0.0.1:1/usage', intakeToken: 'fixture-token' }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  if (managed) ctx.provide('executionAuthorityRequired', true)
  const authorityFiber = await ctx.plugin(Authority)
  const authority = ctx.executionAuthority as Authority
  if (withoutAuthority) await authorityFiber.dispose()
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['p'], adapter)
  const governanceFiber = await ctx.plugin(Governance)
  const records = async (): Promise<UsageRecord[]> => {
    const files = await readdir(join(root, 'model-governance-outbox'))
    return Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(root, 'model-governance-outbox', name), 'utf8')) as UsageRecord))
  }
  const session = Session.create(SessionId('actual-execution'))
  const agent = { id: session.id, session, ctx } as Agent
  const options = (extra: Partial<GenerateOptions> = {}): GenerateOptions => ({ provider: 'p', model: 'm', messages: [], ...extra })
  const drain = async (request: GenerateOptions) => { const chunks: StreamChunk[] = []; for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk); return chunks }
  return { ctx, root, authority, authorityFiber, governanceFiber, adapter, agent, session, records, options, drain }
}

async function nativeSearchFixture(provider?: string, protocol: 'messages' | 'sonar' = 'messages', recency = false) {
  const f = await fixture()
  const sonar = protocol === 'sonar'
  const route = sonar ? 'sonar-owned' : 'deepseek-official'
  const model = sonar ? 'sonar' : 'deepseek-v4-flash'
  const requests: Array<{ path: string; headers: import('node:http').IncomingHttpHeaders; body: unknown }> = []
  const order: string[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const part of request as AsyncIterable<Buffer>) parts.push(part)
      order.push('http')
      requests.push({ path: request.url!, headers: request.headers, body: JSON.parse(Buffer.concat(parts).toString()) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(sonar ? { choices: [{ message: { content: 'Owned Sonar answer.' } }],
        citations: ['https://result.test'], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
        : { usage: { input_tokens: 3, output_tokens: 2 }, content: [
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://result.test', title: 'Result' }] },
      ] }))
    })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error(String(error))) })
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve() }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const policy = (allowed: boolean) => writeFile(join(f.root, 'model-governance.json'), JSON.stringify({
    version: 1, defaultAllowed: false, userDeclaredAllowed: false,
    models: [{ provider: route, model, allowed }], providers: [],
    intakeUrl: 'http://127.0.0.1:1/usage', intakeToken: 'fixture-token',
  }))
  await policy(true)
  vi.stubEnv('DEEPSEEK_API_KEY', '')
  await f.ctx.plugin(LocalCredentialProvider, { path: join(f.root, 'native-credentials.yaml'), watch: false })
  await f.ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'personal-native-secret')
  if (sonar) await f.ctx.plugin(LlmPiAi, { providers: { [route]: { api: 'openai-completions',
    baseURL: `${endpoint}/sonar/v1`, apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: model, maxTokens: 64 }] } } })
  else await f.ctx.plugin(DeepSeekApiKey, { baseURL: `${endpoint}/anthropic` })
  await f.ctx.plugin(WebRuntime, {})
  const searchFiber = sonar
    ? await f.ctx.plugin(SonarSearch, { provider: route, model, maxTokens: 64, ...recency ? { searchRecency: 'week' as const } : {}, baseURL: `${endpoint}/independent-search`, apiKey: 'unrelated-secret' })
    : await f.ctx.plugin(NativeSearch, {
      ...provider === undefined ? {} : { provider },
      baseURL: `${endpoint}/independent-search`, apiKey: 'unrelated-secret', model,
    })
  const detach = f.ctx.agents.enter(f.agent, undefined)
  cleanups.push(async () => { detach() })
  const search = () => f.ctx.agents.withInitiator(f.agent, () => f.ctx.web.search({ query: 'recorded native query' }))
  return { ...f, requests, order, policy, search, searchFiber }
}

describe('governed native Messages search', () => {
  it('uses the authorized route and records actual personal usage for its verified actor', async () => {
    const f = await nativeSearchFixture('deepseek-official')
    const release = vi.fn(async () => { f.order.push('release') })
    const acquire = vi.fn(async () => {
      expect(f.session.snapshotEvents().find(event => event.type === 'web/deepseek-search-llm-request')?.data)
        .toMatchObject({ body: { model: 'deepseek-v4-flash' } })
      f.order.push('admit')
      return { signal: new AbortController().signal, release, uncertain: vi.fn() }
    })
    f.ctx.provide('resourceBudget', { acquire })
    expect((await f.search()).sources).toHaveLength(1)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({ path: '/anthropic/v1/messages', headers: { 'x-api-key': 'personal-native-secret' } })
    const event = f.session.snapshotEvents().find(event => event.type === 'web/deepseek-search-llm-request')
    expect(event?.data).toMatchObject({ body: f.requests[0]?.body })
    expect(f.order).toEqual(['admit', 'http', 'release'])
    expect(acquire).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(await f.records()).toEqual([expect.objectContaining({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', purpose: 'web-search',
      sessionId: f.session.id, actorUserId: 7, executionInputIds: ['input-a', 'input-b'],
      credentialSource: 'file', credentialClass: 'personal', status: 'succeeded', usage: { inputTokens: 3, outputTokens: 2 },
    })])
    expect(JSON.stringify(await f.records())).not.toContain('personal-native-secret')
  })

  it('refuses forbidden native routes before acquiring a model permit or contacting HTTP', async () => {
    const f = await nativeSearchFixture()
    await f.policy(false)
    const acquire = vi.fn(async () => { throw new Error('Forbidden native search reached resource admission.') })
    f.ctx.provide('resourceBudget', { acquire })
    await expect(f.search()).rejects.toMatchObject({ cause: { code: 'MODEL_FORBIDDEN' } })
    expect(f.requests).toHaveLength(0)
    expect(acquire).not.toHaveBeenCalled()
    expect(await f.records()).toEqual([expect.objectContaining({ purpose: 'web-search', actorUserId: 7, status: 'denied' })])
  })

  it.each(['model', 'execution', 'withdrawal'] as const)('rechecks %s authority after native model admission', async (change) => {
    const f = await nativeSearchFixture()
    f.ctx.provide('modelAccessRequired', true)
    const entered = Promise.withResolvers<undefined>(), granted = Promise.withResolvers<undefined>()
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    f.ctx.provide('resourceBudget', { acquire: async () => {
      entered.resolve(undefined)
      await granted.promise
      return { signal: new AbortController().signal, release, uncertain }
    } })
    const result = f.search()
    const rejected = expect(result).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    try {
      await Promise.race([entered.promise, result.then(() => { throw new Error('Native search did not wait for admission.') })])
      if (change === 'model') await f.policy(false)
      else if (change === 'execution') f.authority.allowed = false
      else await f.governanceFiber.dispose()
      granted.resolve(undefined)
      await rejected
      expect(f.requests).toHaveLength(0)
      expect(release).toHaveBeenCalledOnce()
      expect(uncertain).not.toHaveBeenCalled()
    } finally {
      granted.resolve(undefined)
      await Promise.allSettled([result, rejected])
    }
  })
})

describe('governed Sonar search', () => {
  it('records the exact request and personal usage against the verified executing actor', async () => {
    const f = await nativeSearchFixture(undefined, 'sonar', true)
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    const acquire = vi.fn(async () => {
      expect(f.session.snapshotEvents().find(event => event.type === 'web/perplexity-search-llm-request')?.data)
        .toMatchObject({ body: { model: 'sonar', max_tokens: 64 } })
      return { signal: new AbortController().signal, release, uncertain }
    })
    f.ctx.provide('resourceBudget', { acquire })
    expect((await f.search()).sources).toHaveLength(1)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({ path: '/sonar/v1/chat/completions', headers: { authorization: 'Bearer personal-native-secret' },
      body: { model: 'sonar', max_tokens: 64, messages: [{ role: 'user', content: 'recorded native query' }] } })
    const logged = f.session.snapshotEvents().find(event => event.type === 'web/perplexity-search-llm-request')
    expect(logged?.data).toMatchObject({ body: f.requests[0]?.body })
    expect(acquire).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
    expect(await f.records()).toEqual([expect.objectContaining({
      provider: 'sonar-owned', model: 'sonar', purpose: 'web-search', sessionId: f.session.id,
      actorUserId: 7, executionInputIds: ['input-a', 'input-b'], credentialSource: 'file', credentialClass: 'personal',
      status: 'succeeded', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    })])
  })

  it.each(['model', 'execution', 'withdrawal', 'unload'] as const)('refuses HTTP when %s changes while model admission waits', async (change) => {
    const f = await nativeSearchFixture(undefined, 'sonar')
    f.ctx.provide('modelAccessRequired', true)
    const entered = Promise.withResolvers<undefined>(), granted = Promise.withResolvers<undefined>()
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    f.ctx.provide('resourceBudget', { acquire: async () => {
      entered.resolve(undefined); await granted.promise
      return { signal: new AbortController().signal, release, uncertain }
    } })
    const result = f.search()
    const rejected = expect(result).rejects.toMatchObject({ code: change === 'unload' ? 'WEB_ABORTED' : 'WEB_PROVIDER_ERROR' })
    let disposal: Promise<void> | undefined
    try {
      await Promise.race([entered.promise, result.then(() => { throw new Error('Sonar search did not wait for admission.') })])
      if (change === 'model') await f.policy(false)
      else if (change === 'execution') f.authority.allowed = false
      else if (change === 'withdrawal') await f.governanceFiber.dispose()
      else disposal = f.searchFiber.dispose()
      granted.resolve(undefined)
      await rejected
      await disposal
      expect(f.requests).toHaveLength(0)
      expect(release).toHaveBeenCalledOnce()
      expect(uncertain).not.toHaveBeenCalled()
    } finally {
      granted.resolve(undefined)
      await Promise.allSettled([result, rejected, disposal])
    }
  })
})

it('refuses queued model dispatch after policy-owner withdrawal', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>(), granted = Promise.withResolvers<undefined>()
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  cleanups.push(async () => { granted.resolve(undefined) })
  f.ctx.provide('resourceBudget', { acquire: async () => {
    entered.resolve(undefined)
    await granted.promise
    return { signal: new AbortController().signal, release, uncertain }
  } })
  const result = f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options()))
  await Promise.race([entered.promise, result.then(() => { throw new Error('Model dispatch did not wait for admission.') })])
  await f.governanceFiber.dispose()
  expect(f.ctx.get('modelAccess')).toBeUndefined()
  granted.resolve(undefined)
  const chunks = await result
  expect(f.adapter.requests).toHaveLength(0)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_POLICY_UNAVAILABLE' } } })
  expect(release).toHaveBeenCalledOnce()
  expect(uncertain).not.toHaveBeenCalled()
})

it('refuses managed calls created while the policy owner is absent', async () => {
  const f = await fixture()
  f.ctx.provide('modelAccessRequired', true)
  await f.governanceFiber.dispose()
  const acquire = vi.fn(async () => { throw new Error('Missing policy reached resource admission.') })
  f.ctx.provide('resourceBudget', { acquire })
  const chunks = await f.drain(f.options())
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_POLICY_UNAVAILABLE' } } })
  expect(acquire).not.toHaveBeenCalled()
  expect(f.adapter.requests).toHaveLength(0)
})

it('retains policy ownership before asynchronous model preparation', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  cleanups.push(async () => { proceed.resolve(undefined) })
  const prepare = f.adapter.prepareCall.bind(f.adapter)
  vi.spyOn(f.adapter, 'prepareCall').mockImplementation(async (...args) => {
    entered.resolve(undefined)
    await proceed.promise
    return prepare(...args)
  })
  const result = f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options()))
  await Promise.race([entered.promise, result.then(() => { throw new Error('Model preparation did not pause.') })])
  await f.governanceFiber.dispose()
  proceed.resolve(undefined)
  const chunks = await result
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_POLICY_UNAVAILABLE' } } })
  expect(f.adapter.requests).toHaveLength(0)
})

describe('verified execution billing', () => {
  it('skips initial authorization for an already cancelled request', async () => {
    const f = await fixture()
    const chunks = await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ signal: AbortSignal.abort(new Error('cancelled before admission')) })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
    expect(f.authority.calls).toHaveLength(0)
    expect(f.adapter.physical).toBe(0)
    expect(await f.records()).toMatchObject([{ status: 'cancelled' }])
  })

  it('discards a late authorization result after caller cancellation', async () => {
    const f = await fixture(), caller = new AbortController()
    vi.spyOn(f.authority, 'authorize').mockImplementation(async () => { caller.abort(new Error('cancelled during authorization')); return f.authority.state })
    const chunks = await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ signal: caller.signal })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
    expect(f.adapter.physical).toBe(0)
    expect(await f.records()).toMatchObject([{ status: 'cancelled' }])
  })

  it('records caller cancellation during initial attribution as cancelled usage', async () => {
    const f = await fixture(), caller = new AbortController(), reason = new Error('caller cancelled authorization')
    vi.spyOn(f.authority, 'authorize').mockImplementation(async () => { caller.abort(reason); throw reason })
    const chunks = await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ signal: caller.signal })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
    expect(f.adapter.physical).toBe(0)
    expect(await f.records()).toMatchObject([{ status: 'cancelled' }])
  })

  it('refuses supplied Auto witnesses without a live executing Agent', async () => {
    const f = await fixture()
    const chunks = await f.drain(f.options({ purpose: 'auto-review', sessionId: f.session.id,
      executionIdentity: { inputs: f.authority.state.inputs, primaryActorUserId: 7 } }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_EXECUTION_IDENTITY_FAILED' } } })
    expect(f.adapter.physical).toBe(0)
    expect(await f.records()).toMatchObject([{ actorUserId: 7, status: 'failed' }])
  })

  it('preserves both late usage records when policy unloads with two queued calls', async () => {
    const f = await fixture(), entered = Promise.withResolvers<undefined>(), firstGrant = Promise.withResolvers<undefined>(), secondGrant = Promise.withResolvers<undefined>()
    const otherSession = Session.create(SessionId('other-pending'))
    const other = { id: otherSession.id, session: otherSession, ctx: f.ctx } as Agent
    const detach = f.ctx.agents.enter(f.agent, undefined), detachOther = f.ctx.agents.enter(other, undefined)
    cleanups.push(async () => { detachOther(); detach() })
    f.authority.states.set(other.id, { ...f.authority.state, inputs: ['input-c' as ExecutionInputId], primaryActorUserId: 8 })
    let admitted = 0, released = 0
    f.ctx.provide('resourceBudget', { acquire: async (request: { sessionId: SessionId }) => {
      if (++admitted === 2) entered.resolve(undefined)
      await (request.sessionId === f.agent.id ? firstGrant.promise : secondGrant.promise)
      return { signal: new AbortController().signal, release: async () => { released++ }, uncertain: async () => { throw new Error('model permits must settle') } }
    } } as never)
    const first = f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ sessionId: f.session.id })))
    const second = f.ctx.agents.withInitiator(other, () => f.drain(f.options({ sessionId: other.id })))
    try {
      await entered.promise
      await f.governanceFiber.dispose()
      firstGrant.resolve(undefined)
      expect((await first).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
      expect(await f.records()).toMatchObject([{ actorUserId: 7, status: 'failed' }])
      secondGrant.resolve(undefined)
      expect((await second).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
      expect(await f.records()).toEqual(expect.arrayContaining([
        expect.objectContaining({ actorUserId: 7, status: 'failed' }), expect.objectContaining({ actorUserId: 8, status: 'failed' }),
      ]))
      expect(released).toBe(2)
      expect(f.adapter.physical).toBe(0)
    } finally { firstGrant.resolve(undefined); secondGrant.resolve(undefined); await Promise.allSettled([first, second]) }
  })

  it('keeps infrastructure usage unattributed in an ambient captured scope', async () => {
    const f = await fixture(), detach = f.ctx.agents.enter(f.agent, undefined)
    cleanups.push(async () => { detach() })
    vi.spyOn(f.authority, 'current').mockReturnValue({ parentSessionId: f.agent.id, inputs: f.authority.state.inputs, unverifiedHistory: false, primaryActorUserId: 7 })
    await f.drain(f.options({ purpose: 'session-title', resourceOrigin: 'infrastructure' }))
    expect(f.adapter.physical).toBe(1)
    expect(f.authority.calls).toHaveLength(0)
    const records = await f.records()
    expect(records).toHaveLength(1)
    expect(records[0]).not.toHaveProperty('actorUserId')
    expect(records[0]).not.toHaveProperty('executionInputIds')
  })

  it('keeps a traced infrastructure request independent of a later Session execution', async () => {
    const f = await fixture(), detach = f.ctx.agents.enter(f.agent, undefined)
    cleanups.push(async () => { detach() })
    f.authority.states.set(f.agent.id, { ...f.authority.state, revision: '2',
      inputs: ['later-input' as ExecutionInputId], actors: [{ userId: 8 }], primaryActorUserId: 8 })
    vi.spyOn(f.authority, 'current').mockImplementation(() => { throw new Error('The enclosing execution has ended') })
    const chunks = await f.drain(f.options({ sessionId: f.session.id, purpose: 'session-title', resourceOrigin: 'infrastructure' }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(f.adapter.physical).toBe(1)
    const records = await f.records()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ sessionId: f.session.id, purpose: 'session-title', status: 'succeeded' })
    expect(records[0]).not.toHaveProperty('actorUserId')
    expect(records[0]).not.toHaveProperty('executionInputIds')
    expect(f.authority.calls).toHaveLength(0)
  })

  it('keeps untraced infrastructure calls independent of an ambient executing Agent', async () => {
    const f = await fixture()
    await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ purpose: 'session-title', resourceOrigin: 'infrastructure' })))
    expect(f.adapter.physical).toBe(1)
    expect(f.authority.calls).toHaveLength(0)
    const records = await f.records()
    expect(records[0]).not.toHaveProperty('sessionId')
    expect(records[0]).not.toHaveProperty('actorUserId')
    expect(records[0]).not.toHaveProperty('executionInputIds')
  })

  it('retains explicitly supplied infrastructure billing proof without borrowing ambient execution', async () => {
    const f = await fixture()
    await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ purpose: 'session-title', resourceOrigin: 'infrastructure',
      sessionId: f.session.id, executionIdentity: { inputs: f.authority.state.inputs, primaryActorUserId: 7 } })))
    expect(f.adapter.physical).toBe(1)
    expect(f.authority.calls).toHaveLength(0)
    expect(await f.records()).toMatchObject([{ sessionId: f.session.id, actorUserId: 7, executionInputIds: f.authority.state.inputs }])
  })

  it('does not infer legacy infrastructure billing from participants in copied messages', async () => {
    const f = await fixture(false, true)
    const message = createUserMessage({ content: [{ type: 'text', text: 'copied title source' }],
      source: Object.assign({ kind: 'user' as const }, { participant: { userId: 99, scope: { kind: 'project', projectId: 99 } } }) })
    await f.drain(f.options({ purpose: 'session-title', resourceOrigin: 'infrastructure', sessionId: f.session.id, messages: [message] }))
    expect(f.adapter.physical).toBe(1)
    const records = await f.records()
    expect(records[0]).not.toHaveProperty('actorUserId')
    expect(records[0]).not.toHaveProperty('actorProjectId')
  })

  it.each(['infrastructure', 'execution'] as const)('retains explicit Session ownership under an unrelated initiator for %s', async (origin) => {
    const f = await fixture(), otherSession = Session.create(SessionId('unrelated-initiator'))
    const other = { id: otherSession.id, session: otherSession, ctx: f.ctx } as Agent
    const detach = f.ctx.agents.enter(f.agent, undefined), detachOther = f.ctx.agents.enter(other, undefined)
    cleanups.push(async () => { detachOther(); detach() })
    let admitted = 0, released = 0
    f.ctx.provide('resourceBudget', { acquire: async (request: { sessionId: SessionId }) => {
      expect(request).toMatchObject({ kind: 'model', origin, sessionId: f.session.id })
      admitted++
      return { signal: new AbortController().signal, release: async () => { released++ }, uncertain: async () => {} }
    } })
    const chunks = await f.ctx.agents.withInitiator(other, () => f.drain(f.options({
      sessionId: f.session.id, purpose: 'session-title', resourceOrigin: origin,
    })))
    if (origin === 'execution') {
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_ATTRIBUTION_CONFLICT' } } })
      expect(f.adapter.physical).toBe(0)
      expect(admitted).toBe(0)
    } else {
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(f.adapter.physical).toBe(1)
      expect(admitted).toBe(1)
      expect(released).toBe(1)
      const records = await f.records()
      expect(records[0]).toMatchObject({ sessionId: f.session.id, status: 'succeeded' })
      expect(records[0]).not.toHaveProperty('actorUserId')
      expect(records[0]).not.toHaveProperty('executionInputIds')
    }
  })

  it('refuses a fresh authorization result without a billing primary', async () => {
    const f = await fixture(), { primaryActorUserId: _primary, ...state } = f.authority.state
    f.authority.state = state
    const chunks = await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options()))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_EXECUTION_IDENTITY_FAILED' } } })
    expect(f.adapter.physical).toBe(0)
  })

  it('refuses an explicit Session belonging to another asynchronous initiator', async () => {
    const f = await fixture()
    const chunks = await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ sessionId: SessionId('other-owner') })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_ATTRIBUTION_CONFLICT' } } })
    expect(f.authority.calls).toHaveLength(0)
    expect(f.adapter.physical).toBe(0)
    expect(await f.records()).toMatchObject([{ sessionId: 'other-owner', status: 'failed' }])
  })

  it('closes an admitted transport and preserves partial usage when its consumer stops early', async () => {
    const f = await fixture(), release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    f.ctx.provide('resourceBudget', { acquire: async () => ({ signal: new AbortController().signal, release, uncertain }) } as never)
    await f.ctx.agents.withInitiator(f.agent, async () => {
      for await (const _chunk of f.ctx.llm.stream(f.options())) break
    })
    expect(f.adapter.physical).toBe(1)
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
    expect(await f.records()).toEqual([expect.objectContaining({ actorUserId: 7, status: 'cancelled', usage: { inputTokens: 3, outputTokens: 2 } })])
  })

  it('retains managed classification after an optional authority appears and disappears while queued', async () => {
    const f = await fixture(false, true), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
    const acquire = vi.fn(async () => {
      entered.resolve(undefined)
      await proceed.promise
      return { signal: new AbortController().signal, release: async () => {}, uncertain: async () => { throw new Error('model permit must settle') } }
    })
    f.ctx.provide('resourceBudget', { acquire } as never)
    const operation = f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options()))
    try {
      await entered.promise
      const authority = await f.ctx.plugin(Authority)
      await authority.dispose()
      proceed.resolve(undefined)
      expect((await operation).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_EXECUTION_IDENTITY_FAILED' } } })
      expect((await f.drain(f.options())).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_EXECUTION_IDENTITY_FAILED' } } })
      expect(acquire).toHaveBeenCalledOnce()
      expect(f.adapter.physical).toBe(0)
    } finally { proceed.resolve(undefined); await operation }
  })

  it('refuses a physical dispatch check without a retained stream owner while allowing model selection', async () => {
    const f = await fixture()
    expect(f.ctx.modelAccess.decide({ provider: 'p', model: 'm' })).toEqual({ allowed: true })
    await expect(f.ctx.waterfall(f.ctx.llm, 'llm/pre-dispatch', f.options(), async () => {}))
      .rejects.toMatchObject({ code: 'MODEL_EXECUTION_IDENTITY_FAILED' })
    expect(f.adapter.physical).toBe(0)
  })

  it('records an early consumer stop when the downstream iterator has no close method', async () => {
    const f = await fixture()
    await f.ctx.agents.withInitiator(f.agent, async () => {
      const stream = f.ctx.waterfall(f.ctx.llm, 'llm/stream', f.options(), () => ({
        [Symbol.asyncIterator]() {
          return { async next(): Promise<IteratorResult<StreamChunk>> {
            return { done: false, value: { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } } }
          } }
        },
      }))
      for await (const _chunk of stream) break
    })
    expect(await f.records()).toEqual([expect.objectContaining({ actorUserId: 7, executionInputIds: ['input-a', 'input-b'], credentialSource: 'unknown', credentialClass: 'unknown', status: 'cancelled', usage: { inputTokens: 3, outputTokens: 2 } })])
  })

  it.each(['billing', 'preparation', 'authorization', 'physical'] as const)('retains the issuing authority during %s', async (phase) => {
    const f = await fixture(), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
    const detach = f.ctx.agents.enter(f.agent, undefined)
    cleanups.push(async () => { detach() })
    const pause = async () => { entered.resolve(undefined); await proceed.promise }
    if (phase === 'billing') {
      const authorize = f.authority.authorize.bind(f.authority)
      vi.spyOn(f.authority, 'authorize').mockImplementation(async (...args) => { await pause(); return authorize(...args) })
    }
    if (phase === 'preparation') {
      const prepare = f.adapter.prepareCall.bind(f.adapter)
      vi.spyOn(f.adapter, 'prepareCall').mockImplementation(async (...args) => { await pause(); return prepare(...args) })
    }
    if (phase === 'authorization') f.ctx.on('llm/authorize', pause, { global: true })
    if (phase === 'physical') f.adapter.beforePhysical = pause
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {}), acquire = vi.fn(async () => ({ signal: new AbortController().signal, release, uncertain }))
    f.ctx.provide('resourceBudget', { acquire } as never)
    const operation = f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ purpose: 'compaction', sessionId: f.session.id })))
    try {
      await Promise.race([entered.promise, operation.then(() => { throw new Error('Model operation did not pause.') })])
      await f.authorityFiber.dispose()
      await f.ctx.plugin(Authority)
      proceed.resolve(undefined)
      const chunks = await operation
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_EXECUTION_IDENTITY_FAILED' } } })
      expect(f.adapter.physical).toBe(0)
      expect(f.adapter.requests).toHaveLength(phase === 'physical' ? 1 : 0)
      expect(acquire).toHaveBeenCalledTimes(phase === 'billing' ? 0 : 1)
      expect(release).toHaveBeenCalledTimes(phase === 'billing' ? 0 : 1)
      expect(uncertain).not.toHaveBeenCalled()
      const records = await f.records()
      expect(records).toMatchObject([{ status: 'failed' }])
      if (phase === 'billing') expect(records[0]).not.toHaveProperty('actorUserId')
      else expect(records[0]).toMatchObject({ actorUserId: 7, executionInputIds: ['input-a', 'input-b'] })
    } finally { proceed.resolve(undefined); await operation }
  })

  it.each(['inputs', 'primary'] as const)('refuses changed billing %s while a request waits for capacity', async (change) => {
    const f = await fixture(), release = vi.fn(async () => {})
    const detach = f.ctx.agents.enter(f.agent, undefined)
    cleanups.push(async () => { detach() })
    f.ctx.provide('resourceBudget', { acquire: async () => {
      f.authority.state = { ...f.authority.state, ...change === 'inputs' ? { inputs: ['input-c' as ExecutionInputId] } : { primaryActorUserId: 8 } }
      return { signal: new AbortController().signal, release, uncertain: async () => { throw new Error('model permit must settle') } }
    } } as never)
    const chunks = await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ sessionId: f.session.id, purpose: 'compaction' })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_EXECUTION_IDENTITY_FAILED' } } })
    expect(f.adapter.physical).toBe(0)
    expect(release).toHaveBeenCalledOnce()
    expect(await f.records()).toMatchObject([{ actorUserId: 7, executionInputIds: ['input-a', 'input-b'], status: 'failed' }])
  })

  it('keeps two queued accounts separate when only one loses execution permission', async () => {
    const f = await fixture(), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
    const otherSession = Session.create(SessionId('other-execution'))
    const other = { id: otherSession.id, session: otherSession, ctx: f.ctx } as Agent
    const detach = f.ctx.agents.enter(f.agent, undefined), detachOther = f.ctx.agents.enter(other, undefined)
    cleanups.push(async () => { detachOther(); detach() })
    f.authority.states.set(other.id, { ...f.authority.state, inputs: ['input-c' as ExecutionInputId], primaryActorUserId: 8 })
    let admitted = 0, released = 0
    f.ctx.provide('resourceBudget', { acquire: async () => {
      if (++admitted === 2) entered.resolve(undefined)
      await proceed.promise
      return { signal: new AbortController().signal, release: async () => { released++ }, uncertain: async () => { throw new Error('model permits must settle') } }
    } } as never)
    const first = f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ sessionId: f.session.id })))
    const second = f.ctx.agents.withInitiator(other, () => f.drain(f.options({ sessionId: other.id })))
    try {
      await entered.promise
      f.authority.deniedSessions.add(f.agent.id)
      proceed.resolve(undefined)
      const chunks = await Promise.all([first, second])
      expect(chunks[0]?.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
      expect(chunks[1]?.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(f.adapter.requests).toHaveLength(1)
      expect(f.adapter.requests[0]?.sessionId).toBe(other.id)
      expect(f.adapter.physical).toBe(1)
      expect(released).toBe(2)
      expect(await f.records()).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: f.session.id, actorUserId: 7, status: 'failed' }),
        expect.objectContaining({ sessionId: other.id, actorUserId: 8, status: 'succeeded' }),
      ]))
    } finally { proceed.resolve(undefined); await Promise.allSettled([first, second]) }
  })

  it.each(['same', 'different'] as const)('retains the issuing authority across a queued compaction request with %s replacement state', async (state) => {
    const f = await fixture(), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
    const detach = f.ctx.agents.enter(f.agent, undefined)
    cleanups.push(async () => { detach() })
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    f.ctx.provide('resourceBudget', { acquire: async () => {
      entered.resolve(undefined)
      await proceed.promise
      return { signal: new AbortController().signal, release, uncertain }
    } } as never)
    const operation = f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ sessionId: f.session.id, purpose: 'compaction' })))
    try {
      await Promise.race([entered.promise, operation.then(() => { throw new Error('Model capacity did not pause.') })])
      await f.authorityFiber.dispose()
      await f.ctx.plugin(Authority)
      if (state === 'different') (f.ctx.executionAuthority as Authority).state = { ...f.authority.state, inputs: ['input-c' as ExecutionInputId], primaryActorUserId: 8 }
      proceed.resolve(undefined)
      const chunks = await operation
      expect(f.adapter.requests).toHaveLength(0)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_EXECUTION_IDENTITY_FAILED' } } })
      expect(release).toHaveBeenCalledOnce()
      expect(uncertain).not.toHaveBeenCalled()
      expect(await f.records()).toEqual([expect.objectContaining({ actorUserId: 7, executionInputIds: ['input-a', 'input-b'], status: 'failed' })])
    } finally { proceed.resolve(undefined); await operation }
  })

  it('meters every browser callback against its fresh verified actor and Session', async () => {
    const f = await fixture()
    f.adapter.browserOutput = true
    const detach = f.ctx.agents.enter(f.agent, undefined)
    cleanups.push(async () => { detach() })
    const request = { messages: [{ role: 'user', content: { type: 'text', text: 'Inspect browser state' } }] }
    const generate = () => f.ctx.agents.withInitiator(f.agent, () => generateStagehandModel(f.agent,
      { provider: 'p', model: 'm' }, request, new AbortController().signal))
    await generate()
    f.authority.state = { ...f.authority.state, primaryActorUserId: 8, inputs: ['input-c' as ExecutionInputId] }
    await generate()
    expect(f.adapter.requests).toHaveLength(2)
    expect(f.authority.calls.every(call => call.agent === f.agent && call.capability === 'execute')).toBe(true)
    expect(await f.records()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: f.session.id, actorUserId: 7, executionInputIds: ['input-a', 'input-b'], status: 'succeeded', usage: { inputTokens: 3, outputTokens: 2 } }),
      expect.objectContaining({ sessionId: f.session.id, actorUserId: 8, executionInputIds: ['input-c'], status: 'succeeded', usage: { inputTokens: 3, outputTokens: 2 } }),
    ]))
    expect(f.session.snapshotEvents().filter(event => event.type === 'browser-use/stagehand-llm-request')).toHaveLength(2)
  })

  it.each(['execution', 'model'] as const)('refuses browser dispatch when %s permission changes during admission', async (kind) => {
    const f = await fixture()
    f.adapter.browserOutput = true
    const detach = f.ctx.agents.enter(f.agent, undefined)
    cleanups.push(async () => { detach() })
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    f.ctx.provide('resourceBudget', { acquire: async () => {
      if (kind === 'execution') f.authority.allowed = false
      else await writeFile(join(f.root, 'model-governance.json'), JSON.stringify({
        version: 1, defaultAllowed: false, userDeclaredAllowed: false,
        models: [{ provider: 'p', model: 'm', allowed: false }], providers: [],
        intakeUrl: 'http://127.0.0.1:1/usage', intakeToken: 'fixture-token',
      }))
      return { signal: new AbortController().signal, release, uncertain }
    } } as never)
    await expect(f.ctx.agents.withInitiator(f.agent, () => generateStagehandModel(f.agent,
      { provider: 'p', model: 'm' }, { messages: [] }, new AbortController().signal))).rejects.toThrow()
    expect(f.adapter.requests).toEqual([])
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
    expect(await f.records()).toEqual([expect.objectContaining({ actorUserId: 7, status: kind === 'model' ? 'denied' : 'failed' })])
  })

  it('records one Auto review against its supplied primary even when durable display participants disagree', async () => {
    const f = await fixture()
    const detach = f.ctx.agents.enter(f.agent, undefined)
    cleanups.push(async () => { detach() })
    const message = createUserMessage({ content: [{ type: 'text', text: 'private prompt' }], source: Object.assign({ kind: 'user' as const }, { participant: { userId: 99, scope: { kind: 'project', projectId: 99 } } }) })
    const chunks = await f.drain(f.options({ purpose: 'auto-review', sessionId: f.session.id, messages: [message],
      executionIdentity: { inputs: f.authority.state.inputs, primaryActorUserId: 7 } }))
    expect(chunks.map(chunk => chunk.type)).toEqual(['usage', 'finish'])
    const records = await f.records()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ purpose: 'auto-review', sessionId: f.session.id, actorUserId: 7, executionInputIds: ['input-a', 'input-b'], usage: { inputTokens: 3, outputTokens: 2 }, status: 'succeeded' })
    expect(records[0]).not.toHaveProperty('actorProjectId')
    expect(JSON.stringify(records)).not.toContain('private prompt')
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.authority.calls.length).toBeGreaterThan(0)
    expect(f.authority.calls.every(call => call.agent === f.agent && call.capability === 'auto-review')).toBe(true)
  })

  it('uses the actual asynchronous initiator and fresh authority for ordinary model usage', async () => {
    const f = await fixture()
    expect(await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options()))).toMatchObject([{ type: 'usage' }, { type: 'finish' }])
    expect(f.authority.calls.length).toBeGreaterThan(0)
    expect(f.authority.calls.every(call => call.agent === f.agent && call.capability === 'execute')).toBe(true)
    expect(await f.records()).toMatchObject([{ actorUserId: 7, executionInputIds: ['input-a', 'input-b'], sessionId: f.session.id }])
  })

  it('refuses explicit Session dispatch when its captured owner became unavailable during admission', async () => {
    const f = await fixture()
    const current = vi.spyOn(f.authority, 'current')
    cleanups.push(async () => { current.mockRestore() })
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    f.ctx.provide('resourceBudget', {
      acquire: async () => {
        current.mockImplementation(() => { throw new Error('captured execution owner unavailable') })
        return { signal: new AbortController().signal, release, uncertain }
      },
    } as never)
    const chunks = await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options({ sessionId: f.session.id })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(f.adapter.requests).toHaveLength(0)
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
    expect(f.authority.calls).toEqual([{ agent: f.agent, capability: 'execute' }])
    expect(await f.records()).toMatchObject([{ status: 'failed' }])
    expect(await f.records()).toHaveLength(1)
  })

  it.each(['provider-missing', 'primary-missing', 'session-missing', 'agent-missing', 'refused'] as const)('rejects %s before dispatch instead of guessing a billing actor', async (failure) => {
    const f = await fixture()
    if (failure === 'provider-missing') await f.authorityFiber.dispose()
    if (failure === 'refused') f.authority.allowed = false
    const request = f.options({ purpose: 'auto-review', ...failure === 'session-missing' ? {} : { sessionId: f.session.id },
      ...failure === 'agent-missing' || failure === 'refused' ? {} : { executionIdentity: { inputs: f.authority.state.inputs, ...failure === 'primary-missing' ? {} : { primaryActorUserId: 7 } } } })
    const chunks = failure === 'refused' ? await f.ctx.agents.withInitiator(f.agent, () => f.drain(request)) : await f.drain(request)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_EXECUTION_IDENTITY_FAILED' } } })
    expect(f.adapter.requests).toHaveLength(0)
    expect(await f.records()).toMatchObject([{ status: 'failed' }])
  })

  it('keeps cold auxiliary calls explicitly unattributed without taking participant claims as proof', async () => {
    const f = await fixture()
    const message = createUserMessage({ content: [{ type: 'text', text: 'title input' }], source: Object.assign({ kind: 'user' as const }, { participant: { userId: 99, scope: { kind: 'project', projectId: 99 } } }) })
    await f.drain(f.options({ purpose: 'session-title', sessionId: f.session.id, messages: [message] }))
    const records = await f.records()
    expect(records).toHaveLength(1)
    expect(records[0]).not.toHaveProperty('actorUserId')
    expect(records[0]).not.toHaveProperty('executionInputIds')
  })

  it('retains rejected proof records without retrying as an actorless bill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-proof-outbox-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    let resolveReceived!: () => void
    let rejectReceived!: (error: unknown) => void
    const received = new Promise<void>((resolve, reject) => { resolveReceived = resolve; rejectReceived = reject })
    const bodies: unknown[] = []
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(400).end('{}')
        resolveReceived()
      })().catch(error => rejectReceived(error))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const outbox = new UsageOutbox(root, `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/usage`, 'fixture-token')
    cleanups.push(() => outbox.close())
    const record: UsageRecord = { eventId: 'proof-rejection', occurredAt: 1, provider: 'p', model: 'm', purpose: 'auto-review', sessionId: 'session', actorUserId: 7, executionInputIds: ['input-a'], credentialSource: 'organization', credentialClass: 'company', status: 'succeeded' }
    outbox.enqueue(record)
    await received
    await outbox.close()
    expect(bodies).toEqual([record])
    expect(JSON.parse(await readFile(join(root, 'proof-rejection.json'), 'utf8'))).toEqual(record)
  })
})
