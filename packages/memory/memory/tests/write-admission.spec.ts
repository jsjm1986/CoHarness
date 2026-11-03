/** Queued member authority and authoritative memory mutation outcomes. */
import { Context } from '@deepseek-ai/cordis'
import type { CollaborationAuthority, CollaborationParticipant } from '@deepseek-ai/dsh-collaboration'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentFor, memoryHarness, settingsStub } from './harness.ts'

const contexts: Context[] = []
const project = { kind: 'project' as const }
const personal = { kind: 'personal' as const }
const input = { key: 'entry', kind: 'guidance' as const, summary: 'remember', content: 'original' }
const member: CollaborationParticipant = {
  userId: 7, username: 'member', displayName: 'Member', role: 'user',
  scope: { kind: 'project', projectId: 1, projectName: 'Project', mode: 'rw' },
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('queued member memory writes', () => {
  it('refuses a member writer without captured authority when collaboration is composed', async () => {
    const test = await memoryHarness({ beforeService: (ctx) => {
      ctx.provide('collaboration', { capture: () => ({
        participant: member, expiresAt: Date.now() + 30_000, signal: new AbortController().signal,
      }) })
    } })
    contexts.push(test.ctx)
    await expect(test.service.save({ ...input, scope: personal }, { kind: 'member' }))
      .rejects.toMatchObject({ code: 'collaboration-forbidden' })
  })

  it('refuses a member writer without authority while a required provider is missing', async () => {
    const test = await memoryHarness({ beforeService: (ctx) => { ctx.provide('collaborationRequired', true) } })
    contexts.push(test.ctx)
    await expect(test.service.save({ ...input, scope: personal }, { kind: 'member' }))
      .rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } })
    expect(await test.service.read(personal, input.key)).toBeUndefined()
  })

  it.each(['save', 'delete'] as const)('keeps managed %s denied during collaboration provider replacement', async (operation) => {
    let participant = member
    let withdraw!: () => void
    const lifetime = new AbortController()
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => {
        ctx.provide('collaborationRequired', true)
        withdraw = ctx.provide('collaboration', { capture: () => ({
          participant, expiresAt: Date.now() + 30_000, signal: lifetime.signal,
        }) })
      },
    })
    contexts.push(test.ctx)
    if (operation === 'delete') await test.service.memberSave({ ...input, scope: project })
    const mutate = () => operation === 'save'
      ? test.service.memberSave({ ...input, scope: project })
      : test.service.memberDelete({ scope: project, key: input.key })
    participant = { ...member, scope: { kind: 'project', projectId: 1, projectName: 'Project', mode: 'ro' } }
    await expect(mutate()).rejects.toMatchObject({ code: 'collaboration-forbidden' })
    lifetime.abort()
    withdraw()
    await expect(mutate()).rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } })
    expect((await test.service.memberScopes()).scopes[0]?.writable).toBe(false)
    expect((await test.service.read(project, input.key))?.content).toBe(operation === 'save' ? undefined : 'original')
    test.ctx.provide('collaboration', { capture: () => ({
      participant: member, expiresAt: Date.now() + 30_000, signal: new AbortController().signal,
    }) })
    await expect(mutate()).resolves.toMatchObject({ ok: true })
  })

  it('commits a delete while the captured member remains authorized', async () => {
    const lifetime = new AbortController()
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('collaboration', { capture: () => ({
        participant: member, expiresAt: Date.now() + 30_000, signal: lifetime.signal,
      }) }) },
    })
    contexts.push(test.ctx)
    await test.service.memberSave({ ...input, scope: project })
    await expect(test.service.memberDelete({ scope: project, key: input.key })).resolves.toMatchObject({
      ok: true, operation: 'delete',
    })
    expect(await test.service.read(project, input.key)).toBeUndefined()
  })

  it.each([
    ['save', 'expiry'], ['delete', 'expiry'], ['save', 'provider-unload'], ['delete', 'provider-unload'],
  ] as const)('refuses a queued %s after authority %s', async (operation, revocation) => {
    const lifetime = new AbortController()
    const now = vi.spyOn(Date, 'now').mockReturnValue(100)
    const authority: CollaborationAuthority = {
      participant: member, expiresAt: 200, signal: lifetime.signal,
      authorize: async () => { throw new Error('scope writes do not authorize a Session') },
      capabilities: () => ({ actions: ['read', 'write'] }),
      readableSessionIds: async () => new Set(),
      claimInteraction: async () => false,
    }
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('collaboration', { capture: () => authority }) },
    })
    contexts.push(test.ctx)
    if (operation === 'delete') await test.service.memberSave({ ...input, scope: project })
    const entered = gate()
    const release = gate()
    test.ctx.provide('executionAuthority', {
      authorize: async () => { entered.resolve(); await release.promise; return { primaryActorUserId: 7 } },
    })
    const agent = agentFor(test.ctx)
    const holding = test.service.save({ ...input, key: 'holding', scope: project }, { kind: 'agent', agent })
    await entered.promise
    const queued = operation === 'save'
      ? test.service.memberSave({ ...input, scope: project })
      : test.service.memberDelete({ scope: project, key: input.key })
    const outcome = queued.then(value => ({ value }), (error: unknown) => ({ error }))
    if (revocation === 'expiry') now.mockReturnValue(200)
    else lifetime.abort(new Error('provider disposed'))
    release.resolve()
    expect((await holding).ok).toBe(true)
    expect(await outcome).toMatchObject({
      error: { code: 'collaboration-forbidden', details: { reason: revocation === 'expiry' ? 'forbidden' : 'gateway-unavailable' } },
    })
    expect((await test.service.read(project, input.key))?.content).toBe(operation === 'save' ? undefined : 'original')
  })
})

