/** Office conversion through the existing Session-authorized file API. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import OfficeToPdf from '@deepseek-ai/dsh-office-to-pdf'
import type { Converter } from '@deepseek-ai/libreoffice-kit'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceFilesApi } from '../src/workspace-files.ts'
import { RpcId } from '../src/api/rpc.ts'

const kit = vi.hoisted(() => ({ create: vi.fn<() => Promise<Converter>>() }))
vi.mock('@deepseek-ai/libreoffice-kit', () => ({ createConverter: kit.create }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const pdf = Buffer.from('%PDF-1.7\nconverted\n%%EOF\n')

async function harness({ mounted = true, bytes = 4 }: { mounted?: boolean; bytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-rpc-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  const render = vi.fn<Converter['render']>(async ({ outputPath }) => {
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: ['Absent Serif'] }
  })
  kit.create.mockReset().mockImplementation(async () => ({ backend: 'native', render, dispose: async () => {} }))
  if (mounted) await ctx.plugin(OfficeToPdf, { maxInputBytes: 32, maxSourceBytes: 32 })
  const id = SessionId('office-reader')
  ctx.sessions.create(id, { meta: { cwd: root } })
  const lifetime = new AbortController()
  let denied = false
  const api = createWorkspaceFilesApi(ctx, {
    maxBytes: bytes, maxLines: undefined, maxEntries: undefined,
    authorize: async () => denied
      ? { error: { code: 'collaboration-forbidden', message: 'Access revoked.', details: { action: 'read', reason: 'forbidden' } } }
      : { authority: undefined },
    validateRoot: async path => path,
    principalSignal: signal => AbortSignal.any([signal, lifetime.signal]),
  })
  const file = join(root, 'report.docx')
  await writeFile(file, Buffer.from([80, 75, 3, 4, 1, 2, 3, 4]))
  const request = (extra: { path?: string; version?: string; priority?: 'foreground' | 'background' } = {}) => ({
    rpcId: RpcId('office-rpc'), payload: { sessionId: id, path: 'report.docx', ...extra },
  })
  return { ctx, api, root, file, id, request, render, lifetime, deny: () => { denied = true } }
}

it('converts bounded versioned reads, preserves source identity, and rechecks cache access', async () => {
  const { api, ctx, request, root, render } = await harness()
  const read = vi.spyOn(ctx.fs, 'readByteRange')
  const signal = new AbortController().signal
  const converted = await api.renderOffice(request(), signal)
  expect(converted.result).toMatchObject({ ok: true, value: {
    path: 'report.docx', missingFonts: ['Absent Serif'], bytes: pdf.toString('base64'),
  } })
  expect(JSON.stringify(converted)).not.toContain(root)
  expect(read.mock.calls.every(([, range]) => range.length <= 4 && range.expectedVersion !== undefined)).toBe(true)
  expect(read.mock.calls.some(([, range]) => range.offset >= 4)).toBe(true)
  await api.renderOffice(request(), signal)
  expect(render).toHaveBeenCalledTimes(1)
  read.mockRejectedValueOnce(new FsError('private diagnostic', 'FS_PERMISSION_DENIED'))
  expect((await api.renderOffice(request(), signal)).result).toMatchObject({ ok: false, error: { code: 'collaboration-forbidden' } })
  expect(render).toHaveBeenCalledTimes(1)
})

it('converts a provider file that reports no byte size', async () => {
  const { api, ctx, request } = await harness()
  const stat = ctx.fs.stat.bind(ctx.fs)
  vi.spyOn(ctx.fs, 'stat').mockImplementation(async (...args) => {
    const info = await stat(...args)
    return info === undefined || info.type !== 'file' ? info : { type: 'file', version: info.version }
  })

  const converted = await api.renderOffice(request(), new AbortController().signal)

  expect(converted.result).toMatchObject({ ok: true, value: { path: 'report.docx', bytes: pdf.toString('base64') } })
})

it('reads a cold Session header without creating an Agent', async () => {
  const { ctx, api, id, request } = await harness({ bytes: 16 })
  const cold = SessionId('cold-office-reader')
  const header = ctx.sessions.prepare(cold, { meta: { cwd: ctx.sessions.get(id)!.header.cwd! } }).header
  ctx.provide('sessionPersistence', { readHeader: async () => header } as never)
  const input = request()
  input.payload.sessionId = cold
  expect((await api.renderOffice(input, new AbortController().signal)).result.ok).toBe(true)
  expect(ctx.sessions.get(cold)).toBeUndefined()
})

it('refuses stale, unsupported, directory, unavailable, and revoked requests before conversion', async () => {
  const { api, request, render, deny } = await harness()
  const signal = new AbortController().signal
  expect((await api.renderOffice(request({ version: 'stale' }), signal)).result)
    .toMatchObject({ ok: false, error: { code: 'workspace-file/stale-version' } })
  expect((await api.renderOffice(request({ path: '.' }), signal)).result)
    .toMatchObject({ ok: false, error: { code: 'workspace-file/not-regular-file' } })
  deny()
  expect((await api.renderOffice(request(), signal)).result)
    .toMatchObject({ ok: false, error: { code: 'collaboration-forbidden' } })
  expect(render).not.toHaveBeenCalled()
  const absent = await harness({ mounted: false })
  expect((await absent.api.renderOffice(absent.request(), signal)).result)
    .toMatchObject({ ok: false, error: { code: 'document-error', details: { reason: 'unavailable' } } })
  await writeFile(join(absent.root, 'text.txt'), 'text')
  expect((await absent.api.renderOffice(absent.request({ path: 'text.txt' }), signal)).result)
    .toMatchObject({ ok: false, error: { code: 'document-error', details: { reason: 'unsupported-format' } } })
})

it('rejects edits committed during conversion instead of returning an old PDF', async () => {
  const { api, request, render, file } = await harness()
  render.mockImplementationOnce(async ({ outputPath }) => {
    await writeFile(file, 'a changed revision')
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: [] }
  })
  expect((await api.renderOffice(request(), new AbortController().signal)).result)
    .toMatchObject({ ok: false, error: { code: 'workspace-file/stale-version' } })
})

it('cancels a conversion on principal revocation and never returns its PDF', async () => {
  const { api, request, render, lifetime } = await harness()
  render.mockImplementationOnce(async ({ outputPath }) => {
    lifetime.abort()
    await writeFile(outputPath, pdf)
    return { backend: 'native', missingFonts: [] }
  })
  const response = await api.renderOffice(request(), new AbortController().signal)
  expect(response.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  expect(JSON.stringify(response)).not.toContain(pdf.toString('base64'))
})

it('classifies engine failures without disclosing their diagnostics', async () => {
  const { api, request, render } = await harness()
  render.mockRejectedValueOnce(new Error('secret engine filesystem location'))
  const result = await api.renderOffice(request({ priority: 'foreground' }), new AbortController().signal)
  expect(result.result).toMatchObject({ ok: false, error: { code: 'document-error', details: { reason: 'failed' } } })
  expect(JSON.stringify(result)).not.toContain('secret')
})
