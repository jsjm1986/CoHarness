/** Admission and managed-range ownership through the public subprocess service. @module */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import ResourceBudget, { type ResourceLease, type ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessOutcome, type SubprocessSpawnSpec,
  type SubprocessTerminalHandle, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, expect, it, vi } from 'vitest'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })
const spec: SubprocessSpawnSpec = {
  argv: ['program'], cwd: '/workspace', graceMs: 100,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
}

class Probe extends SubprocessRuntime {
  allocate = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>()
  terminal = vi.fn<(spec: SubprocessTerminalSpawnSpec) => Promise<SubprocessTerminalHandle>>()
  async resolveExecutable(command: string): Promise<string> { return command }
  async terminalEnvironment() { return { platform: 'posix' as const } }
  protected spawnProcess(request: SubprocessSpawnSpec): SubprocessHandle { return this.allocate(request) }
  protected spawnTerminalProcess(request: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> { return this.terminal(request) }
  check(spec: Pick<SubprocessSpawnSpec, 'signal'>): () => void { return this.captureAdmissionCheck(spec) }
  rejectClosed(error: unknown): never { return this.rejectAfterCleanup(error) }
}

it.each((['process', 'terminal'] as const).flatMap(kind => [false, true]
  .flatMap(confirmed => [false, true].map(completionFails => ({ kind, confirmed, completionFails })))))(
  'preserves $kind allocation failure with confirmed=$confirmed and completion failure=$completionFails', async (options) => {
    const f = await fixture(), failure = new Error('Allocation failed.'), completionError = new Error('Resource completion unavailable.')
    const fail = (): never => {
      if (options.confirmed) f.provider.rejectClosed(failure)
      throw failure
    }
    f.provider.allocate.mockImplementation(fail)
    f.provider.terminal.mockImplementation(async () => fail())
    const completion = options.confirmed ? f.release : f.uncertain
    if (options.completionFails) completion.mockRejectedValueOnce(completionError)
    f.granted.resolve(f.lease)
    const pending = options.kind === 'process' ? f.provider.spawn(spec)
      : f.provider.spawnTerminal({ argv: ['shell'], cwd: '/workspace', graceMs: 100, rows: 24, cols: 80, terminalType: 'xterm' })
    if (options.completionFails) await expect(pending).rejects.toMatchObject({ errors: [failure, completionError] })
    else await expect(pending).rejects.toBe(failure)
    expect(completion).toHaveBeenCalledOnce()
    expect(options.confirmed ? f.uncertain : f.release).not.toHaveBeenCalled()
  },
)

it('rechecks an entry without caller cancellation against provider replacement and unload', async () => {
  const f = await fixture(), check = f.provider.check({})
  expect(check).not.toThrow()
  f.withdraw()
  f.ctx.provide('resourceBudget', { acquire: async () => f.lease })
  expect(check).toThrow(expect.objectContaining({ reason: 'unavailable' }))
  await f.ctx.fiber.dispose()
  expect(check).toThrow('Subprocess provider disposed')
})

it.each(['process', 'terminal'] as const)('preserves a confirmed independent %s failure without a permit', async (kind) => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Probe)
  const provider = ctx.subprocess as Probe, failure = new Error('Independent allocation rolled back.')
  const fail = (): never => provider.rejectClosed(failure)
  provider.allocate.mockImplementation(fail)
  provider.terminal.mockImplementation(async () => fail())
  const pending = kind === 'process' ? provider.spawn(spec)
    : provider.spawnTerminal({ argv: ['shell'], cwd: '/workspace', graceMs: 100, rows: 24, cols: 80, terminalType: 'xterm' })
  await expect(pending).rejects.toBe(failure)
})

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.logger.error = vi.fn()
  const granted = Promise.withResolvers<ResourceLease>()
  const cancelled = new AbortController()
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  const lease: ResourceLease = { signal: cancelled.signal, release, uncertain }
  const acquire = vi.fn<(_request: ResourceRequest) => Promise<ResourceLease>>(() => granted.promise)
  ctx.provide('resourceBudgetRequired', true)
  const withdraw = ctx.provide('resourceBudget', { acquire } as never)
  await ctx.plugin(Probe)
  const provider = ctx.subprocess as Probe
  const done = Promise.withResolvers<SubprocessOutcome>(), exited = Promise.withResolvers<boolean>()
  const waitForExit = vi.fn(() => exited.promise)
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: new PassThrough(), stderr: new PassThrough(), control: undefined, collected: {},
    done: done.promise, waitForExit,
    terminate: () => { done.resolve({ exitCode: null, signal: 'SIGTERM' }); exited.resolve(true) },
  }
  provider.allocate.mockReturnValue(handle)
  ctx.effect(() => () => { handle.terminate() })
  return { ctx, provider, acquire, withdraw, granted, cancelled, lease, release, uncertain, waitForExit, handle, done, exited }
}

