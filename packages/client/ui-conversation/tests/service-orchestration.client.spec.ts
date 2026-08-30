// @vitest-environment jsdom
// ConversationController scope addressing over the runtime's real scope tag:
// TestSessions mints tagged scopes through the production createScope, so the
// service's scopeOf/binding path runs against production resolution (no local
// tag probe).
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { QueuedMessage, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { UserDocRef } from '@deepseek-ai/dsh-userdoc'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { ConversationController, UnsupportedImageMediaTypeError } from '../src/client/service.ts'
import { zh } from '../src/client/locales.ts'

type BeginSubmission = NonNullable<SessionFace['beginSubmission']>

function programmableSubmissionBegin(): {
  beginSubmission: BeginSubmission
  inputs: Parameters<BeginSubmission>[0][]
} {
  const inputs: Parameters<BeginSubmission>[0][] = []
  return {
    inputs,
    beginSubmission: (input) => {
      inputs.push(input)
      return {
        requestId: `submission-${inputs.length}` as never,
        abandon: () => { input.onRetire?.({ reason: 'failed' }) },
      }
    },
  }
}

async function bench(
  readAttachment?: SessionFace['readAttachment'],
  beginSubmission?: BeginSubmission,
) {
  const runtime = await SlotTestRuntime.create()
  const prompt = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const updateQueue = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  const loadOlder = vi.fn(() => Promise.resolve())
  await runtime.sessions.add({
    id: 's1',
    session: {
      prompt,
      updateQueue,
      cancel,
      loadOlder,
      ...(readAttachment === undefined ? {} : { readAttachment }),
      ...(beginSubmission === undefined ? {} : { beginSubmission }),
    },
  })
  // config.input is required (the apply shares its hub with the inject
  // factories); the bench passes its own instance explicitly.
  const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}))
  const fiber = runtime.ctx.plugin(ConversationController, {
    input: hub,
    blocks: new ComposerBlockRegistry(),
  })
  await fiber.await()
  const root = runtime.ctx.get('conversation') as ConversationController
  const scoped = runtime.sessions.scope('s1')!.get('conversation') as ConversationController
  const shell = hub.shellFor(runtime.sessions.binding('s1')!)
  return {
    runtime, fiber, root, scoped, hub, shell, prompt, updateQueue, cancel, loadOlder,
    session: runtime.sessions.binding('s1')!.session,
  }
}

