/** Install stream owns event subscriptions and waits for the actual operation to settle. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installationStream } from '../src/install-stream.ts'
import type { ChangeResult, PluginInstallFrame, PluginInstallLogChunk, PluginInstallRequestId } from '../src/types.ts'

const id = 'installation-1' as PluginInstallRequestId
const result: ChangeResult = { changed: true, application: 'applied', stage: 'install', target: 'example' }
const chunk: PluginInstallLogChunk = { requestId: id, jobId: 'pnpm-1', argv: ['pnpm', 'add', 'example'], cwd: '/profile', stream: 'stdout', text: 'installed\n' }
function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

it('subscribes before synchronous output and excludes other installations', async () => {
  const ctx = fixture()
  const stream = installationStream(ctx, id, async () => {
    ctx.emit('plugin-manager/install-log', { ...chunk, requestId: 'another' as PluginInstallRequestId })
    ctx.emit('plugin-manager/install-state', { requestId: 'another' as PluginInstallRequestId, phase: 'installing' })
    ctx.emit('plugin-manager/install-state', { requestId: id, phase: 'installing' })
    ctx.emit('plugin-manager/install-log', chunk)
    return result
  }, 8192, new AbortController().signal)
  const frames: PluginInstallFrame[] = []
  for await (const frame of stream) frames.push(frame)
  expect(frames).toEqual([
    { type: 'progress', progress: { requestId: id, phase: 'installing' } },
    { type: 'log', chunk }, { type: 'result', value: result },
  ])
  expect(ctx.events._hooks['plugin-manager/install-log']).toHaveLength(0)
  expect(ctx.events._hooks['plugin-manager/install-state']).toHaveLength(0)
})

it('waits for delayed output and preserves a rejected operation', async () => {
  const ctx = fixture(), entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<ChangeResult>()
  const stream = installationStream(ctx, id, () => {
    entered.resolve(undefined); return finish.promise
  }, 8192, new AbortController().signal)
  const pending = stream.next()
  await entered.promise
  ctx.emit('plugin-manager/install-log', chunk)
  expect(await pending).toMatchObject({ value: { type: 'log', chunk } })
  const failure = new Error('installation failed')
  finish.reject(failure)
  await expect(stream.next()).rejects.toBe(failure)
})

it('aborts when returned and waits for restoration before returning', async () => {
  const ctx = fixture(), entered = Promise.withResolvers<AbortSignal>(), cleaned = Promise.withResolvers<ChangeResult>()
  const stream = installationStream(ctx, id, (signal) => {
    entered.resolve(signal); ctx.emit('plugin-manager/install-log', chunk); return cleaned.promise
  }, 8192, new AbortController().signal)
  await stream.next()
  const signal = await entered.promise
  const closed = vi.fn()
  const stopped = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  const closing = stream.return(undefined).then(closed)
  await stopped
  expect(signal.aborted).toBe(true)
  expect(closed).not.toHaveBeenCalled()
  ctx.emit('plugin-manager/install-log', { ...chunk, text: 'late output' })
  cleaned.resolve(result)
  await closing
  expect(closed).toHaveBeenCalledOnce()
})

it('cancels on transport abort and does not finish before cleanup', async () => {
  const ctx = fixture(), entered = Promise.withResolvers<undefined>(), cleaned = Promise.withResolvers<ChangeResult>()
  const transport = new AbortController()
  const stream = installationStream(ctx, id, () => { entered.resolve(undefined); return cleaned.promise }, 8192, transport.signal)
  const pending = stream.next()
  const reason = new Error('browser disconnected')
  const rejected = expect(pending).rejects.toBe(reason)
  await entered.promise
  transport.abort(reason)
  ctx.emit('plugin-manager/install-log', chunk)
  cleaned.resolve(result)
  await rejected
})

it('bounds UTF-8 queued output and cancels an overflowing producer', async () => {
  const ctx = fixture(), cleaned = Promise.withResolvers<ChangeResult>()
  const frameBytes = Buffer.byteLength(JSON.stringify({ type: 'log', chunk: { ...chunk, text: '汉字' } }))
  let signal: AbortSignal | undefined
  const stream = installationStream(ctx, id, (current) => {
    signal = current
    ctx.emit('plugin-manager/install-log', { ...chunk, text: '汉字' })
    ctx.emit('plugin-manager/install-log', chunk)
    return cleaned.promise
  }, frameBytes, new AbortController().signal)
  const pending = stream.next()
  const rejected = expect(pending).rejects.toThrow('buffer limit')
  expect(signal?.aborted).toBe(true)
  cleaned.resolve(result)
  await rejected
})

it('does not start an already-aborted request', async () => {
  const ctx = fixture(), transport = new AbortController(), run = vi.fn(async () => result)
  transport.abort(new Error('closed'))
  await expect(installationStream(ctx, id, run, 8192, transport.signal).next()).rejects.toThrow('closed')
  expect(run).not.toHaveBeenCalled()
})