it.each((['process', 'terminal'] as const).flatMap(kind => (['withdrawn', 'replaced'] as const)
  .flatMap(change => (['queued', 'grant-handoff'] as const).map(phase => ({ kind, change, phase })))))(
  'refuses a $kind resource provider $change during $phase admission', async ({ kind, change, phase }) => {
    const f = await fixture()
    const replacement = vi.fn(async () => f.lease)
    f.provider.terminal.mockRejectedValue(new Error('The old admission reached terminal allocation.'))
    const pending = kind === 'process' ? f.provider.spawn(spec)
      : f.provider.spawnTerminal({ argv: ['shell'], cwd: '/workspace', graceMs: 100,
        rows: 24, cols: 80, terminalType: 'xterm' })
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'unavailable' })
    expect(f.acquire).toHaveBeenCalledOnce()
    const replace = (): void => {
      f.withdraw()
      if (change === 'replaced') f.ctx.provide('resourceBudget', { acquire: replacement })
    }
    if (phase === 'queued') replace()
    f.granted.resolve(f.lease)
    if (phase === 'grant-handoff') queueMicrotask(replace)
    await rejected
    expect(f.provider.allocate).not.toHaveBeenCalled()
    expect(f.provider.terminal).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.uncertain).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  },
)

it.each((['process', 'terminal'] as const).flatMap(kind => (['requirement', 'provider'] as const).map(change => ({ kind, change }))))(
  'refuses an independent $kind when a managed $change appears before allocation', async ({ kind, change }) => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Probe)
    const provider = ctx.subprocess as Probe
    const acquire = vi.fn(async () => { throw new Error('An old allocation cannot use a new resource owner.') })
    const pending = kind === 'process' ? provider.spawn(spec)
      : provider.spawnTerminal({ argv: ['shell'], cwd: '/workspace', graceMs: 100, rows: 24, cols: 80, terminalType: 'xterm' })
    const rejected = expect(pending).rejects.toMatchObject({ reason: 'unavailable' })
    if (change === 'requirement') ctx.provide('resourceBudgetRequired', true)
    else ctx.provide('resourceBudget', { acquire })
    await rejected
    expect(provider.allocate).not.toHaveBeenCalled()
    expect(provider.terminal).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
  },
)

it('retains a live admission Service through fresh Cordis tracing proxies', async () => {
  const f = await fixture()
  f.withdraw()
  class Budget extends ResourceBudget {
    override async acquire() { return f.lease }
  }
  await f.ctx.plugin(Budget)
  const handle = await f.provider.spawn(spec)
  expect(f.provider.allocate).toHaveBeenCalledOnce()
  handle.terminate()
  expect(await handle.waitForExit()).toBe(true)
  expect(f.release).toHaveBeenCalled()
  expect(f.uncertain).not.toHaveBeenCalled()
})

