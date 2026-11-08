/** The fallback's background-encoding failure reporting goes to the plugin logger. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerResponse, type IncomingMessage } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-host-webserver', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-host-webserver')>()
  return {
    ...original,
    precompressBody: (_identity: () => Promise<Buffer>, onError: (error: unknown) => void) => {
      onError(new Error('brotli blew up'))
      onError('opaque encoding rejection')
      return { identity: () => Promise.resolve(Buffer.alloc(0)), variant: () => undefined }
    },
  }
})

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('reports failed background encodings through the plugin logger', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-frontend-encoding-'))
  const dist = join(root, 'dist')
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'assets', 'app-12345678.js'), 'export {}')
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')

  let fallback: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const warnings: unknown[] = []
  const ctx = new Context()
  ctx.provide('webServer', {
    registerFallback: (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => { fallback = handler },
    renderIndex: (body: string) => body,
  } as never)
  ctx.provide('connection', { authorizeIndex: () => true } as never)
  vi.spyOn(ctx.logger, 'warn').mockImplementation((entry: unknown) => { warnings.push(entry); return undefined })
  apply(ctx, { distIndex })
  if (fallback === undefined) throw new Error('frontend-static did not claim the fallback seat')

  const req = { method: 'GET', url: '/assets/app-12345678.js', headers: { 'accept-encoding': 'br' } } as IncomingMessage
  const res = new ServerResponse(req)
  vi.spyOn(res, 'writeHead').mockImplementation(() => res)
  vi.spyOn(res, 'end').mockImplementation(() => res)
  await fallback(req, res)

  expect(warnings).toHaveLength(2)
  expect(warnings[0]).toBeInstanceOf(Error)
  expect((warnings[0] as Error).message).toBe('brotli blew up')
  expect(warnings[1]).toBeInstanceOf(Error)
  expect((warnings[1] as Error).message).toBe('opaque encoding rejection')
})
