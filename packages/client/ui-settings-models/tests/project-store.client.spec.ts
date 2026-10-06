import { describe, expect, it, vi } from 'vitest'
import { ProjectModelsBridge } from '../src/client/project-store.ts'
import type { ProjectModelSettingsTransport, ProjectModelSettingsView } from '@deepseek-ai/dsh-client-connection/client'

function view(revision = 2): ProjectModelSettingsView {
  return {
    projectId: 7,
    revision,
    writable: true,
    hasDocument: false as const,
    namespaces: [{
      ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, base: { providers: {} }, user: { providers: {} },
      applies: 'live' as const, secrets: [], revision,
    }],
    providers: [],
    models: { groups: [], failures: [] },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function tracked<T>(work: Promise<unknown>[], promise: Promise<T>): Promise<T> {
  work.push(Promise.allSettled([promise]))
  return promise
}

async function microtaskBarrier(): Promise<void> {
  await new Promise<void>((resolve) => { queueMicrotask(resolve) })
}

function stub(overrides: Partial<ProjectModelSettingsTransport> = {}): ProjectModelSettingsTransport {
  return {
    get: vi.fn(async () => view()),
    mutate: vi.fn(async () => view()),
    describeCredentials: vi.fn(async () => ({ credentials: {} })),
    setCredential: vi.fn(async () => {}),
    unsetCredential: vi.fn(async () => {}),
    discover: vi.fn(async () => ({ models: [] })),
    ...overrides,
  }
}

function operations(bridge: ProjectModelsBridge) {
  return {
    mutate: () => bridge.api.settings.mutate({
      ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'next', 'baseURL'], value: 'https://next.invalid' }],
    }),
    update: () => bridge.api.settings.update({
      ns: 'llm-pi-ai', patch: { providers: { next: { baseURL: 'https://next.invalid' } } },
    }),
    replace: () => bridge.api.settings.replace({
      ns: 'llm-pi-ai', section: { providers: { next: { baseURL: 'https://next.invalid' } } },
    }),
    describeCredentials: () => bridge.api.credentials.describe({ refs: ['NEXT_API_KEY'] }),
    setCredential: () => bridge.api.credentials.set({ ref: 'NEXT_API_KEY', value: 'key' }),
    unsetCredential: () => bridge.api.credentials.unset({ ref: 'NEXT_API_KEY' }),
    discover: () => bridge.api.llm.discoverModels({ settingsNs: 'llm-pi-ai', provider: 'next' }),
  }
}