describe('member authority during cursor persistence', () => {
  it.each(['save', 'delete'] as const)('refuses an independent %s when collaboration becomes required before the entry mutation', async (operation) => {
    const entered = gate()
    const release = gate()
    let block = false
    const test = await memoryHarness({
      beforeOpen: (backend) => {
        const open = backend.kv.open.bind(backend.kv)
        backend.kv.open = async (descriptor) => {
          const unit = await open(descriptor)
          const put = unit.putRecord.bind(unit)
          unit.putRecord = async (table, key, value) => {
            if (table === 'cursors' && block) { entered.resolve(); await release.promise }
            await put(table, key, value)
          }
          return unit
        }
      },
    })
    contexts.push(test.ctx)
    if (operation === 'delete') await test.service.memberSave({ ...input, scope: personal })
    block = true
    const mutation = operation === 'save'
      ? test.service.memberSave({ ...input, scope: personal })
      : test.service.memberDelete({ scope: personal, key: input.key })
    const outcome = mutation.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await entered.promise
      test.ctx.provide('collaborationRequired', true)
      release.resolve()
      expect(await outcome).toMatchObject({ error: { code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } } })
      expect((await test.service.read(personal, input.key))?.content).toBe(operation === 'save' ? undefined : 'original')
    } finally {
      release.resolve()
      await outcome
    }
  })

  it.each([
    ['save', 'expiry'], ['delete', 'expiry'], ['save', 'provider-unload'], ['delete', 'provider-unload'],
  ] as const)('refuses %s when authority %s while persisting its marker', async (operation, revocation) => {
    const lifetime = new AbortController()
    const now = vi.spyOn(Date, 'now').mockReturnValue(100)
    const entered = gate()
    const release = gate()
    let block = false
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('collaboration', { capture: () => ({
        participant: member, expiresAt: 200, signal: lifetime.signal,
      }) }) },
      beforeOpen: (backend) => {
        const open = backend.kv.open.bind(backend.kv)
        backend.kv.open = async (descriptor) => {
          const unit = await open(descriptor)
          const put = unit.putRecord.bind(unit)
          unit.putRecord = async (table, key, value) => {
            if (table === 'cursors' && block) { entered.resolve(); await release.promise }
            await put(table, key, value)
          }
          return unit
        }
      },
    })
    contexts.push(test.ctx)
    if (operation === 'delete') await test.service.memberSave({ ...input, scope: project })
    block = true
    const mutation = operation === 'save'
      ? test.service.memberSave({ ...input, scope: project })
      : test.service.memberDelete({ scope: project, key: input.key })
    const outcome = mutation.then(value => ({ value }), (error: unknown) => ({ error }))
    await entered.promise
    if (revocation === 'expiry') now.mockReturnValue(200)
    else lifetime.abort()
    release.resolve()
    expect(await outcome).toMatchObject({ error: { code: 'collaboration-forbidden' } })
    expect((await test.service.read(project, input.key))?.content).toBe(operation === 'save' ? undefined : 'original')
  })
})

