// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { UserDocRef, UserDocScope } from '@deepseek-ai/dsh-userdoc'
import type { ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { zh, type DocumentsKey } from '../src/client/locales.ts'

const { createUserDocClient } = vi.hoisted(() => ({ createUserDocClient: vi.fn() }))
vi.mock('../src/client/documents-client.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/documents-client.ts')>(),
  createUserDocClient,
}))

const P = 'picker-pane-p' as SessionId
const Q = 'picker-pane-q' as SessionId
const document = {
  docId: 'library/fixture.txt', path: '/documents/library/fixture.txt', name: 'fixture.txt',
  bytes: 48, mediaType: 'text/plain', modifiedAt: 1,
} as UserDocRef
const contexts: Context[] = []

function t(key: DocumentsKey, params?: Record<string, string>): string {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, value)
  return text
}

afterEach(async () => {
  cleanup()
  try {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  } finally {
    createUserDocClient.mockReset()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

async function bench() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  let current: SessionId | undefined = Q
  const scopes = new Map<SessionId, UserDocScope>([[P, { kind: 'personal' }], [Q, { kind: 'project', projectId: 41 }]])
  const runtimeIdentityFor = vi.fn((id: SessionId) => scopes.get(id))
  const attachDocument = vi.fn((_id: SessionId, _ref: UserDocRef): boolean => true)
  const browse = vi.fn(async () => ({ directoryId: '', directories: [], documents: [document], limits: null }))
  const transfer = vi.fn()
  createUserDocClient.mockReturnValue({
    browse, transfer,
    contentUrl: () => '/api/documents/content?id=fixture',
    scopedContentUrl: () => '/api/documents/scope/content?id=fixture',
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ scope: { kind: 'personal' } }), {
    headers: { 'content-type': 'application/json' },
  })))
  ctx.provide('locale', { register: () => () => {} })
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ current }), subscribe: () => () => {} },
    runtimeIdentityFor,
  })
  ctx.provide('conversation', { attachDocument, canAttachDocument: () => true })
  ctx.provide('connection', { privateResourceUrl: (url: string) => url } as never)
  ctx.provide('deploymentContext', {
    getSnapshot: () => ({ phase: 'ready', showComputer: false, aggregateComputers: false }),
    subscribe: () => () => {},
  } as never)
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()

  function entries(slot: 'sidebar.footer.action' | 'shell.overlay') {
    return ctx.slots.entries(slot).map((entry) => {
      const Component = entry.component as ComponentType<Record<string, unknown>>
      const injected = entry.inject?.()
      const { hooks: _hooks, ...rest } = injected ?? {}
      return <Component
        key={`${slot}:${entry.options.id}`}
        {...rest}
        t={t}
        wide={false}
        useSessions={(select: (snapshot: { current: SessionId | undefined }) => unknown) => select({ current })}
        useWorkspaces={() => undefined}
        usePanelInfo={() => undefined}
        useDeployment={(select: (snapshot: { phase: string; showComputer: boolean; aggregateComputers: boolean }) => unknown) =>
          select({ phase: 'ready', showComputer: false, aggregateComputers: false })}
      />
    })
  }

  function Surface({ footer }: { footer: boolean }) {
    return <>{footer && entries('sidebar.footer.action')}{entries('shell.overlay')}</>
  }

  return {
    ctx, fiber, Surface, scopes, browse, transfer, attachDocument, runtimeIdentityFor,
    setCurrent: (id: SessionId | undefined) => { current = id },
  }
}

function selectDocuments(sessionId?: SessionId): void {
  fireEvent(window, new CustomEvent('dsh-documents-open-picker', {
    detail: { mode: 'select', ...(sessionId === undefined ? {} : { sessionId }) },
  }))
}

type ListenerSpy = { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }

function pickerListeners(add: ListenerSpy, remove: ListenerSpy): number {
  const active = new Set<unknown>()
  for (const [type, listener] of add.mock.calls) if (type === 'dsh-documents-open-picker') active.add(listener)
  for (const [type, listener] of remove.mock.calls) if (type === 'dsh-documents-open-picker') active.delete(listener)
  return active.size
}

