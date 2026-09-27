import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ExecutionAuthority, type ExecutionCapability, type ExecutionInheritance, type ExecutionInputId, type ExecutionState } from '@deepseek-ai/dsh-execution-authority'
import LlmRuntime, { createMessage, LlmAdapter, ToolCallId, type GenerateOptions, type MessageId, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import PermissionPresets, { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import * as AutoReview from '../src/index.ts'

const worlds: Array<{ ctx: Context; root: string }> = []

afterEach(async () => {
  const results = await Promise.allSettled(worlds.splice(0).map(async ({ ctx, root }) => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (errors.length > 0) throw new AggregateError(errors, 'managed Auto fixture cleanup failed')
})

/** A controllable authority provider; the production Loader and tool executor own all dispatch. */
class Authority extends ExecutionAuthority {
  allowed = true
  calls: Array<{ capability: ExecutionCapability; agent: Agent }> = []
  state: ExecutionState = { revision: '1', inputs: ['input-a' as ExecutionInputId], actors: [{ userId: 7 }], primaryActorUserId: 7, unverifiedHistory: false }
  pending: Promise<void> | undefined
  respectsCancellation = true
  entered = Promise.withResolvers<undefined>()
  stamp(_session: Session, _message: UserMessage): Promise<UserMessage> { throw new Error('fixture never stamps inputs') }
  answer(_session: Session, _questionId: string, _answer: unknown): Promise<boolean> { throw new Error('fixture has no questions') }
  capture(_agent: Agent): ExecutionInheritance { throw new Error('fixture never delegates') }
  captureSession(_sessionId: SessionId): Promise<ExecutionInheritance> { throw new Error('fixture never captures another Session') }
  inherit(_session: Session, _scope: ExecutionInheritance): void { throw new Error('fixture never inherits') }
  relay(_session: Session, _scope: ExecutionInheritance, _messageId: MessageId): Promise<ExecutionInheritance> {
    throw new Error('fixture never relays messages')
  }
  async authorize(capability: ExecutionCapability, agent: Agent, signal?: AbortSignal): Promise<ExecutionState> {
    this.calls.push({ capability, agent })
    this.entered.resolve(undefined)
    await this.pending
    if (this.respectsCancellation) signal?.throwIfAborted()
    if (!this.allowed) throw new Error('Auto eligibility revoked')
    return structuredClone(this.state)
  }
  async authorizeSelection(_agent: Agent, _preset: string): Promise<void> { if (!this.allowed) throw new Error('Auto eligibility revoked') }
}

class Reviewer extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly entered = Promise.withResolvers<undefined>()
  release: Promise<void> | undefined
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.entered.resolve(undefined)
    await this.release
    const text = '{"risk":"low","decision":"allow"}'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function world(managed = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-auto-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, await readFile(new URL('./fixtures/managed.cordis.yml', import.meta.url)))
  const ctx = new Context()
  worlds.push({ ctx, root })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  ctx.provide('executionAuthorityRequired', managed)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('fixture has no shell requests') },
    run() { throw new Error('fixture has no shell requests') },
    start() { throw new Error('fixture has no shell requests') },
  })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-tools', ToolRuntime], ['@deepseek-ai/dsh-user-approval', Approval],
    ['fixture:execution-authority', Authority], ['@deepseek-ai/dsh-permission-presets', PermissionPresets],
    ['@deepseek-ai/dsh-experimental-auto-review', AutoReview],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  const authority = ctx.executionAuthority as Authority
  const reviewer = new Reviewer()
  ctx.llm.registerAdapter(['review'], reviewer)
  const output = join(root, 'executed.txt')
  ctx.tools.register(defineContentToolFixture({
    name: 'write_probe', description: 'Write the owned fixture file', parameters: {},
    async execute() { await writeFile(output, 'executed\n'); return [{ type: 'text', text: 'written' }] },
  }))
  const fresh = ctx.sessions.create(SessionId('managed-auto'), { meta: { cwd: root } })
  expect(ctx.permissionPresets.current(fresh)).toBe('workspace-write')
  ctx.permissionPresets.set(fresh, AUTO_PRESET)
  fresh.append('request/header', { reason: 'initial', header: { config: { provider: 'review', model: 'same-model' }, tools: [{ name: 'write_probe', description: 'Write the owned fixture file', parameters: { type: 'object' } }] } })
  const callId = ToolCallId('managed-call')
  fresh.append('step/start', { turn: 1, step: 1 })
  fresh.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'review', model: 'same-model' }, content: [{ type: 'tool-call', id: callId, name: 'write_probe', arguments: '{}' }] }) }, { surfaceOp: 'append' })
  fresh.append('tool/call', { turn: 1, step: 1, callId, name: 'write_probe', arguments: '{}' })
  const execute = (session = fresh, signal = new AbortController().signal) => {
    const agent = { id: session.id, session, options: { provider: 'review', model: 'same-model' } } as Agent
    return ctx.tools.execute({ signal, agent, callId, name: 'write_probe', arguments: {} })
  }
  const autoEntry = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-experimental-auto-review')
  if (autoEntry?.fiber === undefined) throw new Error('Auto Loader entry is not active')
  const authorityEntry = [...ctx.loader.entries()].find(entry => entry.options.name === 'fixture:execution-authority')
  if (authorityEntry?.fiber === undefined) throw new Error('authority Loader entry is not active')
  return { ctx, fresh, authority, reviewer, output, execute, auto: autoEntry.fiber, authorityFiber: authorityEntry.fiber }
}

