/** Upstream model-route preference behavior through the authenticated BFF. */
import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope as makeScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { IApiClient, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  SubagentModelSelectionCardController, subagentModelCandidates,
  type SubagentModelSelectionSettings,
} from '../src/client/subagent-model-selection-card-controller.ts'

function stubSettingsScope<T>() {
  const host = makeScope<T>()
  const mutate = vi.fn(async (_ops: SettingsPathOpView[], _revision?: number) => {})
  return { ...host, mutate, scope: { ...host.scope, mutate } }
}

function acceptWrites<T>(host: ReturnType<typeof stubSettingsScope<T>>): void {
  host.mutate.mockImplementation(async (ops) => {
    const value = { ...host.scope.getSnapshot().value as object }
    for (const op of ops) {
      if (op.op === 'set') Object.assign(value, { [op.path[0]!]: op.value })
    }
    host.publish({ value: value as T, write: { status: 'idle' } })
  })
}

function ctxWith(namespaces: { session: { modelCatalog: () => Promise<unknown> } }): Pick<IApiClient, 'llm'> {
  return { llm: { models: async () => ({ rpcId: 'models', result: await namespaces.session.modelCatalog() }) } } as never
}

function modelsApi(options: {
  groups?: readonly {
    id: string
    name: string
    models: readonly { id: string; name: string }[]
  }[]
  failures?: readonly { id: string; name: string; message: string }[]
  error?: string
} = {}) {
  const models = vi.fn(() => Promise.resolve({
    ...(options.error === undefined
      ? { ok: true as const, value: { groups: options.groups ?? [], failures: options.failures ?? [] } }
      : { ok: false as const, error: { code: 'gateway/internal', message: options.error } }),
  }))
  return { ctx: ctxWith({ session: { modelCatalog: models } }), models }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('SubagentModelSelectionCardController', () => {
  it('joins stored routes with the live catalog without dropping unavailable choices', () => {
    const candidates = subagentModelCandidates(
      [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
      [{ provider: 'legacy', model: 'old' }],
      new Set(['legacy\0old']),
    )

    expect(candidates).toEqual([
      {
        key: 'alpha\0fast', provider: 'alpha', model: 'fast', providerName: 'Alpha API',
        modelName: 'Fast', available: true, selected: false,
      },
      {
        key: 'legacy\0old', provider: 'legacy', model: 'old', providerName: 'legacy',
        modelName: 'old', available: false, selected: true,
      },
    ])
  })

  it('loads adapter models and saves the switch and routes atomically', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    acceptWrites(host)
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({
      status: 'ready', writable: true, revision: 3,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const face = controller.inject()

    expect(face.hooks.subagentModelSelectionCard.getSnapshot().enabled).toBe(false)
    face.toggleEnabled()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1)
    })
    face.toggleModel('alpha\0fast')
    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
      ], 3)
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: true,
      dirty: false,
      saving: false,
      failed: false,
    })
  })

  it('starts an empty draft when a ready test scope has no decoded value', () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const controller = new SubagentModelSelectionCardController(host.scope, modelsApi().ctx)
    host.publish({ status: 'ready', writable: true, revision: 0, value: undefined })
    const face = controller.inject()

    face.toggleEnabled()

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: true, dirty: true, invalid: true,
    })
  })

  it('keeps the Host value and reports a rejected write', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })
    const face = controller.inject()

    face.toggleEnabled()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1)
    })
    face.toggleModel('alpha\0fast')
    face.save()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().failed).toBe(true)
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: true,
      dirty: true,
      saving: false,
    })
  })

  it('loads stored routes, stages removal and disablement, and discards both', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
      failures: [{ id: 'beta', name: 'Beta', message: 'offline' }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({
      status: 'ready', writable: true, revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] }, user: {},
    })
    const face = controller.inject()
    const state = () => face.hooks.subagentModelSelectionCard.getSnapshot()
    await vi.waitFor(() => { expect(state().catalogStatus).toBe('ready') })
    expect(state().catalogPartial).toBe(true)

    face.toggleModel('missing')
    expect(state().dirty).toBe(false)
    face.toggleModel('alpha\0fast')
    expect(state()).toMatchObject({ dirty: true, invalid: true })
    face.discard()
    expect(state()).toMatchObject({ dirty: false, invalid: false, enabled: true })

    face.toggleEnabled()
    expect(state()).toMatchObject({ dirty: true, enabled: false })
    face.toggleEnabled()
    expect(state()).toMatchObject({ dirty: false, enabled: true })
  })

  it('retains selected routes when disabling and loads an already-ready enabled card', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    acceptWrites(host)
    host.publish({
      status: 'ready', writable: true, revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] }, user: {},
    })
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    const face = controller.inject()
    await vi.waitFor(() => { expect(models.models).toHaveBeenCalledOnce() })

    face.toggleEnabled()
    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['enabled'], value: false },
        { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
      ], 5)
    })
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: false, dirty: false,
    })
  })

  it('reports a directory error and retries it', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelsApi({ error: 'offline' })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })
    const face = controller.inject()
    const state = () => face.hooks.subagentModelSelectionCard.getSnapshot()

    face.toggleEnabled()
    await vi.waitFor(() => { expect(state().catalogStatus).toBe('error') })
    face.retryCatalog()
    await vi.waitFor(() => { expect(models.models).toHaveBeenCalledTimes(2) })
  })

  it('rejects a draft after the Host revision changes', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({
      status: 'ready', writable: true, revision: 4,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const face = controller.inject()
    face.toggleEnabled()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1)
    })
    face.toggleModel('alpha\0fast')

    host.publish({
      revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'other', model: 'new' }] },
    })
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: true, failed: false, dirty: true,
    })
    face.save()
    await Promise.resolve()

    expect(host.mutate).not.toHaveBeenCalled()
    face.discard()
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: false, failed: false, dirty: false, enabled: true,
    })
  })

  it('settles a draft when a newer Host revision already contains it', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    host.publish({
      status: 'ready', writable: true, revision: 4,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const face = controller.inject()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1) })
    face.toggleModel('alpha\0fast')

    host.publish({
      revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] },
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: false, dirty: false, enabled: true,
    })
  })

  it('retains unsaved routes across a catalog refresh', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    acceptWrites(host)
    host.publish({
      status: 'ready', writable: true, revision: 2,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const refreshed = deferred<never>()
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: true, value: {
          groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
          failures: [],
        },
      })
      .mockImplementationOnce(() => refreshed.promise)
    const controller = new SubagentModelSelectionCardController(
      host.scope, ctxWith({ session: { modelCatalog: models } }),
    )
    const face = controller.inject()
    const state = () => face.hooks.subagentModelSelectionCard.getSnapshot()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(state().candidates).toHaveLength(1) })
    face.toggleModel('alpha\0fast')

    controller.refreshCatalog()
    expect(state()).toMatchObject({
      catalogStatus: 'loading',
      candidates: [expect.objectContaining({ key: 'alpha\0fast', selected: true })],
    })
    refreshed.resolve({
      ok: true, value: { groups: [], failures: [] },
    } as never)
    await vi.waitFor(() => { expect(state().catalogStatus).toBe('ready') })
    expect(state().candidates).toEqual([
      expect.objectContaining({ key: 'alpha\0fast', available: false, selected: true }),
    ])

    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
      ], 2)
    })
  })

  it('drops a draft when the connection generation changes', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    host.publish({
      status: 'ready', writable: true, revision: 4,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.ctx)
    const face = controller.inject()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1) })
    face.toggleModel('alpha\0fast')

    controller.resetConnection()
    host.publish({
      revision: 4,
      value: { enabled: true, allowedModels: [{ provider: 'other', model: 'new' }] },
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: false, dirty: false, enabled: true,
    })
    face.save()
    await Promise.resolve()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('reloads the model catalog after invalidation', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    host.publish({
      status: 'ready', writable: true, revision: 1,
      value: { enabled: true, allowedModels: [] }, user: {},
    })
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: true, value: {
          groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
          failures: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true, value: {
          groups: [{ id: 'beta', name: 'Beta', models: [{ id: 'new', name: 'New' }] }],
          failures: [],
        },
      })
    const controller = new SubagentModelSelectionCardController(
      host.scope, ctxWith({ session: { modelCatalog: models } }),
    )
    const state = () => controller.inject().hooks.subagentModelSelectionCard.getSnapshot()
    await vi.waitFor(() => { expect(state().candidates[0]?.provider).toBe('alpha') })

    controller.refreshCatalog()

    await vi.waitFor(() => { expect(state().candidates[0]?.provider).toBe('beta') })
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('suppresses duplicate actions and late save settlements', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const catalog = modelsApi({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const write = deferred<undefined>()
    const mutate = vi.fn(async (ops: readonly SettingsPathOpView[]) => {
      await write.promise
      const enabled = ops.find(op => op.path[0] === 'enabled')
      const allowedModels = ops.find(op => op.path[0] === 'allowedModels')
      host.publish({ value: {
        enabled: enabled?.op === 'set' ? enabled.value as boolean : false,
        allowedModels: allowedModels?.op === 'set' ? allowedModels.value as never[] : [],
      } })
    })
    const controller = new SubagentModelSelectionCardController({ ...host.scope, mutate }, catalog.ctx)
    const face = controller.inject()

    face.save()
    face.toggleModel('alpha\0fast')
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })
    face.save()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(face.hooks.subagentModelSelectionCard.getSnapshot().catalogStatus).toBe('ready') })
    face.save()
    face.toggleModel('alpha\0fast')
    face.save()
    expect(face.hooks.subagentModelSelectionCard.getSnapshot().saving).toBe(true)
    face.toggleEnabled()
    face.toggleModel('alpha\0fast')
    face.save()
    face.discard()
    controller.dispose()
    write.resolve(undefined)
    await write.promise
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('suppresses duplicate directory loads and late settlements', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })

    const pending = deferred<never>()
    const models = vi.fn(() => pending.promise)
    const controller = new SubagentModelSelectionCardController(host.scope, ctxWith({ session: { modelCatalog: models } }))
    const face = controller.inject()
    face.toggleEnabled()
    face.retryCatalog()
    expect(models).toHaveBeenCalledOnce()
    controller.dispose()
    pending.resolve({ ok: false, error: { code: 'gateway/internal', message: 'late failure' } } as never)
    await pending.promise

    const pendingResolve = deferred<never>()
    const resolving = new SubagentModelSelectionCardController(
      host.scope,
      ctxWith({ session: { modelCatalog: () => pendingResolve.promise } }),
    )
    const resolvingFace = resolving.inject()
    resolvingFace.toggleEnabled()
    resolving.dispose()
    pendingResolve.resolve({
      ok: true, value: { groups: [], failures: [] },
    } as never)
    await pendingResolve.promise
  })

  it('ignores writes while read-only and scope notifications after disposal', () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const controller = new SubagentModelSelectionCardController(host.scope, modelsApi().ctx)
    host.publish({ status: 'ready', writable: false, writableReason: 'project', value: { enabled: false, allowedModels: [] }, user: {} })
    const face = controller.inject()

    face.toggleEnabled()
    face.toggleModel('alpha\0fast')
    face.save()
    expect(host.mutate).not.toHaveBeenCalled()

    controller.dispose()
    controller.refreshCatalog()
    controller.resetConnection()
    face.toggleEnabled()
    face.retryCatalog()
    face.save()
    host.publish({ value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] } })
    expect(host.mutate).not.toHaveBeenCalled()
    expect(face.hooks.subagentModelSelectionCard.getSnapshot().enabled).toBe(false)
  })
})


