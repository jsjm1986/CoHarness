/** Host upload admission retains the caller's Session authorization. @module */
import { Context } from '@deepseek-ai/cordis'
import { setImmediate } from 'node:timers/promises'
import { Readable } from 'node:stream'
import { agentCarrier, type Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentError, AttachmentId, isAttachmentError, type FileAttachmentRef, type SaveFileStreamAttachment } from '@deepseek-ai/dsh-attachment'
import { CollaborationError, type CollaborationAction } from '@deepseek-ai/dsh-collaboration'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import FileUploads from '../src/index.ts'

const stored: FileAttachmentRef = { attachmentId: AttachmentId('file-owned-by-upload'), name: 'proof.txt', bytes: 1 }

async function fixture(subagent = false) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('private-upload'), subagent ? { meta: { origin: 'subagent' } } : undefined)
  const agent = { id: session.id, session, ctx } as Agent
  const registry = new Map([[agent.id, agent]])
  const save = vi.fn(async (_input: unknown) => stored)
  const unregisterRoute = vi.fn(async () => {})
  let route: Parameters<Context['connection']['http']['handlePrefix']>[1] | undefined
  let retained = 0
  const reserveUse = vi.fn(() => {
    retained++
    return { [Symbol.dispose]: () => { retained-- } }
  })
  ctx.provide('agents', { get: (id: SessionId) => registry.get(id), reserveUse } as never)
  ctx.provide('attachments', { saveFileStream: save, admitEncodedFile: save, isAttachmentError } as never)
  ctx.provide('connection', { http: { handlePrefix: (_path: string, handler: NonNullable<typeof route>) => {
    route = handler
    return unregisterRoute
  } } } as never)
  const fiber = await ctx.plugin(FileUploads)
  if (route === undefined) throw new Error('File upload route was not registered')
  const handler = route
  return { ctx, agent, session, fiber, save, registry, unregisterRoute, reserveUse,
    route: () => handler, retained: () => retained, service: ctx.fileUploads }
}

function permission(f: Awaited<ReturnType<typeof fixture>>) {
  const controller = new AbortController()
  const access = { sessionId: f.agent.id, rootSessionId: f.agent.id, mode: 'rw' as const,
    canRead: true as const, canWrite: true, canManage: false }
  const authorize = vi.fn(async (_id: SessionId, _action: CollaborationAction) => access)
  const capture = vi.fn(() => ({ authorize, signal: controller.signal }))
  const provider = { capture }
  const withdraw = f.ctx.provide('collaboration', provider as never)
  return { authorize, capture, controller, access, provider, withdraw }
}

const bytes = async function* () { yield Buffer.from('x') }