describe('ProjectModelsBridge', () => {
  it('returns normally from ensure when its loading subscriber disposes the bridge', async () => {
    const get = vi.fn(async () => view())
    const bridge = new ProjectModelsBridge(7, stub({ get }))
    const work: Promise<unknown>[] = []
    const notifications: string[] = []
    let disposal: Promise<void> | undefined
    let ensured: Promise<void> | undefined
    const unsubscribe = bridge.mirror.subscribe(() => {
      const status = bridge.mirror.getSnapshot().status
      notifications.push(status)
      if (status === 'loading') disposal = tracked(work, bridge.dispose())
    })
    try {
      expect(() => { ensured = tracked(work, bridge.mirror.ensure()) }).not.toThrow()
      expect(ensured).toBeInstanceOf(Promise)
      expect(disposal).toBeInstanceOf(Promise)
      await ensured
      await disposal
      expect(get).not.toHaveBeenCalled()
      expect(notifications).toEqual(['loading'])
      expect(bridge.mirror.getSnapshot()).toMatchObject({ status: 'loading', view: undefined, error: null })
    } finally {
      unsubscribe()
      await Promise.allSettled([...work, bridge.dispose()])
    }
  })

  it('shares one project read between the Models joins and settings mirror', async () => {
    const get = vi.fn(async () => view())
    const transport = {
      get,
      mutate: vi.fn(async () => view()),
      describeCredentials: vi.fn(async () => ({ credentials: {} })),
      setCredential: vi.fn(async () => {}),
      unsetCredential: vi.fn(async () => {}),
      discover: vi.fn(async () => ({ models: [] })),
    }
    const bridge = new ProjectModelsBridge(7, transport)
    const [providers, models, settings] = await Promise.all([
      bridge.api.llm.providers({}), bridge.api.llm.models({}), bridge.mirror.ensure(),
    ])
    expect(providers.result).toMatchObject({ ok: true, value: { providers: [] } })
    expect(models.result).toMatchObject({ ok: true, value: { groups: [], failures: [] } })
    expect(settings).toBeUndefined()
    expect(get).toHaveBeenCalledOnce()
    expect(bridge.mirror.getSnapshot().status).toBe('ready')
  })

  it('refreshes the project snapshot after the first read', async () => {
    const first = view()
    const second = {
      ...view(),
      revision: 3,
      namespaces: [{ ...view().namespaces[0]!, revision: 3 }],
    }
    const get = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const transport = {
      get,
      mutate: vi.fn(async () => second),
      describeCredentials: vi.fn(async () => ({ credentials: {} })),
      setCredential: vi.fn(async () => {}),
      unsetCredential: vi.fn(async () => {}),
      discover: vi.fn(async () => ({ models: [] })),
    }
    const bridge = new ProjectModelsBridge(7, transport)
    await bridge.mirror.ensure()
    await bridge.api.llm.providers({})
    expect(get).toHaveBeenCalledTimes(2)
    expect(bridge.mirror.getSnapshot().view?.namespaces[0]?.revision).toBe(3)
  })

  it('keeps redacted headers and unrelated providers on compatibility updates', async () => {
    const first = {
      ...view(),
      namespaces: [{
        ...view().namespaces[0]!,
        value: {
          providers: {
            relay: { baseURL: 'https://relay.example/v1', headers: { 'x-secret': '[redacted]' } },
            other: { baseURL: 'https://other.example/v1' },
          },
        },
        user: {
          providers: {
            relay: { baseURL: 'https://relay.example/v1', headers: { 'x-secret': '[redacted]' } },
            other: { baseURL: 'https://other.example/v1' },
          },
        },
      }],
    }
    const mutate = vi.fn(async (_projectId: number, _body: unknown) => first)
    const transport = {
      get: vi.fn(async () => first),
      mutate,
      describeCredentials: vi.fn(async () => ({ credentials: {} })),
      setCredential: vi.fn(async () => {}),
      unsetCredential: vi.fn(async () => {}),
      discover: vi.fn(async () => ({ models: [] })),
    }
    const bridge = new ProjectModelsBridge(7, transport)
    await bridge.mirror.ensure()
    await bridge.api.settings.update({ ns: 'llm-pi-ai', patch: {
      providers: { relay: { baseURL: 'https://relay.example/v2', headers: { 'x-secret': '[redacted]' } } },
    } })
    expect(mutate).toHaveBeenCalledWith(7, {
      ops: [{ op: 'set', path: ['providers', 'relay', 'baseURL'], value: 'https://relay.example/v2' }],
      expectedRevision: 2,
    })
  })

  it('applies a same-revision refresh of revoked writable metadata to root and namespace', async () => {
    const revoked: ProjectModelSettingsView = {
      ...view(),
      writable: false,
      namespaces: [{ ...view().namespaces[0]!, writable: false, writableReason: 'project' as const }],
    }
    const transport = stub({ get: vi.fn()
      .mockResolvedValueOnce(view())
      .mockResolvedValue(revoked) })
    const bridge = new ProjectModelsBridge(7, transport)
    await bridge.mirror.ensure()
    expect(bridge.mirror.getSnapshot().view).toMatchObject({ writable: true })
    await bridge.refresh()
    expect(bridge.mirror.getSnapshot().view).toMatchObject({
      writable: false,
      writableReason: 'project',
      hasDocument: false,
      namespaces: [{ writable: false }],
    })
    await bridge.dispose()
  })

  it.each([1, 2])('keeps revoked writable metadata when a revision %i namespace echo arrives', async (revision) => {
    const transport = stub()
    const bridge = new ProjectModelsBridge(7, transport)
    await bridge.mirror.ensure()
    const stale = { ...view().namespaces[0]!, revision, writable: true }
    bridge.mirror.acceptFull({
      ...view(),
      writable: false,
      namespaces: [{ ...view().namespaces[0]!, writable: false, writableReason: 'project' as const }],
    }, true)
    bridge.mirror.acceptView(stale)
    expect(bridge.mirror.getSnapshot().view).toMatchObject({
      writable: false,
      namespaces: [{ writable: false }],
    })
    await bridge.dispose()
  })

  it.each([1, 2])('keeps an equal-revision GET revocation when a revision %i mutation echo settles', async (revision) => {
    const pending = deferred<ProjectModelSettingsView>()
    const started = deferred<undefined>()
    const revoked: ProjectModelSettingsView = {
      ...view(),
      writable: false,
      namespaces: [{ ...view().namespaces[0]!, writable: false, writableReason: 'project' }],
    }
    const transport = stub({
      get: vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce(revoked),
      mutate: vi.fn(() => { started.resolve(undefined); return pending.promise }),
    })
    const bridge = new ProjectModelsBridge(7, transport)
    const work: Promise<unknown>[] = []
    try {
      await bridge.mirror.ensure()
      const write = tracked(work, operations(bridge).mutate())
      await started.promise
      await bridge.refresh()
      pending.resolve({
        ...view(revision),
        namespaces: [{ ...view(revision).namespaces[0]!, writable: true }],
      })
      await write
      expect(bridge.mirror.getSnapshot().view).toMatchObject({
        writable: false, writableReason: 'project', hasDocument: false,
        namespaces: [{ writable: false, writableReason: 'project', revision: 2 }],
      })
    } finally {
      pending.resolve(view())
      await Promise.allSettled([...work, bridge.dispose()])
    }
  })

  it('keeps the accepted POST answer and current callers when an older GET settles late', async () => {
    const delayedGet = deferred<ProjectModelSettingsView>()
    const readStarted = deferred<undefined>()
    const writeStarted = deferred<undefined>()
    const posted = { ...view(), revision: 3, namespaces: [{ ...view().namespaces[0]!, revision: 3 }] }
    const get = vi.fn<ProjectModelSettingsTransport['get']>()
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view())
      .mockImplementationOnce(() => { readStarted.resolve(undefined); return delayedGet.promise })
      .mockResolvedValue(posted)
    const mutate = vi.fn(async () => {
      writeStarted.resolve(undefined)
      return posted
    })
    const bridge = new ProjectModelsBridge(7, stub({ get, mutate }))
    const work: Promise<unknown>[] = []
    try {
      await bridge.mirror.ensure()
      const mutation = tracked(work, bridge.api.settings.update({
        ns: 'llm-pi-ai', patch: { providers: { x: { baseURL: 'https://x' } } },
      }))
      await writeStarted.promise
      const backgroundRead = tracked(work, bridge.api.llm.providers({}))
      await readStarted.promise
      await mutation
      expect(bridge.mirror.getSnapshot().view).toMatchObject({ namespaces: [{ revision: 3 }] })
      delayedGet.resolve(view())
      const providers = await backgroundRead
      expect(providers.result.ok).toBe(true)
      expect(bridge.mirror.getSnapshot().view).toMatchObject({ namespaces: [{ revision: 3 }] })
      const described = await bridge.api.settings.describe({})
      expect(described.result).toMatchObject({ ok: true, value: { namespaces: [{ revision: 3 }] } })
    } finally {
      delayedGet.resolve(view())
      await Promise.allSettled([...work, bridge.dispose()])
    }
  })

  it.each(['resolve', 'reject'] as const)('waits for the successor instead of held V2 when a started GET %s', async (outcome) => {
    const first = deferred<ProjectModelSettingsView>()
    const second = deferred<ProjectModelSettingsView>()
    const firstStarted = deferred<undefined>()
    const secondStarted = deferred<undefined>()
    const get = vi.fn<ProjectModelSettingsTransport['get']>()
      .mockResolvedValueOnce(view())
      .mockImplementationOnce(() => { firstStarted.resolve(undefined); return first.promise })
      .mockImplementationOnce(() => { secondStarted.resolve(undefined); return second.promise })
    const transport = stub({ get })
    const bridge = new ProjectModelsBridge(7, transport)
    const next: ProjectModelSettingsView = {
      ...view(3),
      providers: [{
        provider: 'next', runtimeProvider: 'project-next', displayName: 'Next',
        protocol: null, baseURL: null, authMode: 'none', status: 'enabled',
        credentialRef: null, credentialConfigured: false, revision: 3, modelCount: 0,
      }],
    }
    const work: Promise<unknown>[] = []
    try {
      await bridge.mirror.ensure()
      const providersSettled = vi.fn()
      const describeSettled = vi.fn()
      const providers = tracked(work, bridge.api.llm.providers({}).then((value) => {
        providersSettled()
        return value
      }))
      const described = tracked(work, bridge.api.settings.describe({}).then((value) => {
        describeSettled()
        return value
      }))
      await firstStarted.promise
      const refresh = tracked(work, bridge.refresh())
      await secondStarted.promise
      expect(get.mock.calls[1]?.[1]?.aborted).toBe(true)
      expect(get.mock.calls[2]?.[1]?.aborted).toBe(false)
      if (outcome === 'resolve') first.resolve(view())
      else first.reject(new Error('retired project read failed'))
      await Promise.allSettled([first.promise])
      await microtaskBarrier()
      await microtaskBarrier()
      expect(providersSettled).not.toHaveBeenCalled()
      expect(describeSettled).not.toHaveBeenCalled()
      const again = tracked(work, bridge.api.settings.describe({}))
      expect(get).toHaveBeenCalledTimes(3)
      second.resolve(next)
      await refresh
      expect((await providers).result).toMatchObject({ ok: true, value: { providers: [{ provider: 'next' }] } })
      for (const call of [described, again]) {
        expect((await call).result).toMatchObject({ ok: true, value: { namespaces: [{ revision: 3 }] } })
      }
      expect(get).toHaveBeenCalledTimes(3)
      expect(bridge.mirror.getSnapshot().view).toMatchObject({ namespaces: [{ revision: 3 }], hasDocument: false })
    } finally {
      first.resolve(view())
      second.resolve(next)
      await Promise.allSettled([...work, bridge.dispose()])
    }
  })

  it.each(['resolve', 'reject'] as const)('both disposals await a started predecessor after the successor settles: %s', async (outcome) => {
    const first = deferred<ProjectModelSettingsView>()
    const second = deferred<ProjectModelSettingsView>()
    const firstStarted = deferred<undefined>()
    const secondStarted = deferred<undefined>()
    const get = vi.fn<ProjectModelSettingsTransport['get']>()
      .mockImplementationOnce(() => { firstStarted.resolve(undefined); return first.promise })
      .mockImplementationOnce(() => { secondStarted.resolve(undefined); return second.promise })
    const bridge = new ProjectModelsBridge(7, stub({ get }))
    const work: Promise<unknown>[] = []
    try {
      const old = tracked(work, bridge.api.settings.describe({}))
      await firstStarted.promise
      const fresh = tracked(work, bridge.refresh())
      await secondStarted.promise
      second.resolve(view(3))
      await fresh
      const accepted = bridge.mirror.getSnapshot()
      const listener = vi.fn()
      const unsubscribe = bridge.mirror.subscribe(listener)
      try {
        const firstDisposed = vi.fn()
        const secondDisposed = vi.fn()
        void tracked(work, bridge.dispose().then(() => { firstDisposed() }))
        void tracked(work, bridge.dispose().then(() => { secondDisposed() }))
        await microtaskBarrier()
        expect(firstDisposed).not.toHaveBeenCalled()
        expect(secondDisposed).not.toHaveBeenCalled()
        if (outcome === 'resolve') first.resolve(view(100))
        else first.reject(new Error('retired project read failed'))
        expect((await old).result).toMatchObject({ ok: true, value: { namespaces: [{ revision: 3 }] } })
        await Promise.all(work)
        expect(firstDisposed).toHaveBeenCalledOnce()
        expect(secondDisposed).toHaveBeenCalledOnce()
        expect(bridge.mirror.getSnapshot()).toBe(accepted)
        expect(listener).not.toHaveBeenCalled()
        await expect(bridge.api.llm.providers({})).rejects.toThrow('disposed')
        expect(get).toHaveBeenCalledTimes(2)
      } finally {
        unsubscribe()
      }
    } finally {
      first.resolve(view())
      second.resolve(view(3))
      await Promise.allSettled([...work, bridge.dispose()])
    }
  })

  it.each(['resolve', 'reject'] as const)('keeps a disposed first-read mirror silent when the transport %s', async (outcome) => {
    const pending = deferred<ProjectModelSettingsView>()
    const started = deferred<undefined>()
    const get = vi.fn<ProjectModelSettingsTransport['get']>(() => {
      started.resolve(undefined)
      return pending.promise
    })
    const transport = stub({ get })
    const bridge = new ProjectModelsBridge(7, transport)
    const work: Promise<unknown>[] = []
    try {
      const read = tracked(work, bridge.mirror.ensure())
      const described = tracked(work, bridge.api.settings.describe({}))
      await started.promise
      const held = bridge.mirror.getSnapshot()
      const listener = vi.fn()
      const unsubscribe = bridge.mirror.subscribe(listener)
      try {
        const settled = vi.fn()
        const disposed = tracked(work, bridge.dispose().then(() => { settled() }))
        await microtaskBarrier()
        expect(settled).not.toHaveBeenCalled()
        expect(get.mock.calls[0]?.[1]?.aborted).toBe(true)
        if (outcome === 'resolve') pending.resolve(view())
        else pending.reject(new Error('disposed project read failed'))
        await expect(described).rejects.toThrow('disposed')
        await Promise.all([read, disposed])
        expect(settled).toHaveBeenCalledOnce()
        expect(bridge.mirror.getSnapshot()).toBe(held)
        expect(listener).not.toHaveBeenCalled()
        expect(get).toHaveBeenCalledOnce()
      } finally {
        unsubscribe()
      }
    } finally {
      pending.resolve(view())
      await Promise.allSettled([...work, bridge.dispose()])
    }
  })

  it.each(['mutate', 'update', 'replace', 'setCredential', 'unsetCredential'] as const)(
    'waits for admitted %s acknowledgement without cancelling or publishing it',
    async (kind) => {
      const settingsAck = deferred<ProjectModelSettingsView>()
      const credentialAck = deferred<undefined>()
      const started = deferred<undefined>()
      const mutate = vi.fn<ProjectModelSettingsTransport['mutate']>(() => {
        started.resolve(undefined)
        return settingsAck.promise
      })
      const setCredential = vi.fn<ProjectModelSettingsTransport['setCredential']>(() => {
        started.resolve(undefined)
        return credentialAck.promise
      })
      const unsetCredential = vi.fn<ProjectModelSettingsTransport['unsetCredential']>(() => {
        started.resolve(undefined)
        return credentialAck.promise
      })
      const get = vi.fn(async () => view())
      const transport = stub({ get, mutate, setCredential, unsetCredential })
      const bridge = new ProjectModelsBridge(7, transport)
      const work: Promise<unknown>[] = []
      try {
        await bridge.mirror.ensure()
        const write = tracked(work, operations(bridge)[kind]())
        await started.promise
        const held = bridge.mirror.getSnapshot()
        const reads = get.mock.calls.length
        const listener = vi.fn()
        const unsubscribe = bridge.mirror.subscribe(listener)
        try {
          const firstDisposed = vi.fn()
          const secondDisposed = vi.fn()
          void tracked(work, bridge.dispose().then(() => { firstDisposed() }))
          void tracked(work, bridge.dispose().then(() => { secondDisposed() }))
          await microtaskBarrier()
          expect(firstDisposed).not.toHaveBeenCalled()
          expect(secondDisposed).not.toHaveBeenCalled()
          if (kind === 'setCredential') expect(setCredential.mock.calls[0]).toHaveLength(3)
          else if (kind === 'unsetCredential') expect(unsetCredential.mock.calls[0]).toHaveLength(2)
          else expect(mutate.mock.calls[0]).toHaveLength(2)
          settingsAck.resolve(view(3))
          credentialAck.resolve(undefined)
          expect((await write).result).toMatchObject({ ok: true })
          await Promise.all(work)
          expect(firstDisposed).toHaveBeenCalledOnce()
          expect(secondDisposed).toHaveBeenCalledOnce()
          expect(bridge.mirror.getSnapshot()).toBe(held)
          expect(listener).not.toHaveBeenCalled()
          expect(get).toHaveBeenCalledTimes(reads)
        } finally {
          unsubscribe()
        }
      } finally {
        settingsAck.resolve(view(3))
        credentialAck.resolve(undefined)
        await Promise.allSettled([...work, bridge.dispose()])
      }
    },
  )

  it.each(['describeCredentials', 'discover'] as const)('waits for abort-ignoring admitted %s settlement', async (kind) => {
    const description = deferred<Awaited<ReturnType<ProjectModelSettingsTransport['describeCredentials']>>>()
    const discovery = deferred<Awaited<ReturnType<ProjectModelSettingsTransport['discover']>>>()
    const started = deferred<undefined>()
    const describeCredentials = vi.fn<ProjectModelSettingsTransport['describeCredentials']>(() => {
      started.resolve(undefined)
      return description.promise
    })
    const discover = vi.fn<ProjectModelSettingsTransport['discover']>(() => {
      started.resolve(undefined)
      return discovery.promise
    })
    const bridge = new ProjectModelsBridge(7, stub({ describeCredentials, discover }))
    const work: Promise<unknown>[] = []
    try {
      const call = operations(bridge)[kind]()
      work.push(Promise.allSettled([call]))
      await started.promise
      const firstDisposed = vi.fn()
      const secondDisposed = vi.fn()
      void tracked(work, bridge.dispose().then(() => { firstDisposed() }))
      void tracked(work, bridge.dispose().then(() => { secondDisposed() }))
      await microtaskBarrier()
      expect(firstDisposed).not.toHaveBeenCalled()
      expect(secondDisposed).not.toHaveBeenCalled()
      const signal = kind === 'discover' ? discover.mock.calls[0]?.[2] : describeCredentials.mock.calls[0]?.[2]
      expect(signal?.aborted).toBe(true)
      description.resolve({ credentials: {} })
      discovery.resolve({ models: [] })
      expect((await call).result).toMatchObject({ ok: true })
      await Promise.all(work)
      expect(firstDisposed).toHaveBeenCalledOnce()
      expect(secondDisposed).toHaveBeenCalledOnce()
    } finally {
      description.resolve({ credentials: {} })
      discovery.resolve({ models: [] })
      await Promise.allSettled([...work, bridge.dispose()])
    }
  })

  it.each(['update', 'replace'] as const)('cannot start a compatibility %s mutation after disposal during its read', async (kind) => {
    const pending = deferred<ProjectModelSettingsView>()
    const started = deferred<undefined>()
    const get = vi.fn<ProjectModelSettingsTransport['get']>()
      .mockResolvedValueOnce(view())
      .mockImplementationOnce(() => { started.resolve(undefined); return pending.promise })
    const mutate = vi.fn(async () => view())
    const transport = stub({ get, mutate })
    const bridge = new ProjectModelsBridge(7, transport)
    const work: Promise<unknown>[] = []
    try {
      await bridge.mirror.ensure()
      const write = tracked(work, operations(bridge)[kind]())
      await started.promise
      const held = bridge.mirror.getSnapshot()
      const disposed = tracked(work, bridge.dispose())
      pending.resolve(view())
      await expect(write).rejects.toThrow('disposed')
      await disposed
      expect(mutate).not.toHaveBeenCalled()
      expect(get).toHaveBeenCalledTimes(2)
      expect(bridge.mirror.getSnapshot()).toBe(held)
    } finally {
      pending.resolve(view())
      await Promise.allSettled([...work, bridge.dispose()])
    }
  })

  it.each(['mutate', 'update', 'replace', 'describeCredentials', 'setCredential', 'unsetCredential', 'discover'] as const)(
    'rejects new %s calls after disposal without transport',
    async (kind) => {
      const transport = stub()
      const bridge = new ProjectModelsBridge(7, transport)
      try {
        await bridge.dispose()
        await expect(operations(bridge)[kind]()).rejects.toThrow('disposed')
        for (const method of Object.values(transport)) expect(method).not.toHaveBeenCalled()
      } finally {
        await bridge.dispose()
      }
    },
  )

  it.each(['mutate', 'update', 'replace', 'describeCredentials', 'setCredential', 'unsetCredential', 'discover'] as const)(
    'refuses queued %s transport admission when disposal starts in the same turn',
    async (kind) => {
      const transport = stub()
      const bridge = new ProjectModelsBridge(7, transport)
      const work: Promise<unknown>[] = []
      try {
        const call = tracked(work, operations(bridge)[kind]())
        const disposed = tracked(work, bridge.dispose())
        await expect(call).rejects.toThrow('disposed')
        await disposed
        for (const method of Object.values(transport)) expect(method).not.toHaveBeenCalled()
      } finally {
        await Promise.allSettled([...work, bridge.dispose()])
      }
    },
  )
})
