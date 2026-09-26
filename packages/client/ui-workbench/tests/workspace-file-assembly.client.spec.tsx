// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ProjectUiPolicyRuntime, WorkspaceResourceRegistry, createSnapshotStore, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as sidebarApply, inject as sidebarInject } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { apply, inject } from '../src/client/apply.ts'

const SID = 'file-assembly' as SessionId
function Root({ renderSlot }: PropsRenderSlots<'rightbar'>) {
  return renderSlot('rightbar', { width: 360, viewportWidth: 1440, canShow: true, targetSessionId: SID })
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('opens an authorized workspace file through the assembled tab registry and renderer', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const animation = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  const runtime = await SlotTestRuntime.create()
  try {
    const resources = new WorkspaceResourceRegistry()
    resources.register({ kind: 'base' }, {
      stat: async () => ({ sessionId: SID, path: 'a.txt', version: 'v1', type: 'file', changed: false }),
    }, 5)
    runtime.provide('workspaceResources', resources)
    runtime.provide('projectUiPolicy', new ProjectUiPolicyRuntime())
    runtime.provide('layout', { bindRightbar: () => () => {}, focusRightbar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn() })
    runtime.provide('connection', {
      hostDescription: createSnapshotStore({ executionAuthorityRequired: false }),
      api: { workspaceFiles: { read: async () => ({ result: { ok: true, value: { path: 'a.txt', version: 'v1', offset: 1, limit: 20, eof: true, text: 'assembled content' } } }) } },
    })
    runtime.provide('conversationViewport', { snapshot: createSnapshotStore({ mode: 'single' as const, paneIds: [], paneRatios: [] }) })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.sessions.add({ id: SID })
    await runtime.root.declare({ rightbar: { kind: 'single', scope: 'root' } }, Root)
    await runtime.mount({ inject: [...sidebarInject], apply: sidebarApply })
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()
    act(() => { runtime.ctx.bail('workspace/resource-open', { sessionId: SID, path: 'a.txt', runtimeTarget: { kind: 'base' }, address: workspaceResourceAddress(SID, 'a.txt') }) })
    await waitFor(() => { expect(view.getByText('assembled content')).toBeTruthy() })
  } finally {
    await runtime.dispose()
    if (animation === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', animation)
  }
})

it('routes Markdown and HTML resources through the assembled authorized readers', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const animation = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  const create = vi.fn<(blob: Blob) => string>().mockImplementation(() => `blob:assembly/${create.mock.calls.length}`)
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  const runtime = await SlotTestRuntime.create()
  try {
    const resources = new WorkspaceResourceRegistry()
    resources.register({ kind: 'base' }, {
      stat: async (address) => {
        const path = decodeURIComponent(address.slice(address.lastIndexOf('/') + 1))
        return { sessionId: SID, path, version: 'v1', type: 'file' as const, changed: false }
      },
    }, 5)
    runtime.provide('workspaceResources', resources)
    runtime.provide('projectUiPolicy', new ProjectUiPolicyRuntime())
    runtime.provide('layout', { bindRightbar: () => () => {}, focusRightbar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn() })
    runtime.provide('connection', {
      hostDescription: createSnapshotStore({ executionAuthorityRequired: false }),
      api: {
        workspaceFiles: {
          read: async (request: { path: string; offset?: number }) => ({
            result: { ok: true as const, value: { path: request.path, version: 'v1', offset: request.offset ?? 1, limit: 50, eof: true, text: '# Assembled\n\nbody' } },
          }),
          stat: async (request: { path: string }) => ({
            result: { ok: true as const, value: { path: request.path, type: 'file' as const, bytes: 8, version: 'v1' } },
          }),
          readBytes: async (request: { path: string }) => ({
            result: { ok: true as const, value: { path: request.path, offset: 0, bytes: btoa(request.path === 'page.html' ? '<p>html body</p>' : 'asset'), eof: true, version: 'v1' } },
          }),
        },
      },
    })
    runtime.provide('conversationViewport', { snapshot: createSnapshotStore({ mode: 'single' as const, paneIds: [], paneRatios: [] }) })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.sessions.add({ id: SID })
    await runtime.root.declare({ rightbar: { kind: 'single', scope: 'root' } }, Root)
    await runtime.mount({ inject: [...sidebarInject], apply: sidebarApply })
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()
    act(() => { runtime.ctx.bail('workspace/resource-open', { sessionId: SID, path: 'guide.md', runtimeTarget: { kind: 'base' }, address: workspaceResourceAddress(SID, 'guide.md') }) })
    await waitFor(() => { expect(view.getByRole('heading', { name: 'Assembled' })).toBeTruthy() })
    expect(view.container.querySelector('[data-workspace-markdown]')).not.toBeNull()
    act(() => { runtime.ctx.bail('workspace/resource-open', { sessionId: SID, path: 'page.html', runtimeTarget: { kind: 'base' }, address: workspaceResourceAddress(SID, 'page.html') }) })
    await waitFor(() => { expect(view.container.querySelector('iframe[data-workspace-html-preview]')).not.toBeNull() })
    expect(create).toHaveBeenCalled()
  } finally {
    await runtime.dispose()
    if (animation === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', animation)
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
  }
})
