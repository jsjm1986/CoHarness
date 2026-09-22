import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ExecutionAuthority, type ExecutionCapability, type ExecutionInheritance, type ExecutionInputId, type ExecutionState } from '@deepseek-ai/dsh-execution-authority'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type MessageId, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as Governance from '../src/index.ts'
import { UsageOutbox, type UsageRecord } from '../src/outbox.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  vi.unstubAllEnvs()
  if (errors.length > 0) throw new AggregateError(errors, 'billing fixture cleanup failed')
})

class Authority extends ExecutionAuthority {
  allowed = true
  readonly calls: Array<{ agent: Agent; capability: ExecutionCapability }> = []
  state: ExecutionState = { revision: '1', inputs: ['input-a' as ExecutionInputId, 'input-b' as ExecutionInputId], actors: [{ userId: 7 }, { userId: 8 }], primaryActorUserId: 7, unverifiedHistory: false }
  stamp(_session: Session, _message: UserMessage): Promise<UserMessage> { throw new Error('billing fixture has no input transport') }
  answer(_session: Session, _questionId: string, _answer: unknown): Promise<boolean> { throw new Error('billing fixture has no questions') }
  capture(_agent: Agent): ExecutionInheritance { throw new Error('billing fixture does not delegate') }
  captureSession(_sessionId: SessionId): Promise<ExecutionInheritance> { throw new Error('billing fixture does not capture another Session') }
  inherit(_session: Session, _scope: ExecutionInheritance): void { throw new Error('billing fixture does not inherit') }
  relay(_session: Session, _scope: ExecutionInheritance, _messageId: MessageId): Promise<ExecutionInheritance> {
    throw new Error('billing fixture does not relay')
  }
  async authorize(capability: ExecutionCapability, agent: Agent): Promise<ExecutionState> {
    this.calls.push({ capability, agent })
    if (!this.allowed) throw new Error('execution refused')
    return this.state
  }
  async authorizeSelection(_agent: Agent, _preset: string): Promise<void> { throw new Error('billing fixture has no preset selection') }
}

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'organization' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(managed = true) {
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
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['p'], adapter)
  await ctx.plugin(Governance)
  const records = async (): Promise<UsageRecord[]> => {
    const files = await readdir(join(root, 'model-governance-outbox'))
    return Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(root, 'model-governance-outbox', name), 'utf8')) as UsageRecord))
  }
  const session = Session.create(SessionId('actual-execution'))
  const agent = { id: session.id, session } as Agent
  const options = (extra: Partial<GenerateOptions> = {}): GenerateOptions => ({ provider: 'p', model: 'm', messages: [], ...extra })
  const drain = async (request: GenerateOptions) => { const chunks: StreamChunk[] = []; for await (const chunk of ctx.llm.stream(request)) chunks.push(chunk); return chunks }
  return { ctx, authority: ctx.executionAuthority as Authority, authorityFiber, adapter, agent, session, records, options, drain }
}

describe('verified execution billing', () => {
  it('records one Auto review against its supplied primary even when durable display participants disagree', async () => {
    const f = await fixture()
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
    expect(f.authority.calls).toHaveLength(0)
  })

  it('uses the actual asynchronous initiator and fresh authority for ordinary model usage', async () => {
    const f = await fixture()
    expect(await f.ctx.agents.withInitiator(f.agent, () => f.drain(f.options()))).toMatchObject([{ type: 'usage' }, { type: 'finish' }])
    expect(f.authority.calls).toEqual([{ agent: f.agent, capability: 'execute' }])
    expect(await f.records()).toMatchObject([{ actorUserId: 7, executionInputIds: ['input-a', 'input-b'], sessionId: f.session.id }])
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
    const received = Promise.withResolvers<undefined>()
    const bodies: unknown[] = []
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(400).end('{}')
        received.resolve(undefined)
      })().catch(error => received.reject(error))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
    const outbox = new UsageOutbox(root, `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/usage`, 'fixture-token')
    cleanups.push(() => outbox.close())
    const record: UsageRecord = { eventId: 'proof-rejection', occurredAt: 1, provider: 'p', model: 'm', purpose: 'auto-review', sessionId: 'session', actorUserId: 7, executionInputIds: ['input-a'], credentialSource: 'organization', credentialClass: 'company', status: 'succeeded' }
    outbox.enqueue(record)
    await received.promise
    await outbox.close()
    expect(bodies).toEqual([record])
    expect(JSON.parse(await readFile(join(root, 'proof-rejection.json'), 'utf8'))).toEqual(record)
  })
})