describe('agent memory write admission', () => {
  it.each([
    ['save', 'cancelled'], ['delete', 'cancelled'],
    ['save', 'provider-replaced'], ['delete', 'provider-replaced'],
    ['save', 'provider-removed'], ['delete', 'provider-removed'],
    ['save', 'disabled'], ['delete', 'disabled'],
  ] as const)('refuses %s when its admission becomes %s during the final permission check', async (operation, revocation) => {
    const entered = gate()
    const release = gate()
    const lifetime = new AbortController()
    const cancellation = new Error('cancelled during the final permission check')
    const switches = { enabled: true, extraction: false, consolidation: false, recall: false }
    let checks = 0
    const authorize = vi.fn(async () => {
      checks += 1
      if (checks === 2) { entered.resolve(); await release.promise }
      return { primaryActorUserId: 7 }
    })
    let withdraw!: () => void
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => {
        ctx.provide('settings', settingsStub(switches) as never)
        withdraw = ctx.provide('executionAuthority', { authorize })
      },
    })
    contexts.push(test.ctx)
    if (operation === 'delete') await test.service.memberSave({ ...input, scope: project })
    const writer = { kind: 'agent' as const, agent: agentFor(test.ctx), signal: lifetime.signal }
    const mutation = operation === 'save'
      ? test.service.save({ ...input, scope: project }, writer)
      : test.service.delete({ scope: project, key: input.key }, writer)
    const outcome = mutation.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await entered.promise
      if (revocation === 'cancelled') lifetime.abort(cancellation)
      else if (revocation === 'disabled') switches.enabled = false
      else {
        withdraw()
        if (revocation === 'provider-replaced') test.ctx.provide('executionAuthority', { authorize: async () => ({ primaryActorUserId: 8 }) })
      }
      release.resolve()
      if (revocation === 'cancelled') expect(await outcome).toEqual({ error: cancellation })
      else if (revocation === 'disabled') {
        expect(await outcome).toEqual({ value: { ok: false, code: 'memory_invalid', reason: 'scope-unavailable' } })
      } else expect(await outcome).toMatchObject({ error: { code: 'execution/forbidden' } })
      expect((await test.service.read(project, input.key))?.content).toBe(operation === 'save' ? undefined : input.content)
      expect(authorize).toHaveBeenCalledTimes(2)
    } finally {
      release.resolve()
      await outcome
    }
  })

  it.each(['save', 'delete'] as const)('keeps %s bound to the original participants through its final permission check', async (operation) => {
    const entered = gate()
    const release = gate()
    let block = false
    let actor = 7
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => { ctx.provide('executionAuthority', { authorize: async () => ({ primaryActorUserId: actor }) }) },
      beforeOpen: (backend) => {
        const open = backend.kv.open.bind(backend.kv)
        backend.kv.open = async (descriptor) => {
          const unit = await open(descriptor)
          const put = unit.putRecord.bind(unit)
          unit.putRecord = async (table, key, value) => {
            if (block && table === 'cursors') { entered.resolve(); await release.promise }
            await put(table, key, value)
          }
          return unit
        }
      },
    })
    contexts.push(test.ctx)
    if (operation === 'delete') await test.service.memberSave({ ...input, scope: project })
    block = true
    const writer = { kind: 'agent' as const, agent: agentFor(test.ctx) }
    const mutation = operation === 'save'
      ? test.service.save({ ...input, scope: project }, writer)
      : test.service.delete({ scope: project, key: input.key }, writer)
    const outcome = mutation.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await entered.promise
      actor = 8
      release.resolve()
      expect(await outcome).toMatchObject({ error: { code: 'execution/forbidden' } })
      expect((await test.service.read(project, input.key))?.content).toBe(operation === 'save' ? undefined : input.content)
    } finally {
      release.resolve()
      await outcome
    }
  })

  it.each(['save', 'delete'] as const)('refuses %s after its execution provider is replaced during authorization', async (operation) => {
    const entered = gate()
    const release = gate()
    let withdraw!: () => void
    const test = await memoryHarness({
      config: { space: 'project' },
      beforeService: (ctx) => {
        withdraw = ctx.provide('executionAuthority', {
          authorize: async () => { entered.resolve(); await release.promise; return { primaryActorUserId: 7 } },
        })
      },
    })
    contexts.push(test.ctx)
    if (operation === 'delete') await test.service.memberSave({ ...input, scope: project })
    const writer = { kind: 'agent' as const, agent: agentFor(test.ctx) }
    const mutation = operation === 'save'
      ? test.service.save({ ...input, scope: project }, writer)
      : test.service.delete({ scope: project, key: input.key }, writer)
    const outcome = mutation.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await entered.promise
      withdraw()
      test.ctx.provide('executionAuthority', { authorize: async () => { throw new Error('replacement denies memory') } })
      release.resolve()
      expect(await outcome).toMatchObject({ error: { code: 'execution/forbidden' } })
      expect((await test.service.read(project, input.key))?.content).toBe(operation === 'save' ? undefined : 'original')
    } finally {
      release.resolve()
      await outcome
    }
  })

  it.each([
    ['save', 'cancelled'], ['delete', 'cancelled'],
    ['save', 'provider-replaced'], ['delete', 'provider-replaced'],
    ['save', 'provider-removed'], ['delete', 'provider-removed'],
    ['save', 'disabled'], ['delete', 'disabled'],
  ] as const)('refuses %s when its admission becomes %s during cursor persistence', async (operation, revocation) => {
    const entered = gate()
    const release = gate()
    const cancellation = new Error('memory operation cancelled')
    const lifetime = new AbortController()
    const switches = { enabled: true, extraction: false, consolidation: false, recall: false }
    const authorize = vi.fn(async () => ({ primaryActorUserId: 7 }))
    let withdraw!: () => void
    let block = false
    const scope = revocation.startsWith('provider-') || revocation === 'disabled' ? project : personal
    const test = await memoryHarness({
      config: { space: scope.kind === 'project' ? 'project' : 'personal' },
      beforeService: (ctx) => {
        ctx.provide('settings', settingsStub(switches) as never)
        withdraw = ctx.provide('executionAuthority', { authorize })
      },
      beforeOpen: (backend) => {
        const open = backend.kv.open.bind(backend.kv)
        backend.kv.open = async (descriptor) => {
          const unit = await open(descriptor)
          const put = unit.putRecord.bind(unit)
          unit.putRecord = async (table, key, value) => {
            if (table === 'cursors' && block) { entered.resolve(); await release.promise }
            await put(table, key, value)
          }
          return unit
        }
      },
    })
    contexts.push(test.ctx)
    if (operation === 'delete') await test.service.memberSave({ ...input, scope })
    block = true
    const writer = { kind: 'agent' as const, agent: agentFor(test.ctx), signal: lifetime.signal }
    const mutation = operation === 'save'
      ? test.service.save({ ...input, scope }, writer)
      : test.service.delete({ scope, key: input.key }, writer)
    const outcome = mutation.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await entered.promise
      if (revocation === 'cancelled') lifetime.abort(cancellation)
      else if (revocation === 'disabled') switches.enabled = false
      else {
        withdraw()
        if (revocation === 'provider-replaced') {
          test.ctx.provide('executionAuthority', { authorize: async () => { throw new Error('replacement denies memory') } })
        }
      }
      release.resolve()
      if (revocation === 'cancelled') expect(await outcome).toEqual({ error: cancellation })
      else if (revocation === 'disabled') {
        expect(await outcome).toEqual({ value: { ok: false, code: 'memory_invalid', reason: 'scope-unavailable' } })
      } else expect(await outcome).toMatchObject({ error: { code: 'execution/forbidden' } })
      expect((await test.service.read(scope, input.key))?.content).toBe(operation === 'save' ? undefined : 'original')
      expect(authorize).toHaveBeenCalledTimes(scope.kind === 'project' ? 1 : 0)
    } finally {
      release.resolve()
      await outcome
    }
  })

  it.each(['save', 'delete'] as const)('does not admit an already cancelled personal %s', async (operation) => {
    const test = await memoryHarness()
    contexts.push(test.ctx)
    if (operation === 'delete') await test.service.memberSave({ ...input, scope: personal })
    const cancellation = new Error('cancelled before queue admission')
    const lifetime = new AbortController()
    lifetime.abort(cancellation)
    const writer = { kind: 'agent' as const, agent: agentFor(test.ctx), signal: lifetime.signal }
    const mutation = operation === 'save'
      ? test.service.save({ ...input, scope: personal }, writer)
      : test.service.delete({ scope: personal, key: input.key }, writer)
    await expect(mutation).rejects.toBe(cancellation)
    expect((await test.service.read(personal, input.key))?.content).toBe(operation === 'save' ? undefined : 'original')
  })
})

