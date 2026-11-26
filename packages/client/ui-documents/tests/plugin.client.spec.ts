// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { UserDocRef } from '@deepseek-ai/dsh-userdoc'
import { DocumentsButton } from '../src/client/DocumentsButton.tsx'
import type { DocumentsButtonInjected } from '../src/client/DocumentsButton.tsx'
import { DocumentsOverlay } from '../src/client/DocumentsOverlay.tsx'
import { apply, inject } from '../src/client/index.ts'

const preloadDocumentsModal = vi.hoisted(() => vi.fn())
vi.mock('../src/client/DeferredDocumentsModal.tsx', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/DeferredDocumentsModal.tsx')>(),
  preloadDocumentsModal,
}))

describe('ui-documents apply', () => {
  it('declares only the services it reads', () => {
    expect(inject).toEqual(['slots', 'locale', 'sessions', 'conversation', 'connection', 'deploymentContext'])
  })

  it('registers the picker and owns background preparation after the first editable paint', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    onTestFinished(() => { preloadDocumentsModal.mockClear() })
    const firstEditableComposer = createSnapshotStore(false)
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: vi.fn(() => () => {}) })
    const attachDocument = vi.fn(() => true)
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ current: 'session-1' }), subscribe: () => () => {} },
    })
    ctx.provide('conversation', { firstEditableComposer, attachDocument })
    ctx.provide('connection', {} as never)
    ctx.provide('deploymentContext', { getSnapshot: () => ({ phase: 'ready', showComputer: false, aggregateComputers: false }), subscribe: () => () => {} } as never)
    ctx.slots.register({
      name: 'root',
      children: {
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(preloadDocumentsModal).not.toHaveBeenCalled()
    firstEditableComposer.set(true)
    expect(preloadDocumentsModal).toHaveBeenCalledOnce()

    const entries = ctx.slots.entries('sidebar.footer.action')
    const docEntry = entries.find(entry => entry.component === DocumentsButton)!
    expect(docEntry).toBeDefined()
    expect(docEntry.options).toMatchObject({ id: 'documents', order: -10 })
    expect(docEntry.inject).toBeDefined()
    const overlays = ctx.slots.entries('shell.overlay')
    expect(overlays).toHaveLength(1)
    expect(overlays[0]?.component).toBe(DocumentsOverlay)
    expect(overlays[0]?.options).toMatchObject({ id: 'documents.picker' })
    const ref = {
      docId: 'folder/report.pdf', path: '/documents/folder/report.pdf', name: 'report.pdf',
      bytes: 10, mediaType: 'application/pdf', modifiedAt: 1,
    } as UserDocRef
    const injected = overlays[0]!.inject!() as unknown as DocumentsButtonInjected
    expect(injected.attachDocument?.(ref)).toBe(true)
    expect(attachDocument).toHaveBeenCalledWith('session-1', ref)
    expect(injected.attachDocument?.(ref, 'session-2' as SessionId)).toBe(true)
    expect(attachDocument).toHaveBeenLastCalledWith('session-2', ref)
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
  })
})