async function expectNotWritten(output: string) {
  await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('managed Auto execution through Loader', () => {
  it('charges one reviewer to its session and verified primary before the real tool writes', async () => {
    const f = await world()
    expect(await f.execute()).toMatchObject({ isError: false })
    expect(await readFile(f.output, 'utf8')).toBe('executed\n')
    expect(f.reviewer.requests).toHaveLength(1)
    expect(f.reviewer.requests[0]).toMatchObject({ sessionId: f.fresh.id, purpose: 'auto-review', executionIdentity: { inputs: ['input-a'], primaryActorUserId: 7 } })
    expect(f.authority.calls.map(call => call.capability)).toEqual(['auto-review', 'auto-review'])
  })

  it.each(['revoked', 'missing-provider', 'unverified-history', 'missing-primary'] as const)('refuses %s before paying a reviewer or dispatching a body', async (failure) => {
    const f = await world()
    if (failure === 'revoked') f.authority.allowed = false
    if (failure === 'missing-provider') await f.authorityFiber.dispose()
    if (failure === 'unverified-history') f.authority.state = { ...f.authority.state, unverifiedHistory: true }
    if (failure === 'missing-primary') { const { primaryActorUserId: _primary, ...state } = f.authority.state; f.authority.state = state }
    const result = await f.execute()
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'AUTO_REVIEW_DENIED' } } })
    expect(result.error?.info?.reason).toContain('standard permission mode')
    expect(f.reviewer.requests).toHaveLength(0)
    await expectNotWritten(f.output)
  })

  it.each(['revoke', 'inputs', 'primary', 'revision', 'provider', 'provider-and-marker'] as const)(
    'rejects %s changes during a pending allow without a second review', async (change) => {
      const f = await world()
      const release = Promise.withResolvers<undefined>()
      f.reviewer.release = release.promise
      const pending = f.execute()
      try {
        await f.reviewer.entered.promise
        if (change === 'revoke') f.authority.allowed = false
        if (change === 'inputs') f.authority.state = { ...f.authority.state, inputs: ['input-a' as ExecutionInputId, 'input-b' as ExecutionInputId] }
        if (change === 'primary') f.authority.state = { ...f.authority.state, primaryActorUserId: 8 }
        if (change === 'revision') f.authority.state = { ...f.authority.state, revision: '2' }
        if (change === 'provider') await f.authorityFiber.dispose()
        if (change === 'provider-and-marker') {
          f.ctx.executionAuthorityRequired = false
          await f.authorityFiber.dispose()
        }
      } finally { release.resolve(undefined) }
      expect(await pending).toMatchObject({ isError: true, error: { info: { code: 'AUTO_REVIEW_DENIED' } } })
      expect(f.reviewer.requests).toHaveLength(1)
      await expectNotWritten(f.output)
    })

  it('rechecks a restored Auto log without a live browser and refuses a revoked participant', async () => {
    const f = await world()
    const restored = Session.create(f.fresh.id, structuredClone(f.fresh.snapshotEvents()), f.fresh.header)
    f.authority.allowed = false
    expect(f.ctx.permissionPresets.current(restored)).toBe(AUTO_PRESET)
    expect(await f.execute(restored)).toMatchObject({ isError: true })
    expect(f.authority.calls[0]?.agent.session).toBe(restored)
    expect(f.reviewer.requests).toHaveLength(0)
    await expectNotWritten(f.output)
  })

  it.each([true, false])('cancels a delayed authority result before model dispatch (provider cancellation: %s)', async (respects) => {
    const f = await world()
    const release = Promise.withResolvers<undefined>()
    f.authority.pending = release.promise
    f.authority.respectsCancellation = respects
    const controller = new AbortController()
    const pending = f.execute(f.fresh, controller.signal)
    await f.authority.entered.promise
    controller.abort(new Error('caller cancelled'))
    release.resolve(undefined)
    expect(await pending).toMatchObject({ isError: true })
    expect(f.reviewer.requests).toHaveLength(0)
    await expectNotWritten(f.output)
  })

  it('keeps a managed integration closed after both its authority and required marker disappear', async () => {
    const f = await world()
    f.ctx.executionAuthorityRequired = false
    await f.authorityFiber.dispose()
    expect(await f.execute()).toMatchObject({ isError: true })
    expect(f.reviewer.requests).toHaveLength(0)
    await expectNotWritten(f.output)
  })

  it('refuses a local review if the deployment becomes managed before tool dispatch', async () => {
    const f = await world(false)
    await f.authorityFiber.dispose()
    const release = Promise.withResolvers<undefined>()
    f.reviewer.release = release.promise
    const pending = f.execute()
    await f.reviewer.entered.promise
    f.ctx.executionAuthorityRequired = true
    release.resolve(undefined)
    expect(await pending).toMatchObject({ isError: true })
    expect(f.reviewer.requests).toHaveLength(1)
    await expectNotWritten(f.output)
  })

  it.each(['before-review', 'before-body'] as const)('drains unload during authority validation %s without executing', async (stage) => {
    const f = await world()
    const reviewer = Promise.withResolvers<undefined>(), authority = Promise.withResolvers<undefined>()
    f.reviewer.release = reviewer.promise
    if (stage === 'before-review') f.authority.pending = authority.promise
    const pending = f.execute()
    if (stage === 'before-body') {
      await f.reviewer.entered.promise
      f.authority.entered = Promise.withResolvers<undefined>()
      f.authority.pending = authority.promise
      reviewer.resolve(undefined)
    }
    await f.authority.entered.promise
    const disposal = f.auto.dispose()
    authority.resolve(undefined)
    reviewer.resolve(undefined)
    expect(await pending).toMatchObject({ isError: true, error: { info: { name: 'AbortError' } } })
    await disposal
    expect(f.ctx.permissionPresets.current(f.fresh)).toBe('workspace-write')
    await expectNotWritten(f.output)
  })

  it('falls back to the ordinary mode when a managed reviewer is unloaded after authority loss', async () => {
    const f = await world()
    await f.authorityFiber.dispose()
    await f.auto.dispose()
    expect(f.ctx.permissionPresets.current(f.fresh)).toBe('workspace-write')
    expect(f.ctx.permissionPresets.names).not.toContain(AUTO_PRESET)
    expect(f.reviewer.requests).toHaveLength(0)
    await expectNotWritten(f.output)
  })
})
