/** Credential hint demand, invalidation, and operation ownership on the web-search page. */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { WebSearchCardController, type WebSearchSettings } from '../src/client/web-search-card-controller.ts'

function response(configured: boolean, ref = 'DEEPSEEK_API_KEY') {
  return { rpcId: 'hint', result: { ok: true as const, value: { credentials: { [ref]: { configured, writable: true } } } } }
}

function fixture() {
  const web = stubSettingsScope<{ searchProvider?: string; fetchProvider?: string }>()
  const messages = stubSettingsScope<WebSearchSettings>()
  const api = stubSettingsScope<WebSearchSettings>()
  for (const scope of [web, messages, api]) scope.publish({ status: 'ready', writable: true, value: {}, user: {} })
  const describe = vi.fn((_payload: { refs: string[] }, _signal?: AbortSignal) => Promise.resolve(response(true)))
  const set = vi.fn(() => Promise.resolve({ rpcId: 'write', result: { ok: true as const, value: {} } }))
  const controller = new WebSearchCardController(
    { web: web.scope, messages: messages.scope, api: api.scope },
    { credentials: { describe, set } } as never,
  )
  const releases: (() => void)[] = []
  onTestFinished(async () => {
    for (const release of releases) release()
    await controller.dispose()
  })
  const delay = () => {
    const deferred = Promise.withResolvers<ReturnType<typeof response>>()
    releases.push(() => { deferred.resolve(response(false)) })
    return deferred
  }
  const face = controller.inject()
  return {
    web, messages, api, describe, set, controller, face, delay,
    releaseOnCleanup: (release: () => void) => { releases.push(release) },
    snapshot: () => face.hooks.webSearchCard.getSnapshot(),
  }
}