describe('Host file upload authorization', () => {
  it.each(['encoded', 'stream'] as const)('refuses %s bytes before storage when the caller cannot write the Session', async (transport) => {
    const f = await fixture()
    const authorize = vi.fn(async () => { throw new CollaborationError('forbidden') })
    f.ctx.provide('collaboration', { capture: () => ({ authorize, signal: new AbortController().signal }) } as never)
    const pending = transport === 'encoded'
      ? f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
      : f.service.uploadStream({ sessionId: f.agent.id, data: (async function* () { yield Buffer.from('x') })() })
    await expect(pending).rejects.toMatchObject({ code: 'collaboration-forbidden', details: { action: 'write', reason: 'forbidden' } })
    expect(authorize).toHaveBeenCalledExactlyOnceWith(f.agent.id, 'write')
    expect(f.save).not.toHaveBeenCalled()
  })

  it('keeps a required but withdrawn collaboration provider from accepting streamed bytes', async () => {
    const f = await fixture()
    f.ctx.provide('collaborationRequired', true)
    await expect(f.service.uploadStream({ sessionId: f.agent.id,
      data: (async function* () { yield Buffer.from('x') })(),
    })).rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } })
    expect(f.save).not.toHaveBeenCalled()
  })

  it('stages independent application uploads under their exact Session', async () => {
    const f = await fixture()
    const uploaded = await f.service.uploadStream({ sessionId: f.agent.id, data: (async function* () { yield Buffer.from('x') })() })
    expect(uploaded.file).toEqual(stored)
    expect(f.service.resolve(f.agent, uploaded.receiptId)).toEqual(stored)
  })

  it.each(['encoded', 'stream'] as const)('refuses retained %s entrypoints after service withdrawal', async (transport) => {
    const f = await fixture()
    await f.fiber.dispose()
    const pending = transport === 'encoded' ? f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
      : f.service.uploadStream({ sessionId: f.agent.id, data: bytes() })
    await expect(pending).rejects.toMatchObject({ code: 'gateway/internal', message: 'File uploads are unavailable.' })
    expect(f.save).not.toHaveBeenCalled()
    expect(f.unregisterRoute).toHaveBeenCalledOnce()
    const remove = f.ctx.commands.registerFileReceiptResolver(() => undefined)
    remove()
  })

  it('preserves an already-cancelled caller before authorization or storage', async () => {
    const f = await fixture(), p = permission(f), caller = new AbortController(), reason = new Error('upload cancelled')
    caller.abort(reason)
    await expect(f.service.upload(f.agent, { data: 'eA==' }, caller.signal)).rejects.toBe(reason)
    await expect(f.service.uploadStream({ sessionId: f.agent.id, data: bytes(), signal: caller.signal })).rejects.toBe(reason)
    expect(p.capture).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })

  it('maps capture failure before a cold Agent lookup can begin', async () => {
    const f = await fixture(), resolveAgent = vi.fn()
    f.registry.clear()
    f.ctx.provide('sessionController', { resolveAgent } as never)
    f.ctx.provide('collaboration', { capture() { throw new CollaborationError('not-member') } } as never)
    await expect(f.service.uploadStream({ sessionId: f.agent.id, data: bytes() })).rejects.toMatchObject({
      code: 'collaboration-forbidden', details: { reason: 'not-member' },
    })
    expect(resolveAgent).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })

  it.each(['withdrawn', 'replaced', 'aborted'] as const)('does not start storage when its captured authorization is %s during admission', async (change) => {
    const f = await fixture(), p = permission(f)
    const entered = Promise.withResolvers<undefined>(), held = Promise.withResolvers<typeof p.access>()
    p.authorize.mockImplementationOnce(async () => { entered.resolve(undefined); return held.promise })
    const pending = f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
    const outcome = Promise.allSettled([pending])
    try {
      await entered.promise
      expect(f.retained()).toBe(1)
      if (change === 'aborted') p.controller.abort()
      else {
        p.withdraw()
        if (change === 'replaced') f.ctx.provide('collaboration', { capture: vi.fn() } as never)
      }
      held.resolve(p.access)
      await expect(pending).rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } })
      expect(p.capture).toHaveBeenCalledOnce()
      expect(f.save).not.toHaveBeenCalled()
    } finally { held.resolve(p.access); await outcome }
  })

  it.each(['encoded', 'stream'] as const)('withholds the %s receipt when write permission is revoked during storage', async (transport) => {
    const f = await fixture(), p = permission(f)
    let revoked = false
    p.authorize.mockImplementation(async () => {
      if (revoked) throw new CollaborationError('forbidden')
      return p.access
    })
    f.save.mockImplementation(async () => { revoked = true; return stored })
    const pending = transport === 'encoded' ? f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
      : f.service.uploadStream({ sessionId: f.agent.id, data: bytes(), name: 'owned.txt' })
    await expect(pending).rejects.toMatchObject({ code: 'collaboration-forbidden', details: { reason: 'forbidden' } })
    expect(f.save).toHaveBeenCalledOnce()
    expect(p.capture).toHaveBeenCalledOnce()
  })

  it.each(['disposed', 'replaced'] as const)('does not hand a stored upload to an Agent that was %s', async (change) => {
    const f = await fixture()
    f.save.mockImplementation(async () => {
      if (change === 'disposed') f.registry.clear()
      else f.registry.set(f.agent.id, { ...f.agent })
      return stored
    })
    await expect(f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)).rejects.toMatchObject({ code: 'session/not-found' })
    expect(f.save).toHaveBeenCalledOnce()
  })

  it('checks the exact Agent again after queued authorization and before starting storage', async () => {
    const f = await fixture(), p = permission(f)
    p.authorize.mockImplementation(async () => { f.registry.clear(); return p.access })
    await expect(f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)).rejects.toMatchObject({ code: 'session/not-found' })
    expect(f.save).not.toHaveBeenCalled()
  })

  it.each(['caller', 'provider', 'service'] as const)('keeps pending storage owned while its %s cancels the upload', async (cancellation) => {
    const f = await fixture(), p = permission(f), caller = new AbortController()
    const entered = Promise.withResolvers<undefined>(), held = Promise.withResolvers<FileAttachmentRef>()
    let storageSignal: AbortSignal | undefined, disposed = false, unloading: Promise<void> | undefined
    f.save.mockImplementation(async (input) => {
      storageSignal = (input as SaveFileStreamAttachment).signal
      entered.resolve(undefined)
      return held.promise
    })
    const pending = f.service.uploadStream({ sessionId: f.agent.id, data: bytes(), signal: caller.signal })
    const outcome = Promise.allSettled([pending])
    try {
      await entered.promise
      if (cancellation === 'caller') caller.abort(new Error('caller cancelled the upload'))
      else if (cancellation === 'provider') p.controller.abort()
      else unloading = f.fiber.dispose().then(() => { disposed = true })
      await setImmediate()
      expect(storageSignal?.aborted).toBe(true)
      expect(disposed).toBe(false)
      expect(f.ctx.bail(agentCarrier(f.agent), 'agent/idle-release-check', { agent: f.agent })).toBe('busy')
      held.resolve(stored)
      await expect(pending).rejects.toMatchObject(cancellation === 'provider'
        ? { code: 'collaboration-forbidden', details: { reason: 'gateway-unavailable' } }
        : cancellation === 'service' ? { code: 'gateway/internal' } : { message: 'caller cancelled the upload' })
      await unloading
      expect(f.retained()).toBe(0)
      expect(f.ctx.bail(agentCarrier(f.agent), 'agent/idle-release-check', { agent: f.agent })).toBeUndefined()
    } finally { held.resolve(stored); await outcome; await unloading }
  })

  it('retains the original participant across delayed storage without recapturing another caller', async () => {
    const f = await fixture(), p = permission(f)
    f.save.mockImplementation(async () => {
      p.capture.mockImplementation(() => { throw new Error('a different caller must not be captured') })
      return stored
    })
    const value = await f.service.upload(f.agent, { data: 'eA==', name: 'proof.txt' }, new AbortController().signal)
    expect(value.file).toEqual(stored)
    expect(p.capture).toHaveBeenCalledOnce()
    expect(p.authorize).toHaveBeenCalledTimes(2)
  })

  it('keeps the exact Agent busy until both concurrent uploads finish', async () => {
    const f = await fixture(), first = Promise.withResolvers<FileAttachmentRef>(), second = Promise.withResolvers<FileAttachmentRef>()
    const entered = Promise.withResolvers<undefined>()
    f.save.mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => { entered.resolve(undefined); return second.promise })
    const one = f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
    const two = f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
    const outcome = Promise.allSettled([one, two])
    try {
      await entered.promise
      first.resolve(stored)
      await one
      expect(f.ctx.bail(agentCarrier(f.agent), 'agent/idle-release-check', { agent: f.agent })).toBe('busy')
      second.resolve(stored)
      await two
      expect(f.ctx.bail(agentCarrier(f.agent), 'agent/idle-release-check', { agent: f.agent })).toBeUndefined()
      expect(f.retained()).toBe(0)
    } finally { first.resolve(stored); second.resolve(stored); await outcome }
  })

  it.each(['missing-controller', 'not-found', 'busy', 'success'] as const)('preserves %s cold Session resolution', async (result) => {
    const f = await fixture()
    f.registry.clear()
    if (result !== 'missing-controller') f.ctx.provide('sessionController', { async resolveAgent() {
      if (result === 'success') { f.registry.set(f.agent.id, f.agent); return { agent: f.agent } }
      return { error: { code: result === 'not-found' ? 'session-not-found' : 'agent-busy', message: 'Session resolution refused' } }
    } } as never)
    const pending = f.service.uploadStream({ sessionId: f.agent.id, data: bytes() })
    if (result === 'success') expect((await pending).file).toEqual(stored)
    else {
      await expect(pending).rejects.toMatchObject({ code: result === 'busy' ? 'gateway/internal' : 'session/not-found' })
      expect(f.save).not.toHaveBeenCalled()
    }
  })

  it.each(['caller-cancelled', 'authority-introduced'] as const)('does not start storage when a cold lookup finishes after %s', async (change) => {
    const f = await fixture(), caller = new AbortController()
    const entered = Promise.withResolvers<undefined>(), held = Promise.withResolvers<{ agent: Agent }>()
    f.registry.clear()
    f.ctx.provide('sessionController', { async resolveAgent() { entered.resolve(undefined); return held.promise } } as never)
    const pending = f.service.uploadStream({ sessionId: f.agent.id, data: bytes(), signal: caller.signal })
    const outcome = Promise.allSettled([pending])
    try {
      await entered.promise
      if (change === 'caller-cancelled') caller.abort(new Error('cold upload cancelled'))
      else permission(f)
      f.registry.set(f.agent.id, f.agent)
      held.resolve({ agent: f.agent })
      await expect(pending).rejects.toMatchObject(change === 'caller-cancelled' ? { message: 'cold upload cancelled' }
        : { code: 'collaboration-forbidden' })
      expect(f.save).not.toHaveBeenCalled()
    } finally { held.resolve({ agent: f.agent }); await outcome }
  })

  it.each(['attachment', 'internal'] as const)('preserves %s storage failures without issuing a receipt', async (kind) => {
    const f = await fixture(), reason = kind === 'attachment'
      ? new AttachmentError('File encoding refused', 'INVALID_FILE_BASE64') : new Error('Store unavailable')
    f.save.mockRejectedValue(reason)
    await expect(f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)).rejects.toMatchObject({
      code: kind === 'attachment' ? 'session/attachment-invalid' : 'gateway/internal',
    })
  })

  it('keeps subagent Sessions outside generic file upload storage', async () => {
    const f = await fixture(true)
    await expect(f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)).rejects.toMatchObject({
      code: 'subagent/attachment-invalid', details: { reason: 'SUBAGENT_FILE_UNSUPPORTED' },
    })
    expect(f.save).not.toHaveBeenCalled()
  })

  it('binds all receipts atomically, restores their previous prompt owner and retires only committed occurrences', async () => {
    const f = await fixture()
    const first = await f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
    const second = await f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
    expect(() => f.service.bindPrompt(f.agent, [first.receiptId, 'unknown' as typeof first.receiptId], 'invalid'))
      .toThrow('File was not uploaded for this session.')
    f.service.retirePrompt(f.agent, 'invalid')
    expect(f.service.resolve(f.agent, first.receiptId)).toEqual(stored)
    const temporary = f.service.bindPrompt(f.agent, [first.receiptId], 'temporary')
    temporary[Symbol.dispose](); temporary[Symbol.dispose]()
    f.service.retirePrompt(f.agent, 'temporary')
    expect(f.service.resolve(f.agent, first.receiptId)).toEqual(stored)
    const accepted = f.service.bindPrompt(f.agent, [first.receiptId, second.receiptId], 'accepted')
    accepted.commit(); accepted[Symbol.dispose]()
    const replacement = f.service.bindPrompt(f.agent, [first.receiptId], 'replacement')
    replacement[Symbol.dispose]()
    f.service.retirePrompt(f.agent, 'replacement')
    expect(f.service.resolve(f.agent, first.receiptId)).toEqual(stored)
    f.service.retirePrompt(f.agent, 'accepted')
    expect(f.service.resolve(f.agent, first.receiptId)).toBeUndefined()
    expect(f.service.resolve(f.agent, second.receiptId)).toBeUndefined()
    f.service.retirePrompt(f.agent, 'accepted')
  })

  it('isolates staged receipts by Session and removes them when their Session is disposed', async () => {
    const f = await fixture()
    const value = await f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
    const otherSession = f.ctx.sessions.create(SessionId('other-upload'))
    const other = { ...f.agent, id: otherSession.id, session: otherSession }
    expect(f.service.resolve(other, value.receiptId)).toBeUndefined()
    expect(() => f.service.bindPrompt(other, [value.receiptId], 'foreign')).toThrow('File was not uploaded for this session.')
    f.service.retirePrompt(other, 'foreign')
    f.ctx.emit('session/disposed', f.session)
    expect(f.service.resolve(f.agent, value.receiptId)).toBeUndefined()
  })

  it('retires a committed prompt receipt only when its user message is observed', async () => {
    const f = await fixture()
    const value = await f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
    const binding = f.service.bindPrompt(f.agent, [value.receiptId], 'prompt-upload')
    binding.commit()
    f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'unrelated' }] }), { surfaceOp: 'append' })
    expect(f.service.resolve(f.agent, value.receiptId)).toEqual(stored)
    f.session.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'prompt-upload' }, content: [{ type: 'text', text: 'accepted' }] }), { surfaceOp: 'append' })
    expect(f.service.resolve(f.agent, value.receiptId)).toBeUndefined()
  })

  it('passes a same-Session staged receipt through the real command attachment admission', async () => {
    const f = await fixture()
    const value = await f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    f.ctx.commands.register({ name: 'use-file', description: 'Consume a staged file', input: { hint: 'file', attachments: true }, handler })
    await expect(f.ctx.commands.execute(f.agent, '/use-file', [{ type: 'file', receiptId: value.receiptId }], new AbortController().signal))
      .resolves.toMatchObject({ result: { kind: 'success' } })
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ attachments: [{ type: 'file', attachment: stored }] }))
  })

  it('runs the registered Node byte route and consumes its stream under owned cancellation', async () => {
    const f = await fixture(), message = Readable.from([Buffer.from('x')])
    Object.assign(message, { method: 'POST', url: `/api/session/uploadFileBinary?sessionId=${f.agent.id}`, headers: { 'content-type': 'application/octet-stream' } })
    const writeHead = vi.fn(), end = vi.fn()
    f.save.mockImplementation(async (input) => {
      const chunks: Buffer[] = []
      for await (const chunk of (input as SaveFileStreamAttachment).data) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks).toString()).toBe('x')
      return stored
    })
    try {
      await f.route()(message as never, { writeHead, end } as never)
      expect(writeHead).toHaveBeenCalledWith(200, expect.anything())
      expect(JSON.parse(end.mock.calls[0]![0] as string)).toMatchObject({ ok: true, value: { file: stored } })
    } finally { message.destroy() }
  })

  it('ignores a non-string receipt identity in additional persisted source metadata', async () => {
    const f = await fixture()
    const value = await f.service.upload(f.agent, { data: 'eA==' }, new AbortController().signal)
    f.session.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: null }, content: [{ type: 'text', text: 'external metadata' }] }), { surfaceOp: 'append' })
    expect(f.service.resolve(f.agent, value.receiptId)).toEqual(stored)
  })
})
