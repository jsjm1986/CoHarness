/** Browser child control retains its captured collaboration lifetime across awaits. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import Collaboration, { CollaborationError, collaborationCapabilities } from '@deepseek-ai/dsh-collaboration'
import type { CollaborationAuthority, CollaborationSessionCreation } from '@deepseek-ai/dsh-collaboration'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '../src/index.ts'
import type { SubagentPromptRequestId } from '../src/control-types.ts'
import { deliverSubagentPrompt, type HostPromptDeliverer } from '../src/internal.ts'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function fixture(scope: 'personal' | 'project') {
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(AgentRegistry)
  const parentId = SessionId('authority-parent'), childId = SessionId('authority-child')
  const parent = { id: parentId, ctx: ctx.plugin(() => {}).ctx, options: {}, session: Session.create(parentId) } as unknown as Agent
  ctx.agents.register(parent)
  const installProvider = async () => {
    const lifetime = new AbortController()
    const authority: CollaborationAuthority = {
      participant: { userId: 7, username: 'alice', displayName: 'Alice', role: 'user', scope: scope === 'personal'
        ? { kind: 'personal' } : { kind: 'project', projectId: 41, projectName: 'Shared', mode: 'rw' } },
      expiresAt: Date.now() + 60_000, signal: lifetime.signal,
      capabilities() { return collaborationCapabilities(this.participant) },
      authorize: async (sessionId) => {
        if (lifetime.signal.aborted) throw new CollaborationError('gateway-unavailable')
        return { sessionId, rootSessionId: parentId, mode: 'rw', canRead: true, canWrite: true, canManage: false }
      },
      readableSessionIds: async ids => new Set(ids), claimInteraction: async () => true,
    }
    class Provider extends Collaboration {
      constructor(owner: Context) { super(owner); owner.effect(() => () => { lifetime.abort(new Error('provider withdrawn')) }) }
      capture() { if (lifetime.signal.aborted) throw new CollaborationError('gateway-unavailable'); return authority }
      currentCreation() { return undefined }
      withSessionCreation<T>(_creation: CollaborationSessionCreation, operation: () => Promise<T>) { return operation() }
    }
    const provider = ctx.plugin(Provider)
    await provider.await()
    return { authority, provider, lifetime }
  }
  return { ctx, parentId, childId, parent, installProvider, ...await installProvider() }
}

it.each(['personal', 'project'] as const)('refuses %s prompt delivery after its authorizing provider leaves during admission', async (scope) => {
  const f = await fixture(scope), entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  let delivered = 0
  const delivery = vi.spyOn(f.ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt)
    .mockImplementation(async (_parent, _child, _content, _source, signal) => {
      signal.throwIfAborted(); delivered++; return MessageId('unexpected-delivery')
    })
  f.ctx.on('subagent/prompt-admission', async () => { entered.resolve(undefined); await finish.promise; return [{ type: 'text', text: 'admitted input' }] })
  const task = f.ctx.subagents.prompt({ parentSessionId: f.parentId, childSessionId: f.childId,
    requestId: 'authority-prompt' as SubagentPromptRequestId, mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'continue' }] }, new AbortController().signal)
  try {
    await entered.promise
    await f.provider.dispose()
    finish.resolve(undefined)
    await expect(task).rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } })
    expect(delivered).toBe(0)
    expect(delivery).not.toHaveBeenCalled()
  } finally { finish.resolve(undefined); await task.catch(() => {}) }
})

it.each(['personal', 'project'] as const)('withholds %s catalog data when its authorizing provider leaves during the read', async (scope) => {
  const f = await fixture(scope), entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  vi.spyOn(f.ctx.subagents, 'listChildren').mockImplementation(async () => {
    entered.resolve(undefined); await finish.promise
    return [{ kind: 'child', id: f.childId, mode: 'continuable', label: 'private child', activity: 'inactive', hasChildren: false }]
  })
  const task = f.ctx.subagents.remoteExportList(f.parentId, new AbortController().signal)
  try {
    await entered.promise
    await f.provider.dispose()
    finish.resolve(undefined)
    await expect(task).rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } })
  } finally { finish.resolve(undefined); await task.catch(() => {}) }
})

/** One browser message admitted through the public Core operation. */
function prompt(f: Awaited<ReturnType<typeof fixture>>, signal: AbortSignal) {
  return f.ctx.subagents.prompt({ parentSessionId: f.parentId, childSessionId: f.childId,
    requestId: 'authority-delivery' as SubagentPromptRequestId, mode: 'continuable', delivery: 'queue',
    content: [{ type: 'text', text: 'continue' }] }, signal)
}