describe('ConversationController', () => {
  it('routes operations through the public Session binding', async () => {
    const b = await bench()
    await b.scoped.send('hello')
    await b.scoped.updateQueue('item-1' as never, { kind: 'remove' })
    await b.scoped.cancel()
    await b.scoped.loadOlder()
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue')
    expect(b.updateQueue).toHaveBeenCalledWith('item-1', { kind: 'remove' })
    expect(b.cancel).toHaveBeenCalledOnce()
    expect(b.loadOlder).toHaveBeenCalledOnce()
    await b.runtime.dispose()
  })

  it('folds Session business failures into callback rejections', async () => {
    const b = await bench()
    b.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'agent-busy', message: 'busy', details: {} } } as never)
    await expect(b.scoped.send('x')).rejects.toThrow('conversation.send failed: agent-busy: busy')
    b.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'nope', details: {} } } as never)
    await expect(b.scoped.cancel()).rejects.toThrow('conversation.cancel failed: internal: nope')
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'internal', message: 'broken', details: {} },
    } as never)
    await expect(b.scoped.updateQueue('item-1' as never, { kind: 'steer' }))
      .rejects.toThrow('conversation.updateQueue failed: internal: broken')
    await b.runtime.dispose()
  })

  it('treats strict-steer races as converged Queue delivery', async () => {
    const b = await bench()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'steer-unavailable', message: 'closed', details: {} },
    } as never)
    await expect(b.scoped.updateQueue('item-1' as never, { kind: 'steer' })).resolves.toBeUndefined()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'queue-item-not-found', message: 'claimed', details: {} },
    } as never)
    await expect(b.scoped.updateQueue('item-2' as never, { kind: 'steer' })).resolves.toBeUndefined()
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'queue-item-not-found', message: 'claimed', details: {} },
    } as never)
    await expect(b.scoped.updateQueue('item-3' as never, { kind: 'remove' }))
      .rejects.toThrow('conversation.updateQueue failed: queue-item-not-found: claimed')
    await b.runtime.dispose()
  })

  it('releases draft previews when their session scope is disposed', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:draft-1')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDraftImages([
        new File([new Uint8Array(4)], 'a.png', { type: 'image/png' }),
      ])
      if (attachment === undefined) throw new Error('draft attachment missing')
      b.root.input.for(b.runtime.sessions.scope('s1')!).addImages([attachment.id])
      await b.runtime.sessions.remove('s1')
      expect(b.root.draftImages([attachment.id])).toEqual([])
      expect(revoked).toHaveBeenCalledWith('blob:draft-1')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('attaches an existing document by reference and never deletes it when removed', async () => {
    const b = await bench()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const ref = {
      docId: '2026-08-17/report.pdf',
      path: '/documents/2026-08-17/report.pdf',
      name: 'report.pdf',
      bytes: 2048,
      mediaType: 'application/pdf',
      modifiedAt: Date.UTC(2026, 7, 17),
    } as UserDocRef

    expect(b.root.attachDocument('s1' as never, ref)).toBe(true)
    const [draft] = b.root.documentStore('s1' as never).getSnapshot()
    expect(draft).toMatchObject({
      docId: ref.docId,
      name: ref.name,
      status: 'ready',
      progress: 1,
    })
    if (draft === undefined) throw new Error('attached document draft missing')
    expect(b.root.attachDocument('s1' as never, ref)).toBe(true)
    expect(b.root.documentStore('s1' as never).getSnapshot()).toHaveLength(1)
    expect(b.shell.state.getSnapshot().documentIds).toEqual([draft.id])
    b.root.removeDraftDocument('s1' as never, draft.id)
    b.shell.removeDocument(draft.id)
    expect(b.root.documentStore('s1' as never).getSnapshot()).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    await b.runtime.dispose()
  })

  it('validates every MIME type before allocating previews', async () => {
    const b = await bench()
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    expect(() => b.root.createDraftImages([
      new File([Uint8Array.of(1)], 'valid.png', { type: 'image/png' }),
      new File([Uint8Array.of(2)], 'invalid.svg', { type: 'image/svg+xml' }),
    ])).toThrow(UnsupportedImageMediaTypeError)
    expect(created).not.toHaveBeenCalled()
    created.mockRestore()
    await b.runtime.dispose()
  })

  it('invalidates pending historical image loads when the rendered session is released', async () => {
    const read = Promise.withResolvers<Awaited<ReturnType<SessionFace['readAttachment']>>>()
    const b = await bench(() => read.promise)
    const sessionId = b.runtime.sessions.behavior('s1').sessionId
    const attachment = {
      attachmentId: AttachmentId('image-1'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } as const
    const pending = b.root.resolveImage(sessionId, attachment)
    b.root.releaseSessionImages(sessionId)
    read.resolve({ ok: true, value: { attachment, data: Uint8Array.of(1) } })
    await expect(pending).rejects.toThrow('historical image scope was released')
    await b.runtime.dispose()
  })

  it('registers a local echo before slow image encoding and forwards its requestId', async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('requestAnimationFrame', frame)
    const encoded = Promise.withResolvers<ArrayBuffer>()
    const arrayBuffer = vi.fn(() => encoded.promise)
    const file = new File([Uint8Array.of(1, 2)], 'slow.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: arrayBuffer })
    const programmable = programmableSubmissionBegin()
    const b = await bench(undefined, programmable.beginSubmission)
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:slow')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDraftImages([file])
      if (attachment === undefined) throw new Error('draft attachment missing')
      const sending = b.root.sendSession(b.session, '慢速图片', [attachment.id], [], 'queue')
      await vi.waitFor(() => { expect(programmable.inputs).toHaveLength(1) })
      expect(programmable.inputs[0]?.onRetire).toEqual(expect.any(Function))
      expect(programmable.inputs[0]?.images).toEqual([{ previewUrl: 'blob:slow', name: 'slow.png' }])
      expect(programmable.inputs[0]?.text).toBe('慢速图片')
      expect(programmable.inputs[0]?.onRetire).toBeTruthy()
      expect(arrayBuffer).toHaveBeenCalledOnce()
      expect(b.prompt).not.toHaveBeenCalled()

      encoded.resolve(Uint8Array.of(1, 2).buffer)
      await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
      expect(b.prompt).toHaveBeenCalledWith(
        [{ type: 'image', mediaType: 'image/png', data: 'AQI=', name: 'slow.png' }, { type: 'text', text: '慢速图片' }],
        'queue',
        undefined,
        'submission-1',
      )
      programmable.inputs[0]!.onRetire?.({ reason: 'observed', attachments: [] })
      await expect(sending).resolves.toEqual({ kind: 'success' })
      expect(revoked).toHaveBeenCalledWith('blob:slow')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
      vi.unstubAllGlobals()
    }
    await b.runtime.dispose()
  })

  it('abandons a submission on serialization failure and keeps its draft for retry', async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('requestAnimationFrame', frame)
    const programmable = programmableSubmissionBegin()
    const b = await bench(undefined, programmable.beginSubmission)
    const file = new File([Uint8Array.of(1)], 'broken.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: () => Promise.reject(new Error('image codec unavailable')),
    })
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:broken')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDraftImages([file])
      if (attachment === undefined) throw new Error('draft attachment missing')
      await expect(b.root.sendSession(b.session, '', [attachment.id], [], 'queue'))
        .rejects.toThrow('image codec unavailable')
      expect(programmable.inputs).toHaveLength(1)
      expect(b.root.draftImages([attachment.id])).toHaveLength(1)
      expect(revoked).not.toHaveBeenCalledWith('blob:broken')
      expect(b.prompt).not.toHaveBeenCalled()
    } finally {
      created.mockRestore()
      revoked.mockRestore()
      vi.unstubAllGlobals()
    }
    await b.runtime.dispose()
  })

  it('keeps image drafts on prompt rejection and does not release unrelated submissions', async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('requestAnimationFrame', frame)
    const programmable = programmableSubmissionBegin()
    const b = await bench(undefined, programmable.beginSubmission)
    const files = [
      new File([Uint8Array.of(1)], 'first.png', { type: 'image/png' }),
      new File([Uint8Array.of(2)], 'second.png', { type: 'image/png' }),
    ]
    const created = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [first, second] = b.root.createDraftImages(files)
      if (first === undefined || second === undefined) throw new Error('draft attachments missing')
      b.prompt.mockImplementationOnce(async () => {
        programmable.inputs[0]?.onRetire?.({ reason: 'failed' })
        return { ok: false, error: { code: 'agent-busy', message: 'busy', details: {} } } as never
      })
      const rejected = await b.root.sendSession(b.session, '失败', [first.id], [], 'queue')
      expect(rejected).toEqual({ kind: 'error' })
      expect(b.root.draftImages([first.id])).toHaveLength(1)
      expect(b.root.draftImages([second.id])).toHaveLength(1)
      expect(revoked).not.toHaveBeenCalledWith('blob:first')

      b.prompt.mockResolvedValueOnce({ ok: true, value: { accepted: true } } as never)
      const secondSend = b.root.sendSession(b.session, '', [second.id], [], 'queue')
      await vi.waitFor(() => { expect(programmable.inputs).toHaveLength(2) })
      programmable.inputs[1]!.onRetire?.({ reason: 'observed', attachments: [] })
      await expect(secondSend).resolves.toEqual({ kind: 'success' })
      expect(b.root.draftImages([first.id])).toHaveLength(1)
      expect(b.root.draftImages([second.id])).toEqual([])
    } finally {
      created.mockRestore()
      revoked.mockRestore()
      vi.unstubAllGlobals()
    }
    await b.runtime.dispose()
  })

  it('does not add empty text blocks for image-only or document-only submissions', async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('requestAnimationFrame', frame)
    const programmable = programmableSubmissionBegin()
    const b = await bench(undefined, programmable.beginSubmission)
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:only-image')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [attachment] = b.root.createDraftImages([
        new File([Uint8Array.of(7)], 'only.png', { type: 'image/png' }),
      ])
      if (attachment === undefined) throw new Error('image draft missing')
      const imageSend = b.root.sendSession(b.session, '', [attachment.id], [], 'queue')
      await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
      expect(b.prompt).toHaveBeenCalledWith(
        [{ type: 'image', mediaType: 'image/png', data: 'Bw==', name: 'only.png' }],
        'queue',
        undefined,
        'submission-1',
      )
      programmable.inputs[0]!.onRetire?.({ reason: 'observed', attachments: [] })
      await expect(imageSend).resolves.toEqual({ kind: 'success' })

      const ref = {
        docId: '2026-08-30/only.pdf',
        path: '/documents/2026-08-30/only.pdf',
        name: 'only.pdf',
        bytes: 3,
        mediaType: 'application/pdf',
        modifiedAt: Date.UTC(2026, 7, 30),
      } as UserDocRef
      expect(b.root.attachDocument('s1' as never, ref)).toBe(true)
      const [document] = b.root.documentStore('s1' as never).getSnapshot()
      if (document === undefined) throw new Error('document draft missing')
      b.prompt.mockResolvedValueOnce({ ok: true, value: { accepted: true } } as never)
      await expect(b.root.sendSession(b.session, '', [], [document.id], 'queue'))
        .resolves.toEqual({ kind: 'success' })
      expect(b.prompt).toHaveBeenLastCalledWith(
        [{ type: 'document', docId: ref.docId }],
        'queue',
        undefined,
        'submission-2',
      )
      expect(b.root.documentStore('s1' as never).getSnapshot()).toEqual([])
    } finally {
      created.mockRestore()
      revoked.mockRestore()
      vi.unstubAllGlobals()
    }
    await b.runtime.dispose()
  })

  it('replaces a submitted preview with its durable image URL and isolates concurrent submissions', async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('requestAnimationFrame', frame)
    const reads = new Map<string, ReturnType<typeof Promise.withResolvers<Awaited<ReturnType<SessionFace['readAttachment']>>>>>()
    const readAttachment: SessionFace['readAttachment'] = async (attachmentId) => {
      const existing = reads.get(String(attachmentId))
      if (existing !== undefined) return existing.promise
      const gate = Promise.withResolvers<Awaited<ReturnType<SessionFace['readAttachment']>>>()
      reads.set(String(attachmentId), gate)
      return gate.promise
    }
    const programmable = programmableSubmissionBegin()
    const b = await bench(readAttachment, programmable.beginSubmission)
    const created = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first-preview')
      .mockReturnValueOnce('blob:second-preview')
      .mockReturnValueOnce('blob:first-durable')
      .mockReturnValueOnce('blob:second-durable')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [first, second] = b.root.createDraftImages([
        new File([Uint8Array.of(1)], 'first.png', { type: 'image/png' }),
        new File([Uint8Array.of(2)], 'second.png', { type: 'image/png' }),
      ])
      if (first === undefined || second === undefined) throw new Error('draft attachments missing')
      const firstRef = {
        attachmentId: AttachmentId('first-durable'), mediaType: 'image/png' as const,
        bytes: 1, width: 1, height: 1, name: 'first.png',
      }
      const secondRef = {
        attachmentId: AttachmentId('second-durable'), mediaType: 'image/png' as const,
        bytes: 1, width: 1, height: 1, name: 'second.png',
      }
      const firstSend = b.root.sendSession(b.session, 'first', [first.id], [], 'queue')
      const secondSend = b.root.sendSession(b.session, 'second', [second.id], [], 'queue')
      await vi.waitFor(() => { expect(programmable.inputs).toHaveLength(2) })
      programmable.inputs[1]!.onRetire?.({ reason: 'observed', attachments: [secondRef] })
      programmable.inputs[0]!.onRetire?.({ reason: 'observed', attachments: [firstRef] })
      await expect(Promise.all([firstSend, secondSend])).resolves.toEqual([
        { kind: 'success' }, { kind: 'success' },
      ])
      expect(b.root.peekImage('s1' as never, firstRef)).toBe('blob:first-preview')
      expect(b.root.peekImage('s1' as never, secondRef)).toBe('blob:second-preview')
      expect(b.root.draftImages([first.id])).toEqual([])
      expect(b.root.draftImages([second.id])).toEqual([])

      reads.get(String(firstRef.attachmentId))!.resolve({
        ok: true,
        value: { attachment: firstRef, data: Uint8Array.of(1) },
      })
      reads.get(String(secondRef.attachmentId))!.resolve({
        ok: true,
        value: { attachment: secondRef, data: Uint8Array.of(2) },
      })
      await expect(b.root.resolveImage('s1' as never, firstRef)).resolves.toBe('blob:first-durable')
      await expect(b.root.resolveImage('s1' as never, secondRef)).resolves.toBe('blob:second-durable')
      expect(b.root.peekImage('s1' as never, firstRef)).toBe('blob:first-durable')
      expect(b.root.peekImage('s1' as never, secondRef)).toBe('blob:second-durable')
      expect(revoked).toHaveBeenCalledWith('blob:first-preview')
      expect(revoked).toHaveBeenCalledWith('blob:second-preview')
    } finally {
      created.mockRestore()
      revoked.mockRestore()
      vi.unstubAllGlobals()
    }
    await b.runtime.dispose()
  })

  it('cleans a failed durable image load and permits a later retry', async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('requestAnimationFrame', frame)
    let readCount = 0
    const ref = {
      attachmentId: AttachmentId('retry-image'), mediaType: 'image/png' as const,
      bytes: 1, width: 1, height: 1, name: 'retry.png',
    }
    const readAttachment: SessionFace['readAttachment'] = async () => {
      readCount += 1
      return readCount === 1
        ? { ok: false, error: { code: 'internal', message: 'image unavailable', details: {} } }
        : { ok: true, value: { attachment: ref, data: Uint8Array.of(9) } }
    }
    const programmable = programmableSubmissionBegin()
    const b = await bench(readAttachment, programmable.beginSubmission)
    const created = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:retry-preview')
      .mockReturnValueOnce('blob:retry-durable')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    try {
      const [draft] = b.root.createDraftImages([
        new File([Uint8Array.of(9)], 'retry.png', { type: 'image/png' }),
      ])
      if (draft === undefined) throw new Error('draft attachment missing')
      const sending = b.root.sendSession(b.session, '', [draft.id], [], 'queue')
      await vi.waitFor(() => { expect(programmable.inputs).toHaveLength(1) })
      programmable.inputs[0]!.onRetire?.({ reason: 'observed', attachments: [ref] })
      // Capture the seeded promise before its failed microtask removes the
      // cache entry; a later resolveImage call is intentionally a retry.
      const failedLoad = b.root.resolveImage('s1' as never, ref)
      await expect(sending).resolves.toEqual({ kind: 'success' })
      await expect(failedLoad).rejects.toThrow('image unavailable')
      expect(b.root.peekImage('s1' as never, ref)).toBeUndefined()
      expect(revoked).toHaveBeenCalledWith('blob:retry-preview')

      await expect(b.root.resolveImage('s1' as never, ref)).resolves.toBe('blob:retry-durable')
      expect(readCount).toBe(2)
      // A standalone historical load has no submission preview to expose via
      // peekImage; callers use its resolved promise for the canonical URL.
      expect(b.root.peekImage('s1' as never, ref)).toBeUndefined()
    } finally {
      created.mockRestore()
      revoked.mockRestore()
      vi.unstubAllGlobals()
    }
    await b.runtime.dispose()
  })

  it('revokes a seeded preview immediately when the session image scope is released', async () => {
    const read = Promise.withResolvers<Awaited<ReturnType<SessionFace['readAttachment']>>>()
    const b = await bench(() => read.promise)
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    const ref = {
      attachmentId: AttachmentId('released-preview'), mediaType: 'image/png' as const,
      bytes: 1, width: 1, height: 1,
    }
    try {
      expect(b.root.seedImageUrl('s1' as never, ref, 'blob:released-preview')).toBe(true)
      const pending = b.root.resolveImage('s1' as never, ref)
      b.root.releaseSessionImages('s1' as never)
      expect(revoked).toHaveBeenCalledWith('blob:released-preview')
      read.resolve({ ok: true, value: { attachment: ref, data: Uint8Array.of(1) } })
      await expect(pending).rejects.toThrow('historical image scope was released')
    } finally {
      revoked.mockRestore()
    }
    await b.runtime.dispose()
  })

  it('fails loudly from the root scope, on an unbound session, or without SessionRuntime', async () => {
    const b = await bench()
    await expect(b.root.send('x')).rejects.toThrow(/requires a session scope/)
    await b.runtime.sessions.remove('s1')
    await expect(b.scoped.send('x')).rejects.toThrow(/resolved no binding/)
    await b.runtime.dispose()
    // No SessionRuntime at all: a bare context (the runtime always provides one).
    const bare = new Context()
    await bare.plugin(ConversationController, {
      input: new InputHub(bare, makeTranslate(zh, {})),
      blocks: new ComposerBlockRegistry(),
    }).await()
    const orphan = bare.get('conversation') as ConversationController
    await expect(orphan.send('x')).rejects.toThrow(/sessions service unavailable/)
  })
})