describe('web-search credential lifecycle', () => {
  it('does not read credentials for an unopened page or its summary', () => {
    const f = fixture()
    for (const scope of [f.web, f.messages, f.api]) scope.publish({ value: {} })
    f.controller.refreshCredential('DEEPSEEK_API_KEY')
    f.controller.resetConnection()

    expect(f.describe).not.toHaveBeenCalled()
    expect(f.snapshot()).toMatchObject({ available: true, apiKeyStatus: 'unknown' })
  })

  it('shares the first visible read and does not reread for three unchanged scope projections', async () => {
    const f = fixture()
    const first = f.delay()
    f.describe.mockReturnValueOnce(first.promise)
    const read = f.controller.ensureCredential()
    expect(f.controller.ensureCredential()).toBe(read)
    expect(f.controller.ensureCredential()).toBe(read)
    for (const scope of [f.web, f.messages, f.api]) scope.publish({ value: {} })
    await vi.waitFor(() => { expect(f.describe).toHaveBeenCalledOnce() })
    expect(f.snapshot().apiKeyStatus).toBe('loading')
    first.resolve(response(true))
    await read

    for (const scope of [f.web, f.messages, f.api]) scope.publish({ value: {} })
    await f.controller.ensureCredential()
    expect(f.describe).toHaveBeenCalledOnce()
    expect(f.snapshot()).toMatchObject({ apiKeyStatus: 'ready', apiKeyConfigured: true })
  })

  it('reads a changed selected reference and ignores changes to unselected references', async () => {
    const f = fixture()
    await f.controller.ensureCredential()
    f.api.publish({ value: { apiKeyEnv: 'API_KEY' } })
    expect(f.describe).toHaveBeenCalledOnce()
    f.messages.publish({ value: { apiKeyEnv: 'MESSAGES_KEY' } })
    await vi.waitFor(() => { expect(f.describe).toHaveBeenCalledTimes(2) })
    expect(f.describe.mock.calls[1]![0]).toEqual({ refs: ['MESSAGES_KEY'] })
    f.controller.refreshCredential('DEEPSEEK_API_KEY')
    expect(f.describe).toHaveBeenCalledTimes(2)
    f.face.setSearchApi(true)
    await vi.waitFor(() => { expect(f.describe).toHaveBeenCalledTimes(3) })
    expect(f.describe.mock.calls[2]![0]).toEqual({ refs: ['API_KEY'] })
  })

  it('owns the read before loading notification and retires unstarted work when its reference changes', async () => {
    const f = fixture()
    const joined: Promise<void>[] = []
    const off = f.face.hooks.webSearchCard.subscribe(() => {
      if (f.snapshot().apiKeyStatus === 'loading') joined.push(f.controller.ensureCredential())
    })
    onTestFinished(off)
    const initial = f.controller.ensureCredential()
    expect(joined).toEqual([initial])
    f.messages.publish({ value: { apiKeyEnv: 'CURRENT_KEY' } })
    await Promise.all(joined)
    expect(f.describe).toHaveBeenCalledOnce()
    expect(f.describe.mock.calls[0]![0]).toEqual({ refs: ['CURRENT_KEY'] })
    expect(f.snapshot().apiKeyStatus).toBe('ready')
  })

  it('does not admit a read when its loading notification disposes the page owner', async () => {
    const f = fixture()
    const disposals: Promise<void>[] = []
    const off = f.face.hooks.webSearchCard.subscribe(() => {
      if (f.snapshot().apiKeyStatus === 'loading') disposals.push(f.controller.dispose())
    })
    onTestFinished(off)
    await f.controller.ensureCredential()
    await Promise.all(disposals)
    expect(disposals).toHaveLength(1)
    expect(f.describe).not.toHaveBeenCalled()
  })

  it('starts a fresh read after explicit invalidation instead of joining an older same-reference read', async () => {
    const f = fixture()
    const older = f.delay()
    f.describe.mockReturnValueOnce(older.promise)
    const oldRead = f.controller.ensureCredential()
    await vi.waitFor(() => { expect(f.describe).toHaveBeenCalledOnce() })
    f.controller.refreshCredential('DEEPSEEK_API_KEY')
    await vi.waitFor(() => { expect(f.snapshot().apiKeyStatus).toBe('ready') })
    expect(f.describe).toHaveBeenCalledTimes(2)
    expect(f.snapshot().apiKeyConfigured).toBe(true)
    older.resolve(response(false))
    await oldRead
    expect(f.snapshot().apiKeyConfigured).toBe(true)
  })

  it('drops the previous target hint and requires a fresh response on connection reset', async () => {
    const f = fixture()
    await f.controller.ensureCredential()
    const newer = f.delay()
    f.describe.mockReturnValueOnce(newer.promise)
    f.controller.resetConnection()
    expect(f.snapshot()).toMatchObject({ apiKeyStatus: 'loading', apiKeyConfigured: false })
    await vi.waitFor(() => { expect(f.describe).toHaveBeenCalledTimes(2) })
    newer.resolve(response(false))
    await f.controller.ensureCredential()
    expect(f.snapshot()).toMatchObject({ apiKeyStatus: 'ready', apiKeyConfigured: false })
  })

  it('verifies an acknowledged replacement with a fresh read despite an older in-flight hint', async () => {
    const f = fixture()
    const older = f.delay()
    f.describe.mockReturnValueOnce(older.promise)
    const oldRead = f.controller.ensureCredential()
    await vi.waitFor(() => { expect(f.describe).toHaveBeenCalledOnce() })
    f.face.edit('apiKey', 'synthetic-key')
    f.face.save()
    await vi.waitFor(() => {
      expect(f.snapshot()).toMatchObject({ dirty: false, failed: false, saving: false, apiKeyConfigured: true })
    })
    expect(f.set).toHaveBeenCalledOnce()
    expect(f.describe).toHaveBeenCalledTimes(2)
    older.resolve(response(false))
    await oldRead
    expect(f.snapshot().apiKeyConfigured).toBe(true)
  })

  it.each(['transport', 'refused'] as const)('leaves a failed hint unavailable and retries on the next page opening (%s)', async (failure) => {
    const f = fixture()
    if (failure === 'transport') f.describe.mockRejectedValueOnce(new Error('offline'))
    else f.describe.mockResolvedValueOnce({ rpcId: 'hint', result: { ok: false, error: {} } } as never)
    await f.controller.ensureCredential()
    expect(f.snapshot()).toMatchObject({ available: true, apiKeyStatus: 'unavailable' })
    await f.controller.ensureCredential()
    expect(f.describe).toHaveBeenCalledTimes(2)
    expect(f.snapshot()).toMatchObject({ apiKeyStatus: 'ready', apiKeyConfigured: true })
  })

  it('aborts reads and awaits late settlement without publishing after disposal', async () => {
    const f = fixture()
    const delayed = f.delay()
    f.describe.mockReturnValueOnce(delayed.promise)
    const read = f.controller.ensureCredential()
    await vi.waitFor(() => { expect(f.describe).toHaveBeenCalledOnce() })
    const listener = vi.fn()
    const off = f.face.hooks.webSearchCard.subscribe(listener)
    onTestFinished(off)
    const snapshot = f.snapshot()
    let settled = false
    const disposed = f.controller.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(f.describe.mock.calls[0]![1]!.aborted).toBe(true)
    expect(settled).toBe(false)
    delayed.resolve(response(true))
    await Promise.all([read, disposed])
    expect(settled).toBe(true)
    expect(f.snapshot()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
    for (const scope of [f.web, f.messages, f.api]) scope.publish({ value: {} })
    f.controller.refreshCredential('DEEPSEEK_API_KEY')
    f.controller.resetConnection()
    await f.controller.ensureCredential()
    f.face.save()
    expect(f.describe).toHaveBeenCalledOnce()
    expect(f.set).not.toHaveBeenCalled()
  })

  it('waits for an admitted credential write acknowledgement without starting follow-up reads during disposal', async () => {
    const f = fixture()
    const written = Promise.withResolvers<Awaited<ReturnType<typeof f.set>>>()
    f.set.mockReturnValueOnce(written.promise)
    f.releaseOnCleanup(() => { written.resolve({ rpcId: 'write', result: { ok: true, value: {} } }) })
    f.face.edit('apiKey', 'synthetic-key')
    f.face.save()
    await vi.waitFor(() => { expect(f.set).toHaveBeenCalledOnce() })
    let settled = false
    const disposed = f.controller.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    written.resolve({ rpcId: 'write', result: { ok: true, value: {} } })
    await disposed
    expect(settled).toBe(true)
    expect(f.describe).not.toHaveBeenCalled()
  })
})