it('retains the executing Session and an unconfirmed process range until a later proven exit', async () => {
  const f = await fixture(), sessionId = 'owned-process-session' as NonNullable<ResourceRequest['sessionId']>
  f.granted.resolve(f.lease)
  const handle = await f.provider.spawn({ ...spec, sessionId })
  expect(f.acquire).toHaveBeenCalledWith(expect.objectContaining({ sessionId }))
  f.waitForExit.mockResolvedValueOnce(false)
  expect(await handle.waitForExit()).toBe(false)
  expect(f.uncertain).toHaveBeenCalledOnce()
  expect(f.release).not.toHaveBeenCalled()
  handle.terminate()
  expect(await handle.waitForExit()).toBe(true)
  expect(f.release).toHaveBeenCalled()
})

it.each(['cancelled', 'exited'] as const)('retains terminal controls and uncertain occupation after cleanup fails: %s', async (mode) => {
  const f = await fixture(), done = Promise.withResolvers<SubprocessOutcome>(), failure = new Error('Terminal closure unavailable.')
  const size = { cols: 80, rows: 24 }, writes: string[] = [], signals: string[] = []
  const close = vi.fn(async () => {}).mockRejectedValueOnce(failure)
  f.provider.terminal.mockResolvedValue({
    pid: 1, output: new PassThrough(), done: done.promise, terminate: close,
    write: async (data) => { writes.push(data) }, resize: async (cols, rows) => { Object.assign(size, { cols, rows }) },
    signalForeground: async (signal) => { signals.push(signal); return 1 },
    inspectActivity: async () => ({ state: 'busy', revision: 1 }),
    inspectForeground: async () => ({ processGroupId: 1, inputWaiting: false }),
  })
  f.granted.resolve(f.lease)
  const terminal = await f.provider.spawnTerminal({ argv: ['shell'], cwd: '/workspace', graceMs: 100,
    rows: 24, cols: 80, terminalType: 'xterm' })
  await terminal.write('owned input\n')
  await terminal.resize(120, 40)
  expect(await terminal.inspectActivity()).toEqual({ state: 'busy', revision: 1 })
  expect(await terminal.inspectForeground()).toEqual({ processGroupId: 1, inputWaiting: false })
  expect(await terminal.signalForeground('SIGINT')).toBe(1)
  expect({ writes, size, signals }).toEqual({ writes: ['owned input\n'], size: { cols: 120, rows: 40 }, signals: ['SIGINT'] })
  expect(f.release).not.toHaveBeenCalled()
  if (mode === 'cancelled') f.cancelled.abort(new Error('Terminal cancelled.'))
  else done.reject(new Error('Terminal exited without confirmed range cleanup.'))
  await expect.poll(() => vi.mocked(f.ctx.logger.error).mock.calls.length).toBe(1)
  expect(f.ctx.logger.error).toHaveBeenCalledWith(failure)
  expect(f.uncertain).toHaveBeenCalledOnce()
  expect(f.release).not.toHaveBeenCalled()
  await terminal.terminate()
  expect(f.release).toHaveBeenCalled()
  done.resolve({ exitCode: 0, signal: null })
})

