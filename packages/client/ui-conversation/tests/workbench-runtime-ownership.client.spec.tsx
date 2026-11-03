// @vitest-environment jsdom
/** Workbench ownership across keyed main-panel replacement and feature withdrawal. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle, HostDescription } from '@deepseek-ai/dsh-client-connection/client'
import {
  clientSessionKey, ConversationEventRegistry, ConversationViewRegistry, createSnapshotStore,
  ProjectUiPolicyRuntime, sessionPersistenceKey, SessionRuntime, SessionRuntimePool, SlotRegistry,
  WorkspaceRuntime,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SessionRuntimeTarget, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createSlotRenderer, stubDeveloperTools, stubSettingsScope, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import { FakeApiClient, fakeRemote, ok } from '../../runtime/tests/fake-api.client.ts'
import { apply, inject } from '../src/client/apply.ts'
import type { ConversationViewportController } from '../src/client/viewport.ts'
import { readWorkbenchRecord } from '../src/client/workbench-persistence.ts'
import type { IConversation } from '../src/client/service.ts'

usePinnedBrowserLanguages('en-US')

const DURABLE = 'shared-durable-session' as SessionId
const PERSONAL = { kind: 'personal' } as const
const PROJECT = { kind: 'project', projectId: 7 } as const
const P = clientSessionKey(PERSONAL, DURABLE)
const Q = clientSessionKey(PROJECT, DURABLE)
const PRINCIPAL = 'account:1'
const roots: Context[] = []

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})
afterEach(async () => {
  cleanup()
  await act(async () => {
    for (const root of roots.splice(0).reverse()) await root.fiber.dispose()
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The layout's keyed outlet replaces the conversation subtree when a panel is selected. */
function Frame({ renderSlot }: PropsRenderSlots<'main' | 'details'>) {
  const [panel, setPanel] = useState('conversation')
  return <>
    <button onClick={() => { setPanel('plugins') }}>Plugins</button>
    <button onClick={() => { setPanel('conversation') }}>Conversation</button>
    {renderSlot('main', {}, { entryKey: panel })}
  </>
}

/** Connection boundary for the real pooled Runtime fixture. */
function transport(api: FakeApiClient, target: SessionRuntimeTarget, stopped = vi.fn()): ConnectionHandle {
  const description: HostDescription = {
    version: 'test', cwd: '/workspace', home: '/home/test', attachedSessions: 0, canOpenPath: false,
    executionAuthorityRequired: true, runtimeTarget: target,
  }
  return {
    api, isLoopback: false, interactions: 'none',
    metadataTiming: { requestTimeoutMs: 15000, retryAfterMs: 10000 },
    hostDescription: createSnapshotStore<HostDescription | undefined>(description),
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: { call: () => Promise.reject(new Error('unexpected rpc')) },
    reconnect: () => {},
    start: (sinks) => {
      const ac = new AbortController()
      void (async () => {
        try {
          for await (const envelope of api.events.mux({}, ac.signal)) sinks.onMuxEnvelope?.(envelope)
        } catch { /* mux stream closed or failed during teardown */ }
      })()
      queueMicrotask(() => { sinks.onConnected?.(description) })
      return { stop: () => { ac.abort(); stopped() } }
    },
  }
}

function mountToolbar(ctx: Context) {
  return ctx.plugin({
    inject: ['slots'],
    apply(scope) {
      scope.slots.inject('conversation.workbench.toolbar', () => scope.slots.register({
        name: 'conversation.workbench.toolbar',
      }, () => <span>Workbench controls</span>))
    },
  })
}