it.each(['personal', 'project'] as const)('keeps a %s request bound to its original provider when a replacement arrives', async (scope) => {
  const f = await fixture(scope), entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
  const delivery = vi.spyOn(f.ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt).mockResolvedValue(MessageId('fresh-delivery'))
  let calls = 0
  f.ctx.on('subagent/prompt-admission', async () => {
    if (++calls === 1) { entered.resolve(undefined); await finish.promise }
    return [{ type: 'text', text: 'admitted' }]
  })
  const task = prompt(f, new AbortController().signal)
  try {
    await entered.promise
    await f.provider.dispose()
    const replacement = await f.installProvider()
    expect(replacement.authority.signal.aborted).toBe(false)
    finish.resolve(undefined)
    await expect(task).rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } })
    expect(delivery).not.toHaveBeenCalled()
    await expect(prompt(f, new AbortController().signal)).resolves.toEqual({ messageId: 'fresh-delivery' })
    expect(delivery).toHaveBeenCalledTimes(1)
  } finally { finish.resolve(undefined); await task.catch(() => {}) }
})

it.each((['personal', 'project'] as const).flatMap(scope => (['authority', 'caller', 'both'] as const).map(cause => ({ scope, cause }))))(
  'cancels pending $scope delivery through $cause without accepting input', async ({ scope, cause }) => {
    const f = await fixture(scope), caller = new AbortController(), entered = Promise.withResolvers<undefined>()
    let seen: AbortSignal | undefined
    let refuse: ((reason?: unknown) => void) | undefined
    vi.spyOn(f.ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt)
      .mockImplementation((_parent, _child, _content, _source, signal) => {
        seen = signal
        return new Promise((_resolve, reject) => {
          refuse = reject
          signal.addEventListener('abort', () => { reject(new Error('delivery cancelled', { cause: signal.reason })) }, { once: true })
          entered.resolve(undefined)
        })
      })
    const task = prompt(f, caller.signal)
    const observed = task.catch((error: unknown) => error)
    try {
      await entered.promise
      if (cause !== 'authority') caller.abort(new Error('caller left'))
      if (cause !== 'caller') await f.provider.dispose()
      expect(seen?.aborted).toBe(true)
      expect(await observed).toMatchObject(cause === 'authority'
        ? { code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } }
        : { code: 'gateway/cancelled' })
    } finally { refuse?.(new Error('owned delivery cleanup')); await observed }
  },
)

it.each(['personal', 'project'] as const)('refuses a %s interrupt when the authorizing provider leaves as the child check resolves', async (scope) => {
  const f = await fixture(scope)
  const original = f.authority.authorize.bind(f.authority)
  vi.spyOn(f.authority, 'authorize').mockImplementation(async (sessionId, action) => {
    const access = await original(sessionId, action)
    if (sessionId === f.childId) f.lifetime.abort(new Error('authorizing provider left'))
    return access
  })
  const interrupt = vi.spyOn(f.ctx.subagents, 'interrupt')
  await expect(f.ctx.subagents.interruptByParent(f.childId, f.parentId, 'continuable'))
    .rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } })
  expect(interrupt).not.toHaveBeenCalled()
})

it.each((['personal', 'project'] as const).flatMap(scope => (['catalog', 'prompt', 'interrupt'] as const).map(operation => ({ scope, operation }))))(
  'refuses $scope $operation while the required collaboration provider is absent', async ({ scope, operation }) => {
    const f = await fixture(scope)
    await f.provider.dispose()
    const listed = vi.spyOn(f.ctx.subagents, 'listChildren')
    const interrupted = vi.spyOn(f.ctx.subagents, 'interrupt')
    const delivered = vi.spyOn(f.ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt)
    const task = operation === 'catalog' ? f.ctx.subagents.remoteExportList(f.parentId, new AbortController().signal)
      : operation === 'prompt' ? prompt(f, new AbortController().signal)
        : f.ctx.subagents.interruptByParent(f.childId, f.parentId, 'continuable')
    await expect(task).rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } })
    expect(listed).not.toHaveBeenCalled()
    expect(interrupted).not.toHaveBeenCalled()
    expect(delivered).not.toHaveBeenCalled()
  },
)

it.each(['personal', 'project'] as const)('preserves a %s child permission denial without admitting input', async (scope) => {
  const f = await fixture(scope), original = f.authority.authorize.bind(f.authority)
  vi.spyOn(f.authority, 'authorize').mockImplementation(async (sessionId, action) => {
    if (sessionId === f.childId) throw new CollaborationError('forbidden')
    return original(sessionId, action)
  })
  const delivered = vi.spyOn(f.ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt)
  await expect(prompt(f, new AbortController().signal)).rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'forbidden' } })
  expect(delivered).not.toHaveBeenCalled()
})