describe('document picker host lifetime', () => {
  it.each([true, false])('opens the pane picker with no footer mounted (initial footer: %s)', async (initialFooter) => {
    const b = await bench()
    if (initialFooter) b.setCurrent(P)
    const view = render(<b.Surface footer={initialFooter} />)
    if (initialFooter) {
      fireEvent.click(screen.getByRole('button', { name: t('button.label') }))
      await screen.findByText(document.name)
      fireEvent.keyDown(window.document, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
      b.setCurrent(Q)
      view.rerender(<b.Surface footer={false} />)
    }
    expect(screen.queryByRole('button', { name: t('button.label') })).toBeNull()
    selectDocuments(P)

    await screen.findByRole('dialog', { name: t('modal.title') })
    await screen.findByText(document.name)
    expect(b.runtimeIdentityFor).toHaveBeenLastCalledWith(P)
    fireEvent.click(screen.getByRole('button', { name: t('action.attachNamed', { name: document.name }) }))
    expect(b.attachDocument).toHaveBeenCalledExactlyOnceWith(P, expect.objectContaining({ docId: document.docId }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the opened target and scope when current selection and target discovery change', async () => {
    const b = await bench()
    b.setCurrent(P)
    const view = render(<b.Surface footer />)
    selectDocuments(P)
    await screen.findByText(document.name)
    b.setCurrent(Q)
    b.scopes.set(P, { kind: 'project', projectId: 42 })
    view.rerender(<b.Surface footer />)

    fireEvent.click(screen.getByRole('button', { name: t('action.attachNamed', { name: document.name }) }))

    expect(b.attachDocument).toHaveBeenCalledExactlyOnceWith(P, expect.objectContaining({ docId: document.docId }))
    expect(b.transfer).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the document manager for a request without picker details', async () => {
    const b = await bench()
    b.setCurrent(P)
    render(<b.Surface footer={false} />)

    fireEvent(window, new Event('dsh-documents-open-picker'))

    await screen.findByText(document.name)
    expect(screen.getByRole('dialog', { name: t('modal.title') })).toBeTruthy()
    expect(b.runtimeIdentityFor).toHaveBeenLastCalledWith(P)
    expect(screen.queryByText(t('selection.mode.hint'))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('action.attachNamed', { name: document.name }) }))
    expect(b.attachDocument).toHaveBeenCalledExactlyOnceWith(P, expect.objectContaining({ docId: document.docId }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(['undefined', 'false', 'throw'] as const)('keeps rejected attachments open without retargeting (%s)', async (refusal) => {
    const b = await bench()
    if (refusal === 'undefined') b.setCurrent(undefined)
    if (refusal === 'false') b.attachDocument.mockReturnValue(false)
    if (refusal === 'throw') b.attachDocument.mockImplementation(() => { throw new Error('retired') })
    render(<b.Surface footer />)
    selectDocuments(refusal === 'undefined' ? undefined : P)
    await screen.findByText(document.name)

    fireEvent.click(screen.getByRole('button', { name: t('action.attachNamed', { name: document.name }) }))

    expect((await screen.findByRole('alert')).textContent).toContain(t('action.attach.error'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    if (refusal === 'undefined') expect(b.attachDocument).not.toHaveBeenCalled()
    else expect(b.attachDocument).toHaveBeenCalledExactlyOnceWith(P, expect.objectContaining({ docId: document.docId }))
  })

  it('keeps one listener across footer changes and removes it with the plugin', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const b = await bench()
    const view = render(<b.Surface footer />)
    expect(pickerListeners(add, remove)).toBe(1)
    view.rerender(<b.Surface footer={false} />)
    expect(pickerListeners(add, remove)).toBe(1)
    view.rerender(<b.Surface footer />)
    selectDocuments(P)
    await screen.findByText(document.name)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    await waitFor(() => { expect(b.browse).toHaveBeenCalledTimes(1) })
    fireEvent.keyDown(window.document, { key: 'Escape' })
    b.browse.mockClear()

    await act(async () => { await b.fiber.dispose() })
    view.rerender(<b.Surface footer />)
    expect(pickerListeners(add, remove)).toBe(0)
    selectDocuments(P)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.browse).not.toHaveBeenCalled()
  })
})