async function bench(focused: 'personal' | 'project' = 'personal') {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SlotRegistry).await()
  await ctx.plugin(ConversationEventRegistry).await()
  await ctx.plugin(ConversationViewRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.install(createSlotRenderer())
  const personalApi = new FakeApiClient(), projectApi = new FakeApiClient()
  for (const [index, api] of [personalApi, projectApi].entries()) {
    api.onList = async () => ok({ items: [{
      sessionId: DURABLE, title: index === 0 ? 'Personal pane' : 'Project pane',
      updatedAt: 1, running: false, blank: false, cwd: '/workspace',
    }] })
    api.onWorkspaceList = async () => ok({ items: [{
      workspaceId: `workspace-${index}` as WorkspaceId, title: 'Workspace', path: '/workspace', sessionIds: [DURABLE],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] })
  }
  const stopped = vi.fn()
  const project = transport(projectApi, PROJECT, stopped)
  const rootTransport: ConnectionHandle = { ...transport(personalApi, PERSONAL), forTarget: () => project }
  ctx.provide('connection', rootTransport)
  const base = new SessionRuntime(ctx, personalApi, fakeRemote(), undefined, {
    persistSelection: false, provideService: false, hostDescription: rootTransport.hostDescription,
  })
  const pool = new SessionRuntimePool(ctx, base, rootTransport, fakeRemote())
  pool.setBaseRuntimeTarget(PERSONAL)
  const workspaces = new WorkspaceRuntime(ctx, personalApi, pool)
  const policy = new ProjectUiPolicyRuntime()
  policy.setVerifiedAccountId(1)
  ctx.provide('projectUiPolicy', policy)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('remote.permissionPresets', { catalog: async () => ({ ok: true, value: [] }) })
  ctx.provide('settingsScope', {
    bind: () => stubSettingsScope().scope, developerTools: stubDeveloperTools().preference,
  } as never)
  ctx.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() } as never)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  slots.installLocale(locale)
  slots.register({
    name: 'root',
    children: { main: { kind: 'keyed', scope: 'root' }, details: { kind: 'single', scope: 'session' } },
  }, Frame)
  slots.register({ name: 'main', key: 'plugins' }, () => <section aria-label="Plugins panel">Plugins panel</section>)
  const feature = ctx.plugin({ inject: [...inject], apply })
  await feature.await()
  let toolbar = mountToolbar(ctx)
  await toolbar.await()
  await Promise.all([pool.refresh(), workspaces.refresh()])
  pool.open(P)
  await vi.waitFor(() => { expect(pool.binding(P)?.session.getSnapshot().openState).toBe('open') })
  const view = render(<>{slots.renderSlot('root', {})}</>)
  const viewport = ctx.get('conversationViewport') as ConversationViewportController
  let active = ''
  await act(async () => {
    active = viewport.createWorkbench('A')
    expect(viewport.add(P)).toEqual({ ok: true })
    await pool.usingRuntime(PROJECT, new AbortController().signal, async (signal) => {
      expect(await pool.ensureSession(PROJECT, DURABLE, signal)).toBe(true)
      expect(viewport.add(Q)).toEqual({ ok: true })
    })
    viewport.duplicateWorkbench(active, 'B')
    viewport.switchWorkbench(active)
    viewport.focus(focused === 'personal' ? P : Q)
    viewport.markCatalogReady()
  })
  await waitFor(() => {
    expect(view.container.querySelectorAll('textarea')).toHaveLength(2)
    expect(pool.binding(Q)?.session.getSnapshot().openState).toBe('open')
  })
  expect([...view.container.querySelectorAll('textarea')].map(area => area.value)).toEqual(['', ''])
  expect(pool.retainInfo(Q).getSnapshot().retainedBy.composer).toBeUndefined()
  const namedMembers = () => readWorkbenchRecord(PRINCIPAL)?.workbenches
    .filter(row => row.name === 'A' || row.name === 'B').map(row => ({ name: row.name, paneIds: row.paneIds }))
  const reattachToolbar = async () => {
    toolbar = mountToolbar(ctx)
    await act(async () => { await toolbar.await() })
  }
  return {
    ctx, view, pool, viewport, feature, toolbar, reattachToolbar, policy, personalApi, projectApi, stopped, namedMembers,
  }
}

