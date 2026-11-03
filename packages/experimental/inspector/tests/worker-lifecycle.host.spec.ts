/** Host-side Worker lifecycle behavior. */

import { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import type { ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import { InspectorWorkerLifecycle } from '../src/host/bridge/lifecycle.ts'

describe('Inspector Worker lifecycle', () => {
  it.each([
    ['invalid-frame', 'parentPort.postMessage({ type: "ready", host: "remote.example" })', /control|message|ready|invalid|protocol/iu],
    ['reported-failure', 'parentPort.postMessage({ type: "failure", message: "binding refused" })', /binding refused/u],
    ['crashed', 'throw new Error("startup crash")', /startup crash/u],
    ['exited', 'process.exit(0)', /exited before readiness/u],
  ] as const)('rejects %s before readiness and removes its startup listener', async (_name, source, failure) => {
    const worker = new Worker(`const {parentPort}=require('node:worker_threads');${source}`, { eval: true })
    const lifecycle = new InspectorWorkerLifecycle(worker)
    try {
      await expect(lifecycle.waitForReady(10_000)).rejects.toThrow(failure)
      expect(worker.listenerCount('message')).toBe(0)
    } finally { await lifecycle.terminate() }
  })

  it('times out an unready Worker and confirms forced termination after its graceful deadline', async () => {
    const worker = new Worker('setInterval(() => {}, 1000)', { eval: true })
    const lifecycle = new InspectorWorkerLifecycle(worker)
    try {
      await expect(lifecycle.waitForReady(5)).rejects.toThrow('did not become ready')
      expect(worker.listenerCount('message')).toBe(0)
      await expect(lifecycle.stop(5)).rejects.toThrow('was terminated')
      expect(worker.threadId).toBe(-1)
    } finally { await lifecycle.terminate() }
  })

  it('waits for readiness after a non-ready control frame', async () => {
    const worker = new Worker(`const {parentPort}=require('node:worker_threads');
      parentPort.postMessage({type:'stopped'});
      parentPort.postMessage({type:'ready',host:'127.0.0.1',port:9230,targetId:'test'});
      setInterval(()=>{},1000)`, { eval: true })
    const lifecycle = new InspectorWorkerLifecycle(worker)
    try { await expect(lifecycle.waitForReady(10_000)).resolves.toMatchObject({ targetId: 'test' }) }
    finally { await lifecycle.terminate() }
  })

  it('preserves a non-Error startup cancellation and detaches its listeners', async () => {
    const worker = new Worker('setInterval(() => {}, 1000)', { eval: true })
    const lifecycle = new InspectorWorkerLifecycle(worker), controller = new AbortController()
    const cancelled = lifecycle.waitForReady(10_000, controller.signal)
    controller.abort('operator cancelled')
    try {
      await expect(cancelled).rejects.toMatchObject({ message: 'inspector: startup canceled', cause: 'operator cancelled' })
      expect(worker.listenerCount('message')).toBe(0)
      await expect(lifecycle.waitForReady(10_000, controller.signal)).rejects.toBe('operator cancelled')
    } finally { await lifecycle.terminate() }
  })

  it('reports an already-observed unexpected exit once when the consumer becomes ready', async () => {
    const worker = new Worker('process.exit(7)', { eval: true })
    const lifecycle = new InspectorWorkerLifecycle(worker), listener = vi.fn()
    try {
      await new Promise<void>((done) => { worker.once('exit', () => { done() }) })
      lifecycle.markRunning(listener); lifecycle.markRunning(listener)
      expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'inspector Worker exited unexpectedly with code 7' }))
    } finally { await lifecycle.terminate() }
  })

  it('preserves termination and uncertainty transport failures together', async () => {
    const worker = new Worker('setInterval(() => {}, 1000)', { eval: true })
    const nativeError = new Error('Native Worker termination refused'), reportError = new Error('accountant disconnected')
    const lease: ResourceLease = {
      signal: new AbortController().signal, release: async () => {}, uncertain: async () => { throw reportError },
    }
    const lifecycle = new InspectorWorkerLifecycle(worker, lease)
    const terminate = vi.spyOn(worker, 'terminate').mockRejectedValueOnce(nativeError)
    try {
      await expect(lifecycle.terminate()).rejects.toMatchObject({ errors: [nativeError, reportError] })
      expect(worker.threadId).not.toBe(-1)
    } finally { terminate.mockRestore(); await worker.terminate() }
  })

  it('keeps an uncertain permit after failed termination and accepts a later physical exit', async () => {
    const worker = new Worker('setInterval(() => {}, 1000)', { eval: true })
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
    const lease: ResourceLease = { signal: new AbortController().signal, release, uncertain }
    const lifecycle = new InspectorWorkerLifecycle(worker, lease)
    const terminate = vi.spyOn(worker, 'terminate').mockRejectedValueOnce(new Error('native Worker termination refused'))
    try {
      await expect(lifecycle.terminate()).rejects.toThrow('native Worker termination refused')
      expect(worker.threadId).not.toBe(-1)
      expect(uncertain).toHaveBeenCalledOnce()
      expect(release).not.toHaveBeenCalled()
    } finally { terminate.mockRestore(); await worker.terminate() }
    await lifecycle.terminate()
    expect(lifecycle.exitCode).toBeTypeOf('number')
    expect(release).toHaveBeenCalledOnce()
  })

  it('retries accounting after the previous completion of an exited Worker was rejected', async () => {
    const worker = new Worker('setInterval(() => {}, 1000)', { eval: true })
    const release = vi.fn(async () => { throw new Error('accountant disconnected') })
    const lease: ResourceLease = { signal: new AbortController().signal, release, uncertain: async () => {} }
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lifecycle = new InspectorWorkerLifecycle(worker, lease)
    try {
      await worker.terminate()
      await vi.waitFor(() => { expect(warning).toHaveBeenCalledWith('dsh inspector: Worker resource completion could not be confirmed', expect.any(Error)) })
      await expect(lifecycle.terminate()).rejects.toThrow('accountant disconnected')
      expect(release).toHaveBeenCalledTimes(2)
    } finally { warning.mockRestore(); await worker.terminate() }
  })

  it('keeps the runtime error listener and treats an already-exited Worker as stopped', async () => {
    const worker = new Worker('setImmediate(() => { throw new Error("runtime crash") })', { eval: true })
    const lifecycle = new InspectorWorkerLifecycle(worker)
    const failed = new Promise<Error>((resolve) => { lifecycle.markRunning(resolve) })

    await expect(failed).resolves.toMatchObject({ message: 'runtime crash' })
    await expect(lifecycle.stop(100)).resolves.toBeUndefined()
    expect(lifecycle.exitCode).toBeTypeOf('number')
  })

  it('reads readiness and completes graceful shutdown through one persistent owner', async () => {
    const worker = new Worker([
      "const { parentPort } = require('node:worker_threads')",
      "parentPort.postMessage({ type: 'ready', host: '127.0.0.1', port: 9230, targetId: 'test-target' })",
      "parentPort.on('message', message => { if (message.type === 'shutdown') process.exit(0) })",
    ].join('\n'), { eval: true })
    const lifecycle = new InspectorWorkerLifecycle(worker)

    await expect(lifecycle.waitForReady(1_000)).resolves.toMatchObject({
      host: '127.0.0.1',
      port: 9_230,
      targetId: 'test-target',
    })
    lifecycle.markRunning(() => { throw new Error('graceful exit reported as unexpected') })
    await expect(lifecycle.stop(1_000)).resolves.toBeUndefined()
    expect(lifecycle.exitCode).toBe(0)
  })
})
