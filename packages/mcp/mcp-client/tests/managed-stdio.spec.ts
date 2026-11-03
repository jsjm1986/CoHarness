/** Controlled native process observations exercise SDK byte transport and cleanup failures. */
import { PassThrough, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { McpProcessOwner } from '../src/managed-stdio.ts'
import type { StdioConfig } from '../src/index.ts'

const native = vi.hoisted(() => ({ allocate: vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>() }))
vi.mock('@deepseek-ai/dsh-subprocess-local', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-subprocess-local')>()
  return { ...original, LocalSubprocessRuntime: class extends original.LocalSubprocessRuntime {
    protected override spawnProcess(spec: SubprocessSpawnSpec): SubprocessHandle { return native.allocate(spec) }
  } }
})
afterEach(() => { native.allocate.mockReset() })

const config: StdioConfig = {
  transport: 'stdio', serverName: 'controlled', command: 'fixture', args: [], env: {}, cwd: '',
  toolCallTimeoutMs: 5_000, failOnStartupError: true, processGraceMs: 50, processCloseTimeoutMs: 5_000,
}

function processFixture(options: { missingPipe?: boolean; writeError?: boolean } = {}) {
  const stdout = new PassThrough(), stderr = new PassThrough()
  const stdin = options.writeError ? new Writable({ write(_chunk, _encoding, done) { done(new Error('MCP write failed')) } }) : new PassThrough()
  const done = Promise.withResolvers<SubprocessOutcome>()
  void done.promise.catch(() => {})
  const state = { unconfirmed: false, observationError: undefined as Error | undefined }
  const terminate = vi.fn(() => { done.resolve({ exitCode: null, signal: 'SIGTERM' }) })
  const handle: SubprocessHandle = {
    stdin, stdout: options.missingPipe ? undefined : stdout, stderr, control: undefined, collected: {}, done: done.promise, terminate,
    async waitForExit() { if (state.observationError !== undefined) throw state.observationError; return !state.unconfirmed },
  }
  return { handle, stdin, stdout, stderr, done, terminate, state }
}

function owned(options: Parameters<typeof processFixture>[0] = {}) {
  const ctx = new Context(), fixture = processFixture(options), reported: unknown[] = []
  const logger = vi.spyOn(ctx.logger, 'error').mockImplementation((error: unknown) => { reported.push(error) })
  const owner = new McpProcessOwner(ctx, config)
  native.allocate.mockReturnValue(fixture.handle)
  onTestFinished(async () => {
    fixture.state.unconfirmed = false
    fixture.state.observationError = undefined
    fixture.done.resolve({ exitCode: 0, signal: null })
    try { await owner.close(); await ctx.fiber.dispose() } finally {
      fixture.stdin.destroy(); fixture.stdout.destroy(); fixture.stderr.destroy(); logger.mockRestore()
    }
  })
  return { ctx, owner, fixture, reported, transport: owner.transport() }
}

it.each(['processGraceMs', 'processCloseTimeoutMs', 'startupTimeoutMs'] as const)('refuses invalid configured %s before allocating an owner', (name) => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  expect(() => new McpProcessOwner(ctx, { ...config, [name]: 0 })).toThrow('positive timer integer')
  expect(native.allocate).not.toHaveBeenCalled()
})

it('rejects a second start and writes only while its managed transport is connected', async () => {
  const test = owned()
  await expect(test.transport.send({ jsonrpc: '2.0', method: 'ping', id: 1 })).rejects.toThrow('not connected')
  await test.transport.start()
  await expect(test.transport.start()).rejects.toThrow('already started')
  await test.transport.send({ jsonrpc: '2.0', method: 'ping', id: 1 })
  await test.transport.close()
  await expect(test.transport.send({ jsonrpc: '2.0', method: 'ping', id: 2 })).rejects.toThrow('not connected')
  expect(native.allocate).toHaveBeenCalledOnce()
})

it('terminates a partially allocated process when its requested protocol pipe is missing', async () => {
  const test = owned({ missingPipe: true })
  await expect(test.transport.start()).rejects.toThrow('did not supply protocol pipes')
  await test.owner.close()
  expect(test.fixture.terminate).toHaveBeenCalled()
})

it('returns an outbound stream failure and contains both stream error observers', async () => {
  const test = owned({ writeError: true })
  const observer = vi.fn(() => { throw new Error('error observer failed') })
  test.transport.onerror = observer
  await test.transport.start()
  await expect(test.transport.send({ jsonrpc: '2.0', method: 'ping', id: 1 })).rejects.toThrow('MCP write failed')
  test.fixture.stdout.emit('error', new Error('stdout failed'))
  expect(observer).toHaveBeenCalled()
  expect(test.reported.some(error => error instanceof Error && error.message === 'error observer failed')).toBe(true)
  await test.owner.close()
})

it('contains a malformed JSON-RPC message and closes its managed range', async () => {
  const test = owned(), errors: Error[] = []
  test.transport.onerror = (error) => { errors.push(error) }
  await test.transport.start()
  test.fixture.stdout.write('{"jsonrpc":"2.0","method":42}\n')
  await test.transport.close()
  expect(errors).toHaveLength(1)
  expect(test.fixture.terminate).toHaveBeenCalled()
})

it('contains a message consumer failure and a close observer failure after confirmed termination', async () => {
  const test = owned()
  test.transport.onmessage = () => { throw new Error('message observer failed') }
  test.transport.onclose = () => { throw new Error('close observer failed') }
  test.transport.onerror = vi.fn()
  await test.transport.start()
  test.fixture.stdout.write('{"jsonrpc":"2.0","method":"test/message"}\n')
  await expect(test.transport.close()).resolves.toBeUndefined()
  expect(test.transport.onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'message observer failed' }))
  expect(test.reported.some(error => error instanceof Error && error.message === 'close observer failed')).toBe(true)
})

it('reports a process failure whose rejection does not contain an Error', async () => {
  const test = owned(), reported = Promise.withResolvers<Error>()
  test.transport.onerror = (error) => { reported.resolve(error) }
  await test.transport.start()
  test.fixture.done.reject('opaque native failure')
  expect((await reported.promise).cause).toBe('opaque native failure')
  await test.owner.close()
})

it.each(['unconfirmed', 'observationError'] as const)('retains and retries a failed managed range observation: %s', async (failure) => {
  const test = owned()
  await test.transport.start()
  if (failure === 'unconfirmed') test.fixture.state.unconfirmed = true
  else test.fixture.state.observationError = new Error('native range observation failed')
  await expect(test.owner.close()).rejects.toThrow('MCP managed process cleanup failed')
  expect(test.owner.owns(test.transport)).toBe(true)
  test.fixture.state.unconfirmed = false
  test.fixture.state.observationError = undefined
  await test.owner.close()
  expect(test.owner.owns(test.transport)).toBe(false)
})

it('joins a process allocated concurrently with owner cancellation before publishing it', async () => {
  const test = owned()
  native.allocate.mockImplementation(() => { void test.owner.close().catch(() => {}); return test.fixture.handle })
  await expect(test.transport.start()).rejects.toThrow('MCP stdio transport closed')
  await test.owner.close()
  expect(test.fixture.terminate).toHaveBeenCalled()
})

it('ignores incoming bytes as soon as closing is requested', async () => {
  const test = owned(), receive = vi.fn()
  test.transport.onmessage = receive
  await test.transport.start()
  const closing = test.transport.close()
  test.fixture.stdout.write('{"jsonrpc":"2.0","method":"late/message"}\n')
  await closing
  expect(receive).not.toHaveBeenCalled()
})
