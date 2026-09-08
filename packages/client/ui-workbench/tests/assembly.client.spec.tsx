// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyConversation, inject as conversationInject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISession, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/apply.ts'

usePinnedBrowserLanguages('zh-CN')

const A = 'pane-a' as SessionId
const B = 'pane-b' as SessionId

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function Root({ renderSlot }: PropsRenderSlots<'conversation' | 'details'>) {
  return <>{renderSlot('conversation', {})}</>
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('assembled workbench', () => {
  it('binds two independent composers and preserves the first pane on focus changes', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
    runtime.provide('remote', { $on: () => () => {} })
    runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const promptA = vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } }))
    const promptB = vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } }))
    for (const [id, title, path, prompt] of [[A, 'Alpha', '/work/alpha', promptA], [B, 'Beta', '/work/beta', promptB]] as const) {
      await runtime.sessions.add({
        id,
        summary: { displayTitle: title, cwd: path, blank: false },
        session: { prompt, loadOlder: vi.fn<ISession['loadOlder']>() },
      })
    }
    await runtime.workspaces.update((draft) => {
      draft.items = [
        { workspaceId: 'wa', title: 'Alpha', path: '/work/alpha', sessionIds: [A] },
        { workspaceId: 'wb', title: 'Beta', path: '/work/beta', sessionIds: [B] },
      ] as never
    })
    await runtime.root.declare({
      conversation: { kind: 'single', scope: 'root' },
      details: { kind: 'single', scope: 'session' },
    }, Root)
    await runtime.mount({ inject: [...conversationInject], apply: applyConversation })
    await runtime.mount({ inject: [...inject], apply })
    const viewport = runtime.ctx.get('conversationViewport')
    if (viewport === undefined) throw new Error('workbench capability missing')
    viewport.add(A)
    viewport.add(B)
    const view = runtime.renderRoot()
    const areas = view.container.querySelectorAll<HTMLTextAreaElement>('textarea')
    expect(areas).toHaveLength(2)
    const first = areas[0]!
    fireEvent.change(first, { target: { value: 'Alpha prompt' } })
    fireEvent.keyDown(first, { key: 'Enter' })
    await waitFor(() => { expect(promptA).toHaveBeenCalledOnce() })
    expect(promptB).not.toHaveBeenCalled()
    viewport.focus(B)
    expect(view.container.querySelectorAll('textarea')[0]).toBe(first)
    await runtime.dispose()
  })
})
