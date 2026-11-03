/** SSH startup identity and request lifetimes over the actual administrative protocol. */
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer } from '../src/protocol.ts'
import { SshConnection } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn(), connect: vi.fn(), tls: vi.fn(), directory: vi.fn(), remove: vi.fn() }))
vi.mock('@deepseek-ai/dsh-subprocess-local', async () => import('./fixtures/local-transport.ts'))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: transport.spawn, execFile: transport.exec }))
vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), createConnection: transport.connect }))
vi.mock('node:tls', async original => ({ ...await original<typeof import('node:tls')>(), connect: transport.tls }))
vi.mock('node:fs/promises', () => ({ mkdtemp: transport.directory, rm: transport.remove }))

class Stream extends Duplex {
  finishDestroy: ((error: Error | null) => void) | undefined
  holdDestroy = false
  override _read(): void {}
  override _write(_bytes: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback() }
  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (this.holdDestroy) this.finishDestroy = callback
    else callback(error)
  }
  releaseDestroy(): void {
    const callback = this.finishDestroy
    this.finishDestroy = undefined
    callback?.(null)
  }
  disableRenegotiation(): void {}
}

class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  readonly terminating = Promise.withResolvers<undefined>()
  ignoreTerm = false
  closed = false
  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal)
    this.terminating.resolve(undefined)
    if (this.ignoreTerm && signal !== 'SIGKILL') return true
    if (!this.closed) {
      this.closed = true
      queueMicrotask(() => { this.emit('close', 0, null) })
    }
    return true
  }
}

const config: Config = {
  host: 'test-alias', launch: { kind: 'node-script', node: '/remote/node' }, helper: '/remote/helper.js', helperHash: 'a'.repeat(64), workspace: '/remote/workspace',
  requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
}
const hello = {
  protocol: 2, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: 'v24.19.0',
  kind: 'node-script', executable: '/canonical/node', root: '/tmp/remote-helper', workspace: '/canonical/workspace',
}

function setup(options: {
  config?: Partial<Config>
  hello?: Record<string, unknown>
  holdHello?: boolean
  holdConnect?: boolean
  forwardFailure?: Error
  heartbeatFailure?: Error
  closeFailure?: Error
  pluginOwned?: boolean
  control?: (args: string[]) => Promise<{ stdout?: string; stderr?: string; error?: Error }>
  directoryFailure?: Error
  budget?: Pick<ResourceBudget, 'acquire'>
  handle?: (method: string, params: unknown) => Promise<unknown>
  expectedDisposalFailure?: Error
  retainedFailure?: () => unknown
} = {}) {
  const ctx = new Context()
  if (options.budget !== undefined) {
    ctx.provide('resourceBudgetRequired', true)
    ctx.provide('resourceBudget', options.budget as ResourceBudget)
  }
  const child = new Child()
  const raw = new Stream()
  const secure = new Stream()
  const releaseHello = Promise.withResolvers<undefined>()
  const helloEntered = Promise.withResolvers<undefined>()
  const requestEntered = Promise.withResolvers<AbortSignal>()
  const released = Promise.withResolvers<null>()
  const calls: { method: string; params: unknown }[] = []
  const helper = new SshRpcPeer(child.stdin, child.stdout, 4096, 8, async (method, params, signal) => {
    calls.push({ method, params })
    if (method === 'hello') {
      helloEntered.resolve(undefined)
      if (options.holdHello) await releaseHello.promise
      return { ...hello, ...options.hello }
    }
    if (method === 'held') { requestEntered.resolve(signal); return released.promise }
    if (method === 'echo') return params
    if (method === 'heartbeat' && options.heartbeatFailure !== undefined) throw options.heartbeatFailure
    if (method === 'close' && options.closeFailure !== undefined) throw options.closeFailure
    if (method === 'heartbeat' || method === 'close') return null
    if (options.handle !== undefined) return options.handle(method, params)
    throw new Error(`unexpected helper request ${method}`)
  })
  transport.directory.mockResolvedValue('/virtual/ssh-startup')
  if (options.directoryFailure !== undefined) transport.directory.mockRejectedValueOnce(options.directoryFailure)
  transport.remove.mockResolvedValue(undefined)
  transport.spawn.mockReturnValue(child)
  transport.exec.mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: Error | null) => void) => {
    const command = new Child()
    void Promise.resolve().then(async () => {
      const output = await options.control?.(args)
      if (output?.stdout !== undefined) command.stdout.write(output.stdout)
      if (output?.stderr !== undefined) command.stderr.write(output.stderr)
      callback(output?.error ?? (args.includes('forward') ? options.forwardFailure ?? null : null))
      command.kill()
    })
    return command
  })
  transport.connect.mockImplementation(() => {
    if (!options.holdConnect) queueMicrotask(() => { raw.emit('connect') })
    return raw
  })
  transport.tls.mockImplementation(() => {
    raw.on('error', (error) => { secure.destroy(error) })
    raw.once('close', () => { secure.destroy() })
    secure.once('close', () => { raw.destroy() })
    queueMicrotask(() => { secure.emit('secureConnect') })
    return secure
  })
  let service: SshConnection | undefined
  onTestFinished(async () => {
    releaseHello.resolve(undefined)
    released.resolve(null)
    raw.releaseDestroy()
    secure.releaseDestroy()
    try {
      try { await service?.dispose() } catch (error) {
        if (error !== options.expectedDisposalFailure && error !== options.retainedFailure?.()) throw error
      }
    }
    finally {
      raw.destroy(); secure.destroy(); helper.close(); child.stderr.destroy(); child.kill()
      await ctx.fiber.dispose()
      vi.restoreAllMocks()
      for (const mock of Object.values(transport)) mock.mockReset()
    }
  })
  const owner = options.pluginOwned ? ctx.plugin(async (pluginCtx) => {
    service = new SshConnection(pluginCtx, { ...config, ...options.config })
    await service.ready
  }) : undefined
  if (!options.pluginOwned) service = new SshConnection(ctx, { ...config, ...options.config })
  return {
    ctx,
    get service() {
      if (service === undefined) throw new Error('SSH fixture owner has not started')
      return service
    },
    owner, child, helper, raw, secure, calls, requestEntered: requestEntered.promise,
    helloEntered: helloEntered.promise, releaseHello: () => { releaseHello.resolve(undefined) }, release: () => { released.resolve(null) },
  }
}

