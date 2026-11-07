/** File-preview cancellation listeners belong to the current provider read. @module */
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { ConnectionHttpHandler } from '@deepseek-ai/dsh-client-connection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { registerMediaReferences } from '../src/media-references.ts'

it.each(['GET', 'HEAD', 'filesystem-refusal', 'provider-failure'])(
  'releases the socket cancellation listener after %s settles', async (outcome) => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    let handler: ConnectionHttpHandler | undefined
    ctx.provide('connection', { http: { handlePrefix: (_path: string, read: ConnectionHttpHandler) => {
      handler = read
      return async () => {}
    } } } as never)
    const readBytes = vi.fn(async () => {
      if (outcome === 'filesystem-refusal') throw new FsError('not found', 'FS_NOT_FOUND')
      if (outcome === 'provider-failure') throw new Error('provider fault')
      return Uint8Array.of(7)
    })
    ctx.provide('fs', {
      resolve: async () => ({ targetKey: FsTargetKey('opaque-preview'), displayPath: '/preview.bin' }),
      stat: async () => ({ type: 'file', size: 1 }), readBytes,
    } as never)
    ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024 } } as never)
    await registerMediaReferences(ctx)
    if (handler === undefined) throw new Error('Media reference route was not registered')
    const socket = new EventEmitter(), unrelated = vi.fn()
    socket.on('close', unrelated)
    const request = { method: outcome === 'HEAD' ? 'HEAD' : 'GET', url: '/api/file?path=%2Fpreview.bin', socket }
    const response = { writeHead: vi.fn(), end: vi.fn() }
    const pending = handler(request as never, response as never)
    if (outcome === 'provider-failure') await expect(pending).rejects.toThrow('provider fault')
    else await pending
    expect(socket.listeners('close')).toEqual([unrelated])
    socket.emit('close')
    expect(unrelated).toHaveBeenCalledOnce()
  },
)