it('joins a terminal allocated after caller cancellation before rejecting publication', async () => {
  const f = await fixture(), controller = new AbortController(), entered = Promise.withResolvers<undefined>()
  const allocated = Promise.withResolvers<SubprocessTerminalHandle>(), done = Promise.withResolvers<SubprocessOutcome>()
  const closing = Promise.withResolvers<undefined>(), closed = Promise.withResolvers<undefined>()
  f.provider.terminal.mockImplementation(() => { entered.resolve(undefined); return allocated.promise })
  f.granted.resolve(f.lease)
  const pending = f.provider.spawnTerminal({ argv: ['shell'], cwd: '/workspace', graceMs: 100,
    rows: 24, cols: 80, terminalType: 'xterm', signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow('Caller cancelled before publication.')
  await entered.promise
  controller.abort(new Error('Caller cancelled before publication.'))
  allocated.resolve({
    pid: 1, output: new PassThrough(), done: done.promise,
    terminate: async () => { closing.resolve(undefined); await closed.promise; done.resolve({ exitCode: 0, signal: null }) },
    write: async () => {}, resize: async () => {}, signalForeground: async () => 1,
    inspectActivity: async () => ({ state: 'busy', revision: 1 }),
    inspectForeground: async () => ({ processGroupId: 1, inputWaiting: false }),
  })
  try {
    await closing.promise
    expect(f.release).not.toHaveBeenCalled()
  } finally { closed.resolve(undefined); await rejected }
  expect(f.release).toHaveBeenCalled()
})

it('waits before allocation and retains occupation until the entire managed range exits', async () => {
  const f = await fixture()
  const pending = f.provider.spawn({ ...spec, resourceOrigin: 'infrastructure' })
  expect(f.acquire).toHaveBeenCalledWith(expect.objectContaining({ kind: 'process', origin: 'infrastructure' }))
  expect(f.provider.allocate).not.toHaveBeenCalled()
  f.granted.resolve(f.lease)
  const handle = await pending
  expect(f.provider.allocate).toHaveBeenCalledOnce()
  f.done.resolve({ exitCode: 0, signal: null })
  await handle.done
  expect(f.release).not.toHaveBeenCalled()
  f.exited.resolve(true)
  expect(await handle.waitForExit()).toBe(true)
  expect(f.release).toHaveBeenCalled()
})

it('returns an unused grant after caller cancellation without allocating a process', async () => {
  const f = await fixture(), controller = new AbortController()
  const pending = f.provider.spawn({ ...spec, signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow('caller cancelled')
  controller.abort(new Error('caller cancelled'))
  f.granted.resolve(f.lease)
  await rejected
  expect(f.provider.allocate).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.uncertain).not.toHaveBeenCalled()
})

it.each(['process', 'terminal'] as const)('rechecks cancellation before entering %s allocation', async (kind) => {
  const f = await fixture(), controller = new AbortController()
  f.provider.terminal.mockRejectedValue(new Error('provider allocation executed'))
  const pending = kind === 'process' ? f.provider.spawn({ ...spec, signal: controller.signal })
    : f.provider.spawnTerminal({ argv: ['shell'], cwd: '/workspace', graceMs: 100,
      rows: 24, cols: 80, terminalType: 'xterm', signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow('cancelled before allocation')
  f.granted.resolve(f.lease)
  queueMicrotask(() => { controller.abort(new Error('cancelled before allocation')) })
  await rejected
  expect(f.provider.allocate).not.toHaveBeenCalled()
  expect(f.provider.terminal).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.uncertain).not.toHaveBeenCalled()
})

it('retains a failed observation and accepts a later proven exit', async () => {
  const f = await fixture()
  f.waitForExit.mockRejectedValueOnce(new Error('owner unavailable'))
  f.granted.resolve(f.lease)
  const handle = await f.provider.spawn(spec)
  f.done.resolve({ exitCode: 0, signal: null })
  await expect.poll(() => vi.mocked(f.uncertain).mock.calls.length).toBe(1)
  expect(f.release).not.toHaveBeenCalled()
  f.exited.resolve(true)
  expect(await handle.waitForExit()).toBe(true)
  expect(f.release).toHaveBeenCalled()
})

it('retains uncertainty when allocation throws after it may have started work', async () => {
  const f = await fixture()
  f.provider.allocate.mockImplementation(() => { throw new Error('allocation transport failed') })
  f.granted.resolve(f.lease)
  await expect(f.provider.spawn(spec)).rejects.toThrow('allocation transport failed')
  expect(f.uncertain).toHaveBeenCalledOnce()
  expect(f.release).not.toHaveBeenCalled()
})

it('holds a cancelled terminal permit until whole-session termination completes', async () => {
  const f = await fixture(), quiescent = Promise.withResolvers<undefined>(), done = Promise.withResolvers<SubprocessOutcome>()
  const terminate = vi.fn(async () => { await quiescent.promise; done.resolve({ exitCode: 0, signal: null }) })
  f.provider.terminal.mockResolvedValue({
    pid: 1, output: new PassThrough(), done: done.promise, terminate,
    write: async () => {}, resize: async () => {}, signalForeground: async () => 1,
    inspectActivity: async () => ({ state: 'busy', revision: 1 }),
    inspectForeground: async () => ({ processGroupId: 1, inputWaiting: false }),
  })
  f.granted.resolve(f.lease)
  const terminal = await f.provider.spawnTerminal({ argv: ['shell'], cwd: '/workspace', graceMs: 100,
    rows: 24, cols: 80, terminalType: 'xterm', resourceOrigin: 'interactive' })
  f.cancelled.abort()
  expect(terminate).toHaveBeenCalled()
  expect(f.release).not.toHaveBeenCalled()
  quiescent.resolve(undefined)
  await terminal.terminate()
  expect(f.release).toHaveBeenCalled()
})

it('keeps a published terminal alive after its allocation caller ends', async () => {
  const f = await fixture(), controller = new AbortController(), done = Promise.withResolvers<SubprocessOutcome>()
  const terminate = vi.fn(async () => { done.resolve({ exitCode: 0, signal: null }) })
  f.provider.terminal.mockResolvedValue({
    pid: 1, output: new PassThrough(), done: done.promise, terminate,
    write: async () => {}, resize: async () => {}, signalForeground: async () => 1,
    inspectActivity: async () => ({ state: 'busy', revision: 1 }),
    inspectForeground: async () => ({ processGroupId: 1, inputWaiting: false }),
  })
  f.granted.resolve(f.lease)
  const terminal = await f.provider.spawnTerminal({ argv: ['shell'], cwd: '/workspace', graceMs: 100,
    rows: 24, cols: 80, terminalType: 'xterm', signal: controller.signal })
  controller.abort(new Error('allocation caller ended'))
  expect(f.acquire.mock.calls[0]?.[0].signal?.aborted).toBe(false)
  expect(terminate).not.toHaveBeenCalled()
  expect(f.release).not.toHaveBeenCalled()
  f.cancelled.abort()
  await terminal.terminate()
  expect(terminate).toHaveBeenCalled()
  expect(f.release).toHaveBeenCalled()
})

it('joins terminal cleanup added by an allocation that settles during disposal', async () => {
  const f = await fixture(), allocated = Promise.withResolvers<SubprocessTerminalHandle>()
  const entered = Promise.withResolvers<undefined>(), closing = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>(), done = Promise.withResolvers<SubprocessOutcome>()
  f.provider.terminal.mockImplementation(() => { entered.resolve(undefined); return allocated.promise })
  f.granted.resolve(f.lease)
  const pending = f.provider.spawnTerminal({ argv: ['shell'], cwd: '/workspace', graceMs: 100,
    rows: 24, cols: 80, terminalType: 'xterm' })
  await entered.promise
  const signal = f.provider.terminal.mock.calls[0]?.[0].signal
  if (signal === undefined) throw new Error('allocation cancellation was not provided')
  const cancelled = new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
  let settled = false
  const stopping = f.ctx.fiber.dispose().then(() => { settled = true })
  await cancelled
  allocated.resolve({
    pid: 1, output: new PassThrough(), done: done.promise,
    terminate: async () => {
      closing.resolve(undefined)
      await closed.promise
      done.resolve({ exitCode: 0, signal: null })
    },
    write: async () => {}, resize: async () => {}, signalForeground: async () => 1,
    inspectActivity: async () => ({ state: 'busy', revision: 1 }),
    inspectForeground: async () => ({ processGroupId: 1, inputWaiting: false }),
  })
  try {
    await closing.promise
    await pending
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(f.release).not.toHaveBeenCalled()
  } finally {
    closed.resolve(undefined)
    await stopping
    await pending
  }
  expect(f.release).toHaveBeenCalled()
})

it('refuses managed execution when its admission provider is missing', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('resourceBudgetRequired', true)
  await ctx.plugin(Probe)
  await expect(ctx.subprocess.spawn(spec)).rejects.toMatchObject({ reason: 'unavailable' })
  expect((ctx.subprocess as Probe).allocate).not.toHaveBeenCalled()
})