const MEMBERS = [{ name: 'A', paneIds: [P, Q] }, { name: 'B', paneIds: [P, Q] }]

describe('logical Workbench Runtime ownership', () => {
  it.each(['personal', 'project'] as const)(
    'persists an accepted %s draft while the conversation is hidden', async (focused) => {
      const h = await bench(focused)
      const id = focused === 'personal' ? P : Q
      const api = focused === 'personal' ? h.personalApi : h.projectApi
      const admission = Promise.withResolvers<Awaited<ReturnType<typeof api.onPrompt>>>()
      api.onPrompt = () => admission.promise
      try {
        const scope = h.pool.scope(id)
        if (scope === undefined) throw new Error('Expected the retained Session scope')
        const conversation = h.ctx.get('conversation') as IConversation
        const input = conversation.input.for(scope)
        const text = `Accepted hidden ${focused} prompt`
        const owner = sessionPersistenceKey(h.ctx.sessions, id, true, 1)
        if (owner === undefined) throw new Error('Expected the verified persistence owner')
        const key = `dsh.conversation.chat.scoped.v1.${encodeURIComponent(owner)}`
        act(() => {
          input.setDraft(text)
          input.submit()
        })
        await waitFor(() => { expect(api.callsOf('session.prompt')).toHaveLength(1) })
        expect(input.state.getSnapshot().phase).toBe('submitting')
        expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toMatchObject({ draft: text })
        fireEvent.click(h.view.getByRole('button', { name: /^Plugins$/ }))
        expect(h.view.container.querySelectorAll('textarea')).toHaveLength(0)
        await act(async () => { admission.resolve(ok({ accepted: true as const })); await admission.promise })
        const requestId = h.pool.binding(id)?.session.getSnapshot().pendingSubmissions?.[0]?.requestId
        if (requestId === undefined) throw new Error('Expected the pending submission echo')
        const frame = {
          type: 'session/event',
          sessionId: DURABLE,
          event: {
            seq: 1, time: 1_700_000_000_001,
            type: 'user/message', surfaceOp: 'append',
            data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } },
          },
        } as never
        await act(async () => {
          if (focused === 'personal') h.pool.handleMuxEnvelope({ rpcId: 'echo' as never, payload: frame })
          else api.pushMux(frame)
        })
        await waitFor(() => { expect(input.state.getSnapshot().draft).toBe('') })
        expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toMatchObject({ draft: '' })
        fireEvent.click(h.view.getByRole('button', { name: /^Conversation$/ }))
        await waitFor(() => {
          expect([...h.view.container.querySelectorAll('textarea')].map(area => area.value)).toEqual(['', ''])
        })
        expect(h.namedMembers()).toEqual(MEMBERS)
        expect(api.callsOf('session.prompt')).toHaveLength(1)
      } finally {
        await act(async () => { admission.resolve(ok({ accepted: true as const })); await admission.promise })
      }
    },
  )

  it.each(['personal', 'project'] as const)(
    'keeps both Runtime panes when a global panel replaces the %s-focused conversation', async (focused) => {
      const h = await bench(focused)
      const binding = h.pool.binding(Q)
      const histories = [h.personalApi, h.projectApi].map(api => api.callsOf('session.history').length)
      fireEvent.click(h.view.getByRole('button', { name: /^Plugins$/ }))
      // Membership is checked before panel readiness: losing the active foreign
      // Runtime can also cause the layout to return to Conversation automatically.
      expect({
        named: h.namedMembers(), panes: h.viewport.snapshot.getSnapshot().paneIds,
        projectListed: h.pool.list.getSnapshot().byId[Q] !== undefined,
        current: h.pool.list.getSnapshot().current, transportStops: h.stopped.mock.calls.length,
      }).toEqual({
        named: MEMBERS, panes: [P, Q], projectListed: true,
        current: focused === 'personal' ? P : Q, transportStops: 0,
      })
      expect(h.view.getByRole('region', { name: 'Plugins panel' })).toBeTruthy()
      expect(h.view.container.querySelectorAll('[data-session-pane]')).toHaveLength(0)
      expect(h.pool.binding(Q)).toBe(binding)
      fireEvent.click(h.view.getByRole('button', { name: /^Conversation$/ }))
      await waitFor(() => { expect(h.view.container.querySelectorAll('[data-session-pane]')).toHaveLength(2) })
      expect(h.pool.binding(Q)).toBe(binding)
      expect([h.personalApi, h.projectApi].map(api => api.callsOf('session.history').length)).toEqual(histories)
      for (const api of [h.personalApi, h.projectApi]) {
        expect(api.callsOf('session.create')).toEqual([])
        expect(api.callsOf('session.prompt')).toEqual([])
        expect(api.callsOf('session.cancel')).toEqual([])
      }
    },
  )

  it('releases an absent Workbench contribution without erasing saved members, then accepts verified restoration', async () => {
    const h = await bench()
    const old = h.pool.binding(Q)
    await act(async () => { await h.toolbar.dispose() })
    expect(h.stopped).toHaveBeenCalledOnce()
    expect(h.pool.list.getSnapshot().byId[Q]).toBeUndefined()
    expect(h.pool.binding(Q)).toBeUndefined()
    expect(h.namedMembers()).toEqual(MEMBERS)
    expect(h.viewport.snapshot.getSnapshot().paneIds).toEqual([P, Q])
    await h.reattachToolbar()
    expect(h.viewport.needsCatalogRestore()).toBe(true)
    // The Workbench catalog owns verification; reinstating presentation alone
    // cannot turn a saved foreign key into an authorized Runtime binding.
    await act(async () => {
      await h.pool.usingRuntime(PROJECT, new AbortController().signal, async (signal) => {
        expect(await h.pool.ensureSession(PROJECT, DURABLE, signal)).toBe(true)
        h.viewport.markCatalogReady()
      })
    })
    await waitFor(() => { expect(h.view.container.querySelectorAll('textarea')).toHaveLength(2) })
    expect(h.pool.binding(Q)).toBeDefined()
    expect(h.pool.binding(Q)).not.toBe(old)
    expect(h.namedMembers()).toEqual(MEMBERS)
  })

  it('releases foreign Runtime windows in single mode while preserving both named pane sets', async () => {
    const h = await bench()
    act(() => { h.viewport.setMode('single') })
    expect(h.stopped).toHaveBeenCalledOnce()
    expect(h.pool.binding(Q)).toBeUndefined()
    expect(h.pool.list.getSnapshot().byId[Q]).toBeUndefined()
    expect(h.viewport.snapshot.getSnapshot().mode).toBe('single')
    expect(h.namedMembers()).toEqual(MEMBERS)
  })

  it('withdraws verified-account access and Runtime holds without rewriting its saved named members', async () => {
    const h = await bench()
    act(() => {
      h.policy.setVerifiedAccountId(undefined)
      h.pool.invalidateAccount()
    })
    expect(h.stopped).toHaveBeenCalledOnce()
    expect(h.pool.list.getSnapshot().byId).toEqual({})
    expect(h.pool.binding(Q)).toBeUndefined()
    expect(h.viewport.snapshot.getSnapshot().paneIds).toEqual([])
    expect(h.namedMembers()).toEqual(MEMBERS)
  })

  it('releases the logical Workbench with its owning conversation plugin', async () => {
    const h = await bench()
    await act(async () => { await h.feature.dispose() })
    expect(h.ctx.get('conversationViewport')).toBeUndefined()
    expect(h.stopped).toHaveBeenCalledOnce()
    expect(h.pool.binding(Q)).toBeUndefined()
    expect(h.namedMembers()).toEqual(MEMBERS)
  })
})
