/** Helper shutdown joins completed-process resources before relinquishing ownership. */
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, vi } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { authenticateStream } from '../src/stream-security.ts'
import { createHelperHarness } from './fixtures/helper.ts'
import { z } from 'zod'
import { preparedSchema } from '../src/schemas.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

describe.skipIf(process.platform === 'win32')('SSH completed-process cleanup ownership', () => {
  it.each((['success', 'failure'] as const).flatMap(kind => [false, true].map(retry => ({ kind, retry }))))(
    'joins finalization after native $kind while retaining the result with cleanup retry=$retry', async ({ kind, retry }) => {
      const root = await mkdtemp('/tmp/dsh-ssh-final-')
      const ctx = new Context()
      const filesystem = await ctx.plugin(LocalFileSystem, { cwd: root })
      const subprocess = await ctx.plugin(LocalSubprocessRuntime)
      const owner = new RemoteProcesses(ctx, root, 1, 5000)
      const sockets: Socket[] = []
      const removing = Promise.withResolvers<undefined>()
      const releaseRemoval = Promise.withResolvers<undefined>()
      const removed = Promise.withResolvers<undefined>()
      let removalStarted = false
      let removals = 0
      const failure = new Error('Remote finalization removal temporarily unavailable')
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      try {
        const prepared = await owner.prepare({
          argv: kind === 'success' ? [process.execPath, '-e', 'process.exit(0)'] : [join(root, 'missing-executable')],
          cwd: root, graceMs: 50, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        })
        const directory = join(root, prepared.id)
        vi.mocked(rm).mockImplementation(async (path, options) => {
          if (path !== directory) return actual.rm(path, options)
          removalStarted = true
          removing.resolve(undefined)
          await releaseRemoval.promise
          try {
            if (retry && removals++ === 0) throw failure
            await actual.rm(path, options)
          }
          finally { removed.resolve(undefined) }
        })
        for (const endpoint of Object.values(prepared.streams)) {
          const raw = createConnection({ path: endpoint.path, allowHalfOpen: true })
          raw.on('error', () => {})
          sockets.push(raw)
          await once(raw, 'connect')
          const socket = await authenticateStream(raw, endpoint.capability, 5000)
          socket.on('error', () => {})
          sockets.push(socket)
          socket.end(); socket.resume()
        }
        await owner.start(prepared.id)
        const outcome = await owner.done(prepared.id).then(
          value => ({ value }), (error: unknown) => ({ error }),
        )
        if (kind === 'failure') expect(outcome).toMatchObject({ error: { code: 'ENOENT' } })
        else expect(outcome).toMatchObject({ value: { outcome: { exitCode: 0 } } })
        await removing.promise
        let closed = false
        const close = owner.close().then(() => { closed = true })
        let secondClosed = false
        const second = owner.close().then(() => { secondClosed = true })
        await new Promise(resolve => setImmediate(resolve))
        expect(closed).toBe(false)
        expect(secondClosed).toBe(false)
        releaseRemoval.resolve(undefined)
        const results = await Promise.allSettled([close, second])
        if (retry) {
          for (const result of results) {
            expect(result.status).toBe('rejected')
            if (result.status === 'rejected') {
              const reason: unknown = result.reason
              expect(reason).toMatchObject({ errors: [failure] })
            }
          }
          expect(await readdir(root)).toEqual([prepared.id])
          await owner.close()
        } else expect(results.every(result => result.status === 'fulfilled')).toBe(true)
        expect(await readdir(root)).toEqual([])
        const late = await owner.done(prepared.id).then(
          value => ({ value }), (error: unknown) => ({ error }),
        )
        expect(late).toEqual(outcome)
        if ('error' in outcome) expect('error' in late && late.error).toBe(outcome.error)
      } finally {
        releaseRemoval.resolve(undefined)
        for (const socket of sockets) socket.destroy()
        await owner.close()
        if (removalStarted) await removed.promise
        await subprocess.dispose()
        await filesystem.dispose()
        vi.mocked(rm).mockImplementation(actual.rm)
        await rm(root, { recursive: true, force: true })
      }
    })

  it('retries a failed reservation cleanup instead of acknowledging retained resources as closed', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-final-retry-')
    const ctx = new Context()
    const owner = new RemoteProcesses(ctx, root, 1, 5000)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const failure = new Error('Remote directory removal temporarily unavailable')
    try {
      const prepared = await owner.prepare({ argv: [process.execPath], cwd: root, graceMs: 50,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
      const directory = join(root, prepared.id)
      vi.mocked(rm).mockImplementationOnce(async (path, options) => {
        if (path === directory) throw failure
        await actual.rm(path, options)
      })
      await expect(owner.close()).rejects.toMatchObject({ errors: [failure] })
      expect(await readdir(root)).toEqual([prepared.id])
      await owner.close()
      expect(await readdir(root)).toEqual([])
      await expect(owner.prepare({ argv: [process.execPath], cwd: root, graceMs: 50,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })).rejects.toThrow('capacity unavailable')
    } finally {
      vi.mocked(rm).mockImplementation(actual.rm)
      await owner.close()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains helper dependencies and private evidence until an acknowledged close retry completes', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const test = await createHelperHarness()
    const failure = new Error('Remote reservation removal temporarily unavailable')
    try {
      const prepared = await test.client.request('process.prepare', {
        argv: [process.execPath], cwd: test.root, graceMs: 50,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      }, preparedSchema)
      const directory = join(test.facts!.root, prepared.id)
      vi.mocked(rm).mockImplementationOnce(async (path, options) => {
        if (path === directory) throw failure
        await actual.rm(path, options)
      })
      await expect(test.client.request('close', {}, z.null())).rejects.toThrow('SSH remote process cleanup failed')
      expect(await readdir(test.facts!.root)).toEqual([prepared.id])
      await expect(test.client.request('heartbeat', {}, z.null())).rejects.toThrow('not accepting')
      expect(await test.client.request('close', {}, z.null())).toBeNull()
      expect(await test.client.request('close', {}, z.null())).toBeNull()
      await expect(readdir(test.facts!.root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.mocked(rm).mockImplementation(actual.rm)
      await test.client.request('close', {}, z.null()).catch(() => {})
      await test.close()
    }
  })
})
