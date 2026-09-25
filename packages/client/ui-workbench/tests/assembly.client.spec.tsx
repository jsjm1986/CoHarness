// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyConversation, inject as conversationInject } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyWorkspace, inject as workspaceInject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISession, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyAuxiliary, inject as auxiliaryInject } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { ProjectUiPolicyRuntime, WorkspaceResourceRegistry, createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
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
    runtime.provide('connection', { api: { settings: {} }, isLoopback: false, hostDescription: createSnapshotStore({ executionAuthorityRequired: false }) })
    runtime.provide('remote', { $on: () => () => {} })
    runtime.provide('remote.permissionPresets', { catalog: () => Promise.resolve({ ok: true, value: [] }) })
    runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn(), bindRightbar: () => () => {}, focusRightbar: vi.fn() })
    runtime.provide('workspaceResources', new WorkspaceResourceRegistry())
    runtime.provide('projectUiPolicy', new ProjectUiPolicyRuntime())
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
    await runtime.mount({ inject: [...auxiliaryInject], apply: applyAuxiliary })
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

/** Test-owned shell role: the browsing region plus the conversation surface that hosts the toolbar. */
function SidebarFrame({ renderSlot }: PropsRenderSlots<'sidebar.workspaces' | 'conversation'>) {
  return (
    <>
      {renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}
      {renderSlot('conversation', {})}
    </>
  )
}

describe('assembled workbench sidebar panel', () => {
  it('renders the pane roster, actions, and display controls through the real slot chain', async () => {
    const runtime = await SlotTestRuntime.create()
    const scope = stubSettingsScope()
    runtime.provide('connection', {
      api: { settings: {} },
      isLoopback: false,
      hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
    })
    runtime.provide('remote', { $on: () => () => {} })
    runtime.provide('remote.permissionPresets', { catalog: () => Promise.resolve({ ok: true, value: [] }) })
    runtime.provide('settingsScope', { bind: () => scope.scope } as never)
    runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn(), bindRightbar: () => () => {}, focusRightbar: vi.fn() })
    runtime.provide('workspaceResources', new WorkspaceResourceRegistry())
    runtime.provide('projectUiPolicy', new ProjectUiPolicyRuntime())
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    for (const [id, title, path] of [[A, 'Alpha', '/work/alpha'], [B, 'Beta', '/work/beta']] as const) {
      await runtime.sessions.add({
        id,
        summary: { displayTitle: title, cwd: path, blank: false },
        session: { prompt: vi.fn(), loadOlder: vi.fn() },
      })
    }
    await runtime.workspaces.update((draft) => {
      draft.items = [
        { workspaceId: 'wa', title: 'Alpha', path: '/work/alpha', sessionIds: [A] },
        { workspaceId: 'wb', title: 'Beta', path: '/work/beta', sessionIds: [B] },
      ] as never
    })
    await runtime.root.declare(
      {
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        conversation: { kind: 'single', scope: 'root' },
        details: { kind: 'single', scope: 'session' },
      } as never,
      SidebarFrame as never,
    )
    await runtime.mount({ inject: [...conversationInject], apply: applyConversation })
    await runtime.mount({ inject: [...workspaceInject], apply: applyWorkspace })
    await runtime.mount({ inject: [...auxiliaryInject], apply: applyAuxiliary })
    await runtime.mount({ inject: [...inject], apply })
    const viewport = runtime.ctx.get('conversationViewport')
    if (viewport === undefined) throw new Error('workbench capability missing')
    viewport.add(A)
    viewport.add(B)
    scope.publish({
      status: 'ready', writable: true,
      value: { chatFontSize: 16, chatContentWidth: 720, chatFullWidth: false },
    } as never)
    const view = runtime.renderRoot()
    await waitFor(() => { expect(view.getByRole('region', { name: '工作台' })).toBeTruthy() })
    const panel = within(view.getByRole('region', { name: '工作台' }))
    // The roster reads pane order and titles from the live sessions list.
    const beta = panel.getByRole('button', { name: /Beta · Beta/ })
    expect(beta.getAttribute('aria-current')).toBe('true')
    fireEvent.click(panel.getByRole('button', { name: /Alpha · Alpha/ }))
    expect(viewport.snapshot.getSnapshot().activePaneId).toBe(A)
    // Equalize writes equal weights through the viewport capability.
    fireEvent.click(panel.getByRole('button', { name: '等宽' }))
    expect(viewport.snapshot.getSnapshot().paneRatios).toEqual([0.5, 0.5])
    // The display hole hosts the shared settings face's sidebar variant.
    const fontSize = panel.getByRole('slider', { name: '文字大小' })
    fireEvent.change(fontSize, { target: { value: '15' } })
    expect(scope.set).toHaveBeenCalledWith('chatFontSize', 15)
    // Add opens the shared picker store → the toolbar's picker dialog.
    fireEvent.click(panel.getByRole('button', { name: '添加对话' }))
    await waitFor(() => { expect(view.getByRole('dialog')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: '关闭选择器' }))
    // Exit restores the single-conversation surface and the session list.
    fireEvent.click(panel.getByRole('button', { name: '退出工作台' }))
    await waitFor(() => { expect(viewport.snapshot.getSnapshot().mode).toBe('single') })
    await waitFor(() => { expect(view.queryByRole('region', { name: '工作台' })).toBeNull() })
    await runtime.dispose()
  })
})
