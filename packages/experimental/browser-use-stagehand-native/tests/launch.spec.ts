/** Managed Chromium startup, captured admission, and retryable range ownership. */
import ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import { PassThrough } from 'node:stream'
import { access, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { launchChromium } from '../src/launch.ts'
import type { ChromiumLaunchConfig } from '../src/launch.ts'
import { ResourceAcquisitionCleanupError } from '@deepseek-ai/dsh-experimental-browser-use-runtime'

const state = vi.hoisted(() => ({ allocate: vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(), path: vi.fn(() => '/fixture/chrome') }))
vi.mock('@puppeteer/browsers', () => ({
  Browser: { CHROME: 'chrome' }, ChromeReleaseChannel: { STABLE: 'stable' },
  CDP_WEBSOCKET_ENDPOINT_REGEX: /^DevTools listening on (.+)$/,
  computeSystemExecutablePath: state.path,
}))
vi.mock('@deepseek-ai/dsh-subprocess-local', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-subprocess-local')>()
  return { ...original, LocalSubprocessRuntime: class extends original.LocalSubprocessRuntime {
    protected override spawnProcess(spec: SubprocessSpawnSpec) { return state.allocate(spec) }
  } }
})
const config: ChromiumLaunchConfig = { headless: true, operationTimeoutMs: 5000, processGraceMs: 50, processCloseTimeoutMs: 5000 }
const owner = SessionId('owned-chromium')
afterEach(() => { state.allocate.mockReset(); state.path.mockClear() })

async function owned(options: { missingStderr?: boolean } = {}) {
  const ctx = new Context(), stderr = new PassThrough(), done = Promise.withResolvers<SubprocessOutcome>()
  const started = Promise.withResolvers<SubprocessSpawnSpec>(), killed = Promise.withResolvers<undefined>()
  const range = { confirmed: true, error: undefined as Error | undefined, killError: undefined as Error | undefined }
  const terminate = vi.fn(() => {
    killed.resolve(undefined)
    if (range.killError !== undefined) throw range.killError
    done.resolve({ exitCode: 0, signal: null })
  })
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: options.missingStderr ? undefined : stderr, control: undefined, collected: {},
    done: done.promise, terminate,
    async waitForExit() { if (range.error !== undefined) throw range.error; return range.confirmed },
  }
  state.allocate.mockImplementation((spec) => {
    const abort = (): void => {
      try { terminate() } catch (error) { done.reject(error) }
    }
    spec.signal?.addEventListener('abort', abort, { once: true })
    const detach = (): void => { spec.signal?.removeEventListener('abort', abort) }
    void done.promise.then(detach, detach)
    started.resolve(spec)
    return handle
  })
  await ctx.plugin(LocalSubprocessRuntime)
  onTestFinished(async () => {
    range.killError = undefined; range.error = undefined; range.confirmed = true
    done.resolve({ exitCode: 0, signal: null }); stderr.destroy()
    await ctx.fiber.dispose()
    const spec = state.allocate.mock.calls[0]?.[0]
    if (spec !== undefined) await rm(spec.cwd, { recursive: true, force: true })
  })
  return { ctx, handle, stderr, done, started, killed, range, terminate,
    open: (signal = new AbortController().signal, overrides: Partial<ChromiumLaunchConfig> = {}) =>
      launchChromium({ ...config, ...overrides }, signal, ctx.subprocess, owner) }
}