describe('memory commit outcomes', () => {
  it.each(['create', 'update', 'delete'] as const)('keeps a %s uncommitted when the required cursor write fails', async (operation) => {
    let cursorFailure = false
    const failure = new Error('cursor medium unavailable')
    const test = await memoryHarness({ beforeOpen: (backend) => {
      const open = backend.kv.open.bind(backend.kv)
      backend.kv.open = async (descriptor) => {
        const unit = await open(descriptor)
        const put = unit.putRecord.bind(unit)
        unit.putRecord = (table, key, value) => table === 'cursors' && cursorFailure
          ? Promise.reject(failure)
          : put(table, key, value)
        return unit
      }
    } })
    contexts.push(test.ctx)
    if (operation !== 'create') await test.service.memberSave({ ...input, scope: personal })
    const changed = vi.fn()
    test.ctx.on('memory/changed', changed)
    cursorFailure = true
    const mutation = operation === 'delete'
      ? test.service.memberDelete({ scope: personal, key: input.key })
      : test.service.memberSave({
        ...input, scope: personal, content: 'replacement',
        ...(operation === 'update' ? { expectedRevision: (await test.service.read(personal, input.key))!.revision } : {}),
      })
    await expect(mutation).rejects.toBe(failure)
    expect((await test.service.read(personal, input.key))?.content).toBe(operation === 'create' ? undefined : 'original')
    expect(changed).not.toHaveBeenCalled()
  })

  it.each(['create', 'update', 'delete'] as const)('reports a committed %s when a memory observer throws', async (operation) => {
    const test = await memoryHarness()
    contexts.push(test.ctx)
    if (operation !== 'create') await test.service.memberSave({ ...input, scope: personal })
    test.ctx.on('memory/changed', () => { throw new Error('observer failed') })
    const revision = (await test.service.read(personal, input.key))?.revision
    const mutation = operation === 'delete'
      ? test.service.memberDelete({ scope: personal, key: input.key })
      : test.service.memberSave({ ...input, scope: personal, ...(revision === undefined ? {} : { expectedRevision: revision }) })
    await expect(mutation).resolves.toMatchObject({ ok: true, operation })
    expect((await test.service.read(personal, input.key))?.content).toBe(operation === 'delete' ? undefined : input.content)
  })
})