describe('InputHub queue steering (empty-draft accelerated Enter)', () => {
  const row = (id: string): QueuedMessage => ({
    id: id as never,
    messageId: `message-${id}` as never,
    placement: 'queued',
    content: [{ type: 'text', text: id }],
    preview: id,
    text: id,
  })

  it('steers every queued row in FIFO order and leaves steering rows alone', async () => {
    const b = await bench()
    await b.runtime.sessions.updateSnapshot('s1', (draft) => {
      draft.queue = [row('q-1'), { ...row('q-2'), placement: 'steering' }, row('q-3')]
    })
    b.shell.steerQueue()
    await vi.waitFor(() => {
      expect(b.updateQueue).toHaveBeenCalledTimes(2)
    })
    expect(b.updateQueue).toHaveBeenNthCalledWith(1, 'q-1', { kind: 'steer' })
    expect(b.updateQueue).toHaveBeenNthCalledWith(2, 'q-3', { kind: 'steer' })
    expect(b.shell.notices.getSnapshot()).toBeNull()
    await b.runtime.dispose()
  })

  it('converges silently when the turn closes or a row is claimed mid-steer', async () => {
    const b = await bench()
    await b.runtime.sessions.updateSnapshot('s1', (draft) => {
      draft.queue = [row('q-1'), row('q-2')]
    })
    // The turn closes before the second row: the flush stops, silently.
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'steer-unavailable', message: 'closed', details: {} },
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => { expect(b.updateQueue).toHaveBeenCalledTimes(1) })
    expect(b.shell.notices.getSnapshot()).toBeNull()

    // A row the host already claimed (e.g. a repeated empty-draft chord):
    // the duplicate strict steer is a silent no-op.
    await b.runtime.sessions.updateSnapshot('s1', (draft) => {
      draft.queue = [row('q-3')]
    })
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'queue-item-not-found', message: 'claimed', details: {} },
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => { expect(b.updateQueue).toHaveBeenCalledTimes(2) })
    expect(b.shell.notices.getSnapshot()).toBeNull()
    await b.runtime.dispose()
  })

  it('surfaces one notice on a genuine steer failure and stops', async () => {
    const b = await bench()
    await b.runtime.sessions.updateSnapshot('s1', (draft) => {
      draft.queue = [row('q-1'), row('q-2')]
    })
    b.updateQueue.mockResolvedValueOnce({
      ok: false, error: { code: 'internal', message: 'broken', details: {} },
    } as never)
    b.shell.steerQueue()
    await vi.waitFor(() => {
      expect(b.shell.notices.getSnapshot()).toEqual(
        expect.objectContaining({ level: 'error', text: '插话发送失败，请重试。' }),
      )
    })
    expect(b.updateQueue).toHaveBeenCalledTimes(1)
    await b.runtime.dispose()
  })

  it('no-ops without queued rows', async () => {
    const b = await bench()
    b.shell.steerQueue()
    expect(b.updateQueue).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })
})