describe.skipIf(process.platform === 'win32')('SSH connection startup', () => {
  it('drains a loopback consumer before cancelling its remote listener and confirming the helper barrier', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const order: string[] = []
    const test = setup({ control: async (args) => {
      if (args.includes('forward')) return { stdout: '32109\n' }
      order.push('cancel')
      expect(args).toContain('127.0.0.1:0:127.0.0.1:31011')
      expect(test.child.closed).toBe(false)
      return {}
    } })
    await test.service.ready
    const forward = await test.service.forwardLoopback(31011, async () => {
      entered.resolve(undefined)
      await release.promise
      order.push('consumer')
    })
    expect(forward.port).toBe(32109)
    const closing = forward.close()
    expect(forward.close()).toBe(closing)
    await entered.promise
    const disposal = test.service.dispose()
    expect(order).toEqual([])
    expect(test.calls.some(call => call.method === 'close')).toBe(false)
    release.resolve(undefined)
    await Promise.all([closing, disposal])
    expect(order).toEqual(['consumer', 'cancel'])
    expect(test.calls.map(call => call.method)).toEqual(['hello', 'heartbeat', 'close'])
  })

  it('waits for reverse allocation after caller cancellation and rolls it back before returning', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const controller = new AbortController()
    const cleanup = vi.fn(async () => {})
    const controls: string[][] = []
    const test = setup({ control: async (args) => {
      controls.push(args)
      if (args.includes('forward')) { entered.resolve(undefined); await release.promise; return { stdout: '32109\n' } }
      return {}
    } })
    await test.service.ready
    const opening = test.service.forwardLoopback(31011, cleanup, controller.signal)
    const rejected = expect(opening).rejects.toThrow('cancel reverse allocation')
    await entered.promise
    controller.abort(new Error('cancel reverse allocation'))
    expect(cleanup).not.toHaveBeenCalled()
    release.resolve(undefined)
    await rejected
    expect(cleanup).toHaveBeenCalledOnce()
    expect(controls.map(args => args[args.indexOf('-O') + 1])).toEqual(['forward', 'cancel'])
    expect(test.calls.map(call => call.method)).toEqual(['hello', 'heartbeat'])
    expect(test.child.closed).toBe(false)
  })

  it.each(['', '0', '65536', '32109\n32110', 'untrusted output'])('refuses an invalid remote allocated port %j and closes the ambiguous transport', async (stdout) => {
    const cleanup = vi.fn(async () => {})
    const test = setup({ control: async () => ({ stdout }) })
    await test.service.ready
    await expect(test.service.forwardLoopback(31011, cleanup)).rejects.toThrow('allocated port')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(test.child.closed).toBe(true)
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow('reverse forwarding')
  })

  it('treats a zero exit with OpenSSH cancellation diagnostics as failed cleanup', async () => {
    // oxlint-disable-next-line eslint/prefer-const -- Fixture teardown is registered before the expected failure settles.
    let retained: unknown
    const test = setup({ retainedFailure: () => retained, control: async args => args.includes('forward') ? { stdout: '32109\n' }
      : { stderr: 'mux_client_forward: forwarding request failed: port not forwarded\n' } })
    await test.service.ready
    const forward = await test.service.forwardLoopback(31011, async () => {})
    const closing = forward.close()
    const failure = await closing.then(() => undefined, (error: unknown) => error)
    retained = failure
    expect(failure).toBeInstanceOf(Error)
    expect(test.child.closed).toBe(true)
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow('reverse forwarding')
    // The failed disposer is retained and remains the connection's shutdown result.
    await expect(test.service.dispose()).rejects.toBe(failure)
    test.ctx.logger.error = (() => {}) as typeof test.ctx.logger.error
    await test.ctx.fiber.dispose()
  })

  it('keeps one forwarding owner for a local port and permits reuse after confirmed removal', async () => {
    const test = setup({ control: async args => args.includes('forward') ? { stdout: '32109\n' } : {} })
    await test.service.ready
    const first = await test.service.forwardLoopback(31011, async () => {})
    await expect(test.service.forwardLoopback(31011, async () => {})).rejects.toThrow('already has a forwarding owner')
    await first.close()
    const second = await test.service.forwardLoopback(31011, async () => {})
    await second.close()
  })

  it('refuses cancellation before sending a reverse allocation', async () => {
    const test = setup()
    await test.service.ready
    const cleanup = vi.fn(async () => {})
    await expect(test.service.forwardLoopback(31011, cleanup, AbortSignal.abort(new Error('already cancelled'))))
      .rejects.toThrow('already cancelled')
    expect(transport.exec).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('automatically closes a published reverse forward when its caller is cancelled', async () => {
    const test = setup({ control: async args => args.includes('forward') ? { stdout: '32109\n' } : {} })
    await test.service.ready
    const controller = new AbortController(), cleanup = vi.fn(async () => {})
    const forward = await test.service.forwardLoopback(31011, cleanup, controller.signal)
    controller.abort()
    await forward.close()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(test.calls.map(call => call.method)).toEqual(['hello', 'heartbeat'])
  })

  it.each(['stdout', 'stderr', 'diagnostic', 'process'] as const)('rejects ambiguous %s from reverse allocation and drains its local service', async (mode) => {
    const test = setup({ control: async () => mode === 'stdout' ? { stdout: `${'x'.repeat(65536)}32109\n` }
      : mode === 'stderr' ? { stdout: '32109\n', stderr: 'x'.repeat(65537) }
        : mode === 'diagnostic' ? { stderr: 'remote forwarding failed for listen port 0' }
          : { error: new Error('controlled mux process failure') } })
    await test.service.ready
    const cleanup = vi.fn(async () => {})
    await expect(test.service.forwardLoopback(31011, cleanup)).rejects.toThrow()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(test.child.closed).toBe(true)
  })

  it.each(['consumer', 'barrier', 'both'] as const)('joins forwarding cancellation and reports independent %s cleanup failures', async (mode) => {
    const consumerFailure = new Error('local service cleanup failed'), barrierFailure = new Error('helper barrier failed')
    // oxlint-disable-next-line eslint/prefer-const -- Fixture teardown is registered before the expected failure settles.
    let retained: unknown
    let cancelled = false
    const test = setup({ retainedFailure: () => retained,
      ...mode === 'consumer' ? {} : { heartbeatFailure: barrierFailure },
      control: async (args) => {
        if (args.includes('forward')) return { stdout: '32109\n' }
        cancelled = true
        return {}
      } })
    await test.service.ready
    const controller = new AbortController()
    const forward = await test.service.forwardLoopback(31011, async () => { if (mode !== 'barrier') throw consumerFailure }, controller.signal)
    controller.abort()
    retained = await forward.close().then(() => undefined, (error: unknown) => error)
    expect(cancelled).toBe(true)
    expect(test.child.closed).toBe(true)
    if (mode === 'consumer') expect(retained).toBe(consumerFailure)
    else if (mode === 'both') expect(retained).toMatchObject({ errors: [consumerFailure, expect.objectContaining({ message: 'helper barrier failed' })] })
    else expect(retained).toMatchObject({ message: 'helper barrier failed' })
    await expect(test.service.dispose()).rejects.toBe(retained)
    test.ctx.logger.error = (() => {}) as typeof test.ctx.logger.error
    await test.ctx.fiber.dispose()
  })

  it('rejects unconfirmed forwarding-control cleanup and joins the ambiguous master', async () => {
    // oxlint-disable-next-line typescript/unbound-method -- The captured provider method is called with its original instance below.
    const original = LocalSubprocessRuntime.prototype.spawn
    vi.spyOn(LocalSubprocessRuntime.prototype, 'spawn').mockImplementation(async function (this: LocalSubprocessRuntime, spec) {
      const handle = await original.call(this, spec)
      if (spec.stdio.stdin !== 'ignore') return handle
      return { ...handle, async waitForExit(signal) { await handle.waitForExit(signal); return false } }
    })
    const test = setup({ control: async () => ({ stdout: '32109\n' }) })
    await test.service.ready
    const cleanup = vi.fn(async () => {})
    await expect(test.service.forwardLoopback(31011, cleanup)).rejects.toThrow('control command cleanup could not be confirmed')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(test.child.closed).toBe(true)
  })

  it('preserves an ambiguous allocation and failed master observation while retaining shutdown failures', async () => {
    // oxlint-disable-next-line typescript/unbound-method -- The captured provider method is called with its original instance below.
    const original = LocalSubprocessRuntime.prototype.spawn
    vi.spyOn(LocalSubprocessRuntime.prototype, 'spawn').mockImplementation(async function (this: LocalSubprocessRuntime, spec) {
      const handle = await original.call(this, spec)
      if (spec.stdio.stdin !== 'pipe') return handle
      return { ...handle, async waitForExit(signal) { await handle.waitForExit(signal); return false } }
    })
    // oxlint-disable-next-line eslint/prefer-const -- Fixture teardown is registered before the expected failure settles.
    let retained: unknown
    const test = setup({ retainedFailure: () => retained, control: async () => ({ stdout: 'not a port' }) })
    test.ctx.logger.error = (() => {}) as typeof test.ctx.logger.error
    await test.service.ready
    await expect(test.service.forwardLoopback(31011, async () => {})).rejects.toMatchObject({ errors: [
      expect.objectContaining({ message: 'SSH returned an invalid allocated port' }),
      expect.objectContaining({ message: 'SSH transport cleanup could not be confirmed' }),
    ] })
    retained = await test.service.dispose().then(() => undefined, (error: unknown) => error)
    expect(retained).toMatchObject({ errors: [
      expect.objectContaining({ message: 'SSH transport cleanup could not be confirmed' }),
      expect.objectContaining({ message: 'SSH transport cleanup could not be confirmed' }),
    ] })
    expect(test.child.closed).toBe(true)
    await test.ctx.fiber.dispose()
  })

  it('joins already-running consumer cleanup before its last helper request', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const test = setup({ handle: async (method) => {
      if (method !== 'process.wait') throw new Error(`Unexpected cleanup method ${method}`)
      return true
    } })
    await test.service.ready
    let confirmed = false
    const close = test.service.retainConsumer(async () => {
      entered.resolve(undefined)
      await release.promise
      confirmed = await test.service.request('process.wait', { id: '3f36240f-1daa-46f7-99d1-f138843c0f15' }, z.boolean())
    })
    const consumer = close()
    await entered.promise
    const connection = test.service.dispose()
    try {
      expect(test.child.signals).toEqual([])
      expect(test.calls.some(call => call.method === 'close')).toBe(false)
      await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow('closed')
    } finally { release.resolve(undefined); await Promise.all([consumer, connection]) }
    expect(confirmed).toBe(true)
  })

  it('still disposes its private local process provider when a retained consumer fails', async () => {
    const failure = new Error('remote consumer cleanup failed')
    const test = setup({ expectedDisposalFailure: failure })
    test.ctx.logger.error = (() => {}) as typeof test.ctx.logger.error
    await test.service.ready
    test.service.retainConsumer(async () => { throw failure })
    await expect(test.service.dispose()).rejects.toBe(failure)
    expect(test.child.closed).toBe(true)
    expect(test.calls.some(call => call.method === 'close')).toBe(true)
    await test.ctx.fiber.dispose()
    expect(test.ctx.registry.has(LocalSubprocessRuntime)).toBe(false)
  })

  it('retains the transport through enclosing-owner cleanup of an admitted remote process', async () => {
    const started = Promise.withResolvers<undefined>(), stopping = Promise.withResolvers<undefined>()
    const stopped = Promise.withResolvers<null>(), finished = Promise.withResolvers<never>()
    const observing = Promise.withResolvers<undefined>()
    void finished.promise.catch(() => { /* teardown may precede admission of the fixture's process.done request */ })
    const test = setup({ handle: async (method) => {
      if (method === 'process.prepare') return { id: '3f36240f-1daa-46f7-99d1-f138843c0f15', streams: {} }
      if (method === 'process.start') { started.resolve(undefined); return {} }
      if (method === 'process.done') { observing.resolve(undefined); return finished.promise }
      if (method === 'process.wait' || method === 'process.terminate') {
        stopping.resolve(undefined)
        await stopped.promise
        return method === 'process.wait' ? true : null
      }
      throw new Error(`Unexpected cleanup operation ${method}`)
    } })
    const errors: unknown[] = []
    test.ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof test.ctx.logger.error
    await test.service.ready
    await test.ctx.plugin(SshSubprocessRuntime)
    const handle = await test.ctx.subprocess.spawn({
      argv: ['remote-node'], cwd: '/remote/workspace', graceMs: 50,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    })
    void handle.done.catch(() => {})
    await started.promise
    await observing.promise
    const closing = test.ctx.fiber.dispose()
    try {
      const phase = await Promise.race([stopping.promise.then(() => 'consumer-cleanup'), closing.then(() => 'closed')])
      expect(phase).toBe('consumer-cleanup')
      expect(test.calls.some(call => call.method === 'close')).toBe(false)
      expect(test.child.signals).toEqual([])
    } finally {
      stopped.resolve(null)
      finished.reject(new Error('fixture process stopped'))
      await closing
    }
    expect(errors).toEqual([])
    expect(test.calls.some(call => call.method === 'close')).toBe(true)
  })

  it('refuses managed SSH transport allocation when the node accountant denies admission', async () => {
    const acquire = vi.fn().mockRejectedValue(new Error('node process admission refused'))
    const test = setup({ budget: { acquire } })
    const outcome = await test.service.ready.then(() => ({ status: 'ready' }), (error: unknown) => ({ status: 'failed', error }))
    expect(outcome.status).toBe('failed')
    expect(acquire).toHaveBeenCalledOnce()
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it.each([
    { host: '-option' }, { host: 'alias; command' }, { launch: { kind: 'node-script', node: 'relative' } }, { helperHash: 'bad' },
    { launch: { kind: 'node-script', node: '/remote/node', bootstrapPath: '/remote/bootstrap.js' } }, { launch: { kind: 'node-script', node: '/remote/node', bootstrapHash: 'b'.repeat(64) } },
    { requestTimeoutMs: 0 }, { requestTimeoutMs: 2_147_483_648 },
    { maxFrameBytes: 64 * 1024 * 1024 + 1 }, { maxPending: 129 }, { leaseMs: 2999 },
  ] satisfies Partial<Config>[])('rejects invalid deployment configuration before SSH starts: %j', (invalid) => {
    expect(() => setup({ config: invalid })).toThrow()
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('rejects a non-POSIX client before starting SSH', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try { expect(() => setup()).toThrow('POSIX client') }
    finally { platform.mockRestore() }
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('publishes only verified remote coordinates and quotes the configured executable paths', async () => {
    const test = setup({ holdHello: true, config: { helper: "/remote/helper's file.js", launch: { kind: 'node-script', node: '/remote/node', bootstrapPath: '/remote/process.js', bootstrapHash: 'b'.repeat(64) } }, hello: { bootstrapHash: 'b'.repeat(64) } })
    expect(() => test.service.ptcLaunch).toThrow('not ready')
    await test.helloEntered
    test.releaseHello()
    await test.service[Service.init]()
    expect(test.service.ptcLaunch).toEqual({ kind: 'node-script', executable: '/canonical/node', bootstrapPath: '/remote/process.js' })
    const argv = transport.spawn.mock.calls[0]?.[1] as string[]
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('ForwardAgent=no')
    expect(argv.at(-1)).toBe("'/remote/node' '--disable-sigusr1' '/remote/helper'\\''s file.js'")
    expect(test.calls[0]?.params).toEqual({ protocol: 2, workspace: '/remote/workspace', leaseMs: 30_000, bootstrapPath: '/remote/process.js' })
  })

  it('permits filesystem-only deployments and refuses an unconfigured PTC bootstrap getter', async () => {
    const test = setup()
    await test.service.ready
    expect(() => test.service.ptcLaunch).toThrow('verified bootstrapPath')
    expect(await test.service.request('echo', { value: 42 }, z.object({ value: z.number() }))).toEqual({ value: 42 })
  })

  it('launches an executable directly and publishes its embedded PTC worker', async () => {
    const test = setup({
      config: { launch: { kind: 'executable' }, helper: '/remote/helper with spaces' },
      hello: { kind: 'executable', executable: '/canonical/dsh-ssh-helper' },
    })
    await test.service.ready
    expect(test.service.ptcLaunch).toEqual({ kind: 'embedded', executable: '/canonical/dsh-ssh-helper' })
    const argv = transport.spawn.mock.calls[0]?.[1] as string[]
    expect(argv.at(-1)).toBe("NODE_OPTIONS='--disable-sigusr1' '/remote/helper with spaces'")
    expect(test.calls[0]?.params).toEqual({ protocol: 2, workspace: '/remote/workspace', leaseMs: 30_000 })
  })

  it.each([
    { hello: { hash: 'c'.repeat(64) }, error: 'helper digest' },
    { hello: { bootstrapHash: 'c'.repeat(64) }, error: 'bootstrap digest' },
    { hello: { protocol: 1 }, error: 'Invalid' },
    { hello: { kind: 'executable' }, error: 'launch kind' },
  ])('refuses a mismatched helper identity before readiness: $error', async ({ hello, error }) => {
    const test = setup({ hello })
    await expect(test.service.ready).rejects.toThrow(error)
    expect(() => test.service.ptcLaunch).toThrow('not ready')
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow()
  })

  it('joins early disposal before allocating a local directory or transport', async () => {
    const test = setup()
    const rejected = expect(test.service.ready).rejects.toThrow('closed before startup')
    const disposal = test.service.dispose()
    await Promise.all([rejected, disposal])
    expect(transport.spawn).not.toHaveBeenCalled()
    expect(transport.directory).not.toHaveBeenCalled()
    expect(transport.remove).not.toHaveBeenCalled()
  })

  it('stops a plugin-owned master unloaded during hello while unrelated plugins remain usable', async () => {
    const test = setup({ holdHello: true, pluginOwned: true })
    test.ctx.logger.error = (() => {}) as typeof test.ctx.logger.error
    await test.helloEntered
    const sibling = test.ctx.plugin(() => {})
    await sibling
    const readiness = expect(test.service.ready).rejects.toThrow()
    if (test.owner === undefined) throw new Error('SSH fixture requires a plugin owner')
    await Promise.all([readiness, test.owner.dispose()])
    expect(test.child.closed).toBe(true)
    await sibling.dispose()
  })

  it('removes a directory created after connection disposal starts without spawning a master', async () => {
    const directory = Promise.withResolvers<string>(), entered = Promise.withResolvers<undefined>()
    const test = setup()
    transport.directory.mockImplementationOnce(() => { entered.resolve(undefined); return directory.promise })
    onTestFinished(() => { directory.resolve('/virtual/ssh-startup') })
    await entered.promise
    const readiness = expect(test.service.ready).rejects.toThrow('closed before startup')
    const closing = test.service.dispose()
    directory.resolve('/virtual/ssh-startup')
    await Promise.all([readiness, closing])
    expect(transport.spawn).not.toHaveBeenCalled()
    expect(transport.remove).toHaveBeenCalledWith('/virtual/ssh-startup', { recursive: true, force: true })
  })

  it.each(['stdin', 'stdout', 'stderr'] as const)('rejects a provider without required %s and closes its native process', async (missing) => {
    // oxlint-disable-next-line typescript/unbound-method -- The captured provider method is called with its original instance below.
    const original = LocalSubprocessRuntime.prototype.spawn
    vi.spyOn(LocalSubprocessRuntime.prototype, 'spawn').mockImplementation(async function (this: LocalSubprocessRuntime, spec) {
      const handle = await original.call(this, spec)
      return spec.stdio.stdin === 'pipe' ? { ...handle, [missing]: undefined } : handle
    })
    const test = setup()
    await expect(test.service.ready).rejects.toThrow('requires piped standard streams')
    await test.service.dispose()
    expect(test.child.closed).toBe(true)
  })

  it('converts an unknown process-provider rejection into a connection failure', async () => {
    const outcome = Promise.withResolvers<never>()
    // oxlint-disable-next-line typescript/unbound-method -- The captured provider method is called with its original instance below.
    const original = LocalSubprocessRuntime.prototype.spawn
    vi.spyOn(LocalSubprocessRuntime.prototype, 'spawn').mockImplementation(async function (this: LocalSubprocessRuntime, spec) {
      const handle = await original.call(this, spec)
      return spec.stdio.stdin === 'pipe' ? { ...handle, done: Promise.race([handle.done, outcome.promise]) } : handle
    })
    const test = setup()
    await test.service.ready
    outcome.reject('provider process failure')
    await expect.poll(() => test.child.closed).toBe(true)
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toMatchObject({ message: 'SSH transport failed', cause: 'provider process failure' })
  })

  it('reports failed helper shutdown while still stopping the native master', async () => {
    // oxlint-disable-next-line eslint/prefer-const -- Fixture teardown is registered before the expected failure settles.
    let retained: unknown
    const test = setup({ closeFailure: new Error('helper close failed'), retainedFailure: () => retained })
    test.ctx.logger.error = (() => {}) as typeof test.ctx.logger.error
    await test.service.ready
    retained = await test.service.dispose().then(() => undefined, (error: unknown) => error)
    expect(retained).toMatchObject({ message: 'helper close failed' })
    expect(test.child.closed).toBe(true)
    expect(transport.remove).toHaveBeenCalledWith('/virtual/ssh-startup', { recursive: true, force: true })
    await test.ctx.fiber.dispose()
  })

  it('joins socket closure arriving with the final helper response', async () => {
    const test = setup()
    await test.service.ready
    await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    test.child.stdout.once('data', () => { test.secure.destroy(); test.raw.destroy() })
    await test.service.dispose()
    expect(test.secure.closed).toBe(true)
    expect(test.raw.closed).toBe(true)
  })

  it('retains a failed private-directory removal after native transport cleanup', async () => {
    const unavailable = new Error('private SSH directory inaccessible')
    const test = setup({ expectedDisposalFailure: unavailable })
    test.ctx.logger.error = (() => {}) as typeof test.ctx.logger.error
    await test.service.ready
    transport.remove.mockRejectedValueOnce(unavailable)
    await expect(test.service.dispose()).rejects.toBe(unavailable)
    expect(test.child.closed).toBe(true)
    expect(transport.remove).toHaveBeenCalledWith('/virtual/ssh-startup', { recursive: true, force: true })
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow('closed')
  })

  it('returns a canceled late transport grant before allocating OpenSSH', async () => {
    const requested = Promise.withResolvers<AbortSignal>(), grant = Promise.withResolvers<import('@deepseek-ai/dsh-resource-budget').ResourceLease>()
    const release = vi.fn(async () => {})
    const test = setup({ budget: { acquire: (request) => {
      if (request.signal === undefined) throw new Error('SSH transport requires startup cancellation')
      requested.resolve(request.signal)
      return grant.promise
    } } })
    const failed = expect(test.service.ready).rejects.toThrow('closed before startup')
    const signal = await requested.promise
    const disposal = test.service.dispose()
    try {
      expect(signal.aborted).toBe(true)
      expect(transport.spawn).not.toHaveBeenCalled()
      grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => { throw new Error('unused grant is not uncertain') } })
      await Promise.all([failed, disposal])
      expect(transport.spawn).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledOnce()
    } finally {
      grant.resolve({ signal: AbortSignal.abort(), release, uncertain: async () => {} })
      await disposal
    }
  })

  it('preserves the first SSH process error and closes later requests', async () => {
    const test = setup()
    await test.service.ready
    const failure = new Error('SSH transport refused')
    test.child.emit('error', failure)
    await Promise.resolve()
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toBe(failure)
    expect(test.child.signals).toContain('SIGTERM')
  })

  it('cancels bounded administrative work and allows explicit process waits past that deadline', async () => {
    const test = setup()
    await test.service.ready
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      const pending = test.service.request('held', {}, z.null())
      const rejected = expect(pending).rejects.toThrow('cancelled')
      const remoteSignal = await test.requestEntered
      deadline.abort()
      await rejected
      await expect.poll(() => remoteSignal.aborted).toBe(true)
      expect(timeout).toHaveBeenCalledWith(1000)
      test.release()
      expect(await test.service.request('echo', 42, z.number(), undefined, true)).toBe(42)
      const caller = AbortSignal.abort(new Error('caller cancelled'))
      await expect(test.service.request('echo', {}, z.unknown(), caller)).rejects.toThrow('caller cancelled')
    } finally { timeout.mockRestore() }
  })

  it('returns authenticated paused streams and rejects paths outside the helper root', async () => {
    const test = setup()
    await test.service.ready
    for (const path of ['/tmp/other/control', '/tmp/remote-helper/control:extra', '/tmp/remote-helper/control\n']) {
      await expect(test.service.connectStream({ path, capability: 'b'.repeat(64) })).rejects.toThrow('invalid stream path')
    }
    expect(transport.exec).not.toHaveBeenCalled()
    const socket = await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    expect(socket).toBe(test.secure)
    expect(socket.readableFlowing).toBe(false)
    socket.destroy(new Error('data channel closed'))
    await expect.poll(() => transport.exec.mock.calls.length).toBe(2)
    expect(transport.exec.mock.calls[1]?.[1]).toContain('cancel')
  })

  it('cancels a failed forwarding reservation before surfacing its error', async () => {
    const failure = new Error('forwarding refused')
    const test = setup({ forwardFailure: failure })
    await test.service.ready
    await expect(test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })).rejects.toBe(failure)
    expect(transport.exec.mock.calls[1]?.[1]).toContain('cancel')
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('keeps caller cancellation attached while a forwarded socket is connecting', async () => {
    const test = setup({ holdConnect: true })
    await test.service.ready
    const controller = new AbortController()
    const pending = test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }, controller.signal)
    const rejected = expect(pending).rejects.toThrow('caller stopped')
    await expect.poll(() => transport.connect.mock.calls.length).toBe(1)
    controller.abort('caller stopped')
    await rejected
    expect(test.raw.destroyed).toBe(true)
  })

  it('reports directory creation failure without starting a helper process', async () => {
    const failure = new Error('temporary directory unavailable')
    const test = setup({ directoryFailure: failure })
    await expect(test.service.ready).rejects.toBe(failure)
    await test.service.dispose()
    expect(transport.spawn).not.toHaveBeenCalled()
    expect(transport.remove).not.toHaveBeenCalled()
  })

  it('invalidates requests when a heartbeat reports a failed helper', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const test = setup({ heartbeatFailure: new Error('helper unhealthy') })
    try {
      await test.service.ready
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow('helper unhealthy')
      expect(test.child.signals).toContain('SIGTERM')
    } finally { await test.service.dispose(); vi.useRealTimers() }
  })

  it('force-kills a helper process that does not exit after termination', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const test = setup()
    try {
      await test.service.ready
      test.child.ignoreTerm = true
      const disposal = test.service.dispose()
      await test.child.terminating.promise
      await vi.advanceTimersByTimeAsync(1000)
      await disposal
      expect(test.child.signals).toContain('SIGKILL')
    } finally {
      test.child.ignoreTerm = false
      test.child.kill()
      await test.service.dispose()
      vi.useRealTimers()
    }
  })

  it('joins authenticated sockets whose native close callbacks are delayed', async () => {
    const test = setup()
    await test.service.ready
    await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    test.raw.holdDestroy = true
    test.secure.holdDestroy = true
    let disposed = false
    const disposal = test.service.dispose().then(() => { disposed = true })
    await test.child.terminating.promise
    expect(disposed).toBe(false)
    expect(test.raw.finishDestroy).toBeTypeOf('function')
    expect(test.secure.finishDestroy).toBeTypeOf('function')
    test.secure.releaseDestroy()
    test.raw.releaseDestroy()
    await disposal
    expect(test.raw.closed).toBe(true)
    expect(test.secure.closed).toBe(true)
  })

  it('closes authenticated sockets when the SSH process fails', async () => {
    const test = setup()
    await test.service.ready
    await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    test.child.emit('error', new Error('transport lost'))
    await test.service.dispose()
    expect(test.raw.destroyed).toBe(true)
    expect(test.secure.destroyed).toBe(true)
  })

  it('rolls back a forward when caller cancellation arrives with native control completion', async () => {
    const controller = new AbortController()
    let armed = false
    const controls: string[][] = []
    const test = setup({
      budget: { async acquire() {
        let settled = false
        return { signal: new AbortController().signal, release: async () => {
          if (settled) return
          settled = true
          if (armed) { armed = false; controller.abort(new Error('cancel completed stream forward')) }
        }, uncertain: async () => {} }
      } },
      control: async (args) => { controls.push(args); return {} },
    })
    await test.service.ready
    armed = true
    await expect(test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }, controller.signal))
      .rejects.toThrow('cancel completed stream forward')
    expect(controls.filter(args => args.includes('cancel'))).toHaveLength(1)
    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.remove).toHaveBeenCalledWith('/virtual/ssh-startup/s0', { force: true })
    expect(await test.service.request('echo', { usable: true }, z.unknown())).toEqual({ usable: true })
  })

  it('invalidates a live master when stream forward cancellation cannot be confirmed', async () => {
    const test = setup({ control: async args => args.includes('cancel') ? { error: new Error('mux cancellation rejected') } : {} })
    await test.service.ready
    const socket = await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    socket.destroy()
    await expect.poll(() => test.child.signals.includes('SIGTERM')).toBe(true)
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow('stream forwarding cleanup')
  })

  it('preserves caller cancellation and a failed forwarding rollback as independent errors', async () => {
    const controller = new AbortController(), cancelled = new Error('cancel completed stream forward')
    let armed = false
    const test = setup({
      budget: { async acquire() {
        let settled = false
        return { signal: new AbortController().signal, release: async () => {
          if (settled) return
          settled = true
          if (armed) { armed = false; controller.abort(cancelled) }
        }, uncertain: async () => {} }
      } },
      control: async args => args.includes('cancel') ? { error: new Error('mux cancellation rejected') } : {},
    })
    await test.service.ready
    armed = true
    const outcome: unknown = await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) }, controller.signal)
      .then(() => undefined, (error: unknown) => error)
    expect(outcome).toBeInstanceOf(AggregateError)
    expect(outcome).toMatchObject({ errors: [cancelled, { message: 'SSH stream forwarding cleanup could not be confirmed' }] })
    expect(test.child.closed).toBe(true)
  })

  it('invalidates the connection after failed forwarding-path removal and still disposes it', async () => {
    const test = setup()
    await test.service.ready
    const socket = await test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
    transport.remove.mockRejectedValueOnce(new Error('forwarding path inaccessible'))
    socket.destroy()
    await expect.poll(() => transport.remove.mock.calls.length).toBe(1)
    await expect.poll(() => test.child.signals.includes('SIGTERM')).toBe(true)
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow('stream forwarding cleanup')
    await test.service.dispose()
    expect(transport.remove).toHaveBeenLastCalledWith('/virtual/ssh-startup', { recursive: true, force: true })
  })

  it('retains failed forwarding rollback and unconfirmed native cleanup independently', async () => {
    // oxlint-disable-next-line typescript/unbound-method -- The captured provider method is called with its original instance below.
    const original = LocalSubprocessRuntime.prototype.spawn
    vi.spyOn(LocalSubprocessRuntime.prototype, 'spawn').mockImplementation(async function (this: LocalSubprocessRuntime, spec) {
      const handle = await original.call(this, spec)
      if (spec.stdio.stdin !== 'pipe') return handle
      return { ...handle, async waitForExit(signal) { await handle.waitForExit(signal); return false } }
    })
    const allocation = new Error('forwarding allocation failed'), cancellation = new Error('mux cancellation rejected')
    // oxlint-disable-next-line eslint/prefer-const -- Fixture teardown is registered before the expected failure settles.
    let retained: unknown
    const test = setup({ retainedFailure: () => retained, forwardFailure: allocation,
      control: async args => args.includes('cancel') ? { error: cancellation } : {} })
    test.ctx.logger.error = (() => {}) as typeof test.ctx.logger.error
    await test.service.ready
    await expect(test.service.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })).rejects.toMatchObject({ errors: [
      allocation,
      { message: 'SSH stream forwarding cleanup and process observation failed', errors: [
        { message: 'SSH stream forwarding cleanup could not be confirmed', cause: cancellation },
        { message: 'SSH transport cleanup could not be confirmed' },
      ] },
    ] })
    retained = await test.service.dispose().then(() => undefined, (error: unknown) => error)
    expect(retained).toMatchObject({ message: 'SSH transport cleanup could not be confirmed' })
    expect(transport.remove).not.toHaveBeenCalled()
    expect(test.child.closed).toBe(true)
    await test.ctx.fiber.dispose()
  })
})