it.each([true, false])('owns a profile and explicit Session through managed process exit (headless %s)', async (headless) => {
  const test = await owned(), opening = test.open(undefined, { headless, ...headless ? {} : { executablePath: '/custom/chrome' } })
  const spec = await test.started.promise
  expect(spec.sessionId).toBe(owner)
  expect(spec.argv[0]).toBe(headless ? '/fixture/chrome' : '/custom/chrome')
  expect(spec.argv.includes('--headless=new')).toBe(headless)
  expect(spec.argv).toContain('--remote-debugging-port=0')
  expect(spec.stdio).toEqual({ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  test.stderr.write('Chrome diagnostic\nDevTools listening on ws://localhost/browser/fixture\n')
  const browser = await opening
  await expect(access(spec.cwd)).resolves.toBeUndefined()
  await browser.close()
  expect(test.terminate).toHaveBeenCalled()
  await expect(access(spec.cwd)).rejects.toThrow()
})

it('joins range exit before removing the profile after startup cancellation', async () => {
  const test = await owned(), controller = new AbortController()
  const opening = test.open(controller.signal), rejected = expect(opening).rejects.toThrow('Stop acquisition')
  const spec = await test.started.promise
  await vi.waitFor(() => { expect(test.stderr.listenerCount('data')).toBeGreaterThan(0) })
  const exit = Promise.withResolvers<boolean>()
  test.handle.waitForExit = () => exit.promise
  controller.abort(new Error('Stop acquisition'))
  await test.killed.promise
  await expect(access(spec.cwd)).resolves.toBeUndefined()
  exit.resolve(true)
  await rejected
  await expect(access(spec.cwd)).rejects.toThrow()
})

it.each(['unconfirmed', 'observation error', 'kill error'] as const)('retains startup cleanup for retry after %s', async (failure) => {
  const test = await owned(), controller = new AbortController()
  const opening = test.open(controller.signal), rejected = expect(opening).rejects.toBeInstanceOf(ResourceAcquisitionCleanupError)
  const spec = await test.started.promise
  if (failure === 'unconfirmed') test.range.confirmed = false
  if (failure === 'observation error') test.range.error = new Error('Range observation failed')
  if (failure === 'kill error') test.range.killError = new Error('Kill denied')
  controller.abort(new Error('Stop acquisition'))
  await rejected
  const error = await opening.catch((error: unknown) => error)
  expect(error).toBeInstanceOf(ResourceAcquisitionCleanupError)
  await expect(access(spec.cwd)).resolves.toBeUndefined()
  test.range.confirmed = true; test.range.error = undefined; test.range.killError = undefined
  await (error as ResourceAcquisitionCleanupError).cleanup()
  await expect(access(spec.cwd)).rejects.toThrow()
})

it('removes the profile when native allocation fails', async () => {
  const test = await owned()
  state.allocate.mockImplementation((spec) => { test.started.resolve(spec); throw new Error('Cannot spawn browser') })
  const rejected = expect(test.open()).rejects.toThrow('Cannot spawn browser')
  const spec = await test.started.promise
  await rejected
  await expect(access(spec.cwd)).rejects.toThrow()
})

it('does not allocate when cancellation arrives during profile acquisition', async () => {
  const test = await owned(), controller = new AbortController()
  const opening = test.open(controller.signal)
  controller.abort(new Error('Canceled before spawn'))
  await expect(opening).rejects.toThrow('Canceled before spawn')
  expect(state.allocate).not.toHaveBeenCalled()
})

it.each(['profile', 'spawn', 'endpoint'] as const)('checks resource ownership after the %s wait', async (phase) => {
  const test = await owned()
  let current = phase !== 'profile'
  const opening = launchChromium(config, new AbortController().signal, test.ctx.subprocess, owner, () => {
    if (!current) throw new Error('Chromium resource owner changed')
  })
  const rejected = expect(opening).rejects.toThrow('Chromium resource owner changed')
  if (phase !== 'profile') {
    const spec = await test.started.promise
    if (phase === 'endpoint') {
      await vi.waitFor(() => { expect(test.stderr.listenerCount('data')).toBeGreaterThan(0) })
      current = false
      test.stderr.write('DevTools listening on ws://fixture/chrome\n')
    } else current = false
    await rejected
    expect(test.terminate).toHaveBeenCalled()
    await expect(access(spec.cwd)).rejects.toThrow()
  } else {
    await rejected
    expect(state.allocate).not.toHaveBeenCalled()
  }
})

it.each([1, 2, 3])('cancels Chromium from ownership check %s without publishing the process', async (target) => {
  const test = await owned(), controller = new AbortController()
  let checks = 0
  const opening = launchChromium(config, controller.signal, test.ctx.subprocess, owner, () => {
    if (++checks === target) controller.abort(new Error('cancel resource check'))
  })
  const rejected = expect(opening).rejects.toThrow('cancel resource check')
  if (target > 1) {
    const spec = await test.started.promise
    test.stderr.write('DevTools listening on ws://fixture/chrome\n')
    await rejected
    await expect(access(spec.cwd)).rejects.toThrow()
  } else await rejected
})

it('cleans up a partially allocated process without its debugging pipe', async () => {
  const test = await owned({ missingStderr: true })
  await expect(test.open()).rejects.toThrow('did not supply its debugging output')
  expect(test.terminate).toHaveBeenCalled()
})

it.each(['exit', 'failure', 'pipe failure'] as const)('stops before readiness after a process %s', async (reason) => {
  const test = await owned(), opening = test.open(), rejected = expect(opening).rejects.toThrow()
  await test.started.promise
  await vi.waitFor(() => { expect(test.stderr.listenerCount('data')).toBeGreaterThan(0) })
  if (reason === 'exit') test.done.resolve({ exitCode: 1, signal: null })
  if (reason === 'failure') test.done.reject(new Error('Native process failed'))
  if (reason === 'pipe failure') test.stderr.emit('error', new Error('Debugging pipe failed'))
  await rejected
  expect(test.terminate).toHaveBeenCalled()
})

it('fails without creating a profile or process when system Chrome discovery fails', async () => {
  const test = await owned()
  state.path.mockImplementationOnce(() => { throw new Error('Chrome is not installed') })
  await expect(test.open()).rejects.toThrow('Chrome is not installed')
  expect(state.allocate).not.toHaveBeenCalled()
})

it.each(['caller', 'deadline'] as const)('returns a late process permit after queued startup is canceled by its %s', async (cause) => {
  const test = await owned(), controller = new AbortController(), deadline = new AbortController()
  const requested = Promise.withResolvers<Parameters<Context['resourceBudget']['acquire']>[0]>()
  const grant = Promise.withResolvers<Awaited<ReturnType<Context['resourceBudget']['acquire']>>>()
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
  onTestFinished(() => { timer.mockRestore() })
  test.ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget {
    async acquire(request: Parameters<Context['resourceBudget']['acquire']>[0]) { requested.resolve(request); return grant.promise }
  }(test.ctx)
  const opening = test.open(controller.signal), rejected = expect(opening).rejects.toThrow('startup canceled')
  const request = await requested.promise
  expect(request.sessionId).toBe(owner)
  expect(state.allocate).not.toHaveBeenCalled()
  if (cause === 'caller') controller.abort(new Error('startup canceled by caller'))
  else deadline.abort(new Error('startup canceled by its deadline'))
  expect(request.signal?.aborted).toBe(true)
  grant.resolve({ signal: new AbortController().signal, release, uncertain })
  await rejected
  expect(state.allocate).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
  expect(uncertain).not.toHaveBeenCalled()
})

it('detaches successful startup from caller cancellation while retaining permit revocation', async () => {
  const test = await owned(), caller = new AbortController(), revocation = new AbortController()
  const release = vi.fn(async () => {})
  test.ctx.provide('resourceBudgetRequired', true)
  new class extends ResourceBudget { async acquire() {
    return { signal: revocation.signal, release, async uncertain() {} }
  } }(test.ctx)
  const opening = test.open(caller.signal)
  const spec = await test.started.promise
  test.stderr.write('DevTools listening on ws://localhost/browser/published\n')
  const browser = await opening
  caller.abort(new Error('completed browser tool call ended'))
  expect(spec.signal?.aborted).toBe(false)
  expect(test.terminate).not.toHaveBeenCalled()
  revocation.abort(new Error('browser permit withdrawn'))
  await test.killed.promise
  expect(spec.signal?.aborted).toBe(true)
  await browser.close()
  expect(release).toHaveBeenCalled()
})