describe('model preference transport failures', () => {
  it('retains drafts after a thrown write and recovers on retry', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    host.publish({ status: 'ready', writable: true, revision: 2,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] } })
    host.mutate.mockRejectedValueOnce(new Error('offline'))
    const controller = new SubagentModelSelectionCardController(host.scope, modelsApi().ctx)
    const face = controller.inject()
    face.toggleEnabled()
    face.save()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({ failed: true, saving: false, dirty: true })
    })
    acceptWrites(host)
    face.save()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({ failed: false, dirty: false })
    })
    controller.dispose()
  })

  it('reports a thrown catalog request and suppresses failures after disposal', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    host.publish({ status: 'ready', writable: true, value: { enabled: true, allowedModels: [] } })
    const pending = deferred<never>()
    const models = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => pending.promise)
    const controller = new SubagentModelSelectionCardController(host.scope, ctxWith({ session: { modelCatalog: models } }))
    const face = controller.inject()
    await vi.waitFor(() => { expect(face.hooks.subagentModelSelectionCard.getSnapshot().catalogStatus).toBe('error') })
    face.retryCatalog()
    controller.dispose()
    pending.reject(new Error('late failure'))
    await Promise.resolve()
  })

  it('ignores a failed save from a retired connection generation', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    host.publish({ status: 'ready', writable: true,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] } })
    const pending = deferred<undefined>()
    host.mutate.mockImplementationOnce(() => pending.promise)
    const controller = new SubagentModelSelectionCardController(host.scope, modelsApi().ctx)
    const face = controller.inject()
    face.toggleEnabled()
    face.save()
    controller.resetConnection()
    pending.reject(new Error('retired'))
    await Promise.resolve()
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({ failed: false, saving: false, dirty: false })
    controller.dispose()
  })
})
