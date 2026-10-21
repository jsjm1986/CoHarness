/**
 * ui-plan browser half on a real SlotRegistry: the plugin occupies the
 * conversation-declared `conversation.input.plan` single seat with the active
 * plan status chip, registers its submitted-plan Conversation definition and
 * `plan` Sidebar type, injects turn-tail cards, review navigation, and both
 * Sidebar preview seats, and unwinds every registration on teardown.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { PlanChip } from '../src/client/PlanModeControl.tsx'
import { PlanCards, PlanReviewOpen } from '../src/client/PlanCard.tsx'
import { PlanPreview, PlanTitle } from '../src/client/PlanPreview.tsx'
import { submittedPlanDefinition } from '../src/client/plan-definition.ts'
import type { PlanChipInjected } from '../src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

const SID = 's-plan' as SessionId

const CHAT_SLOTS = {
  'conversation.input.plan': { kind: 'single', scope: 'session' },
  'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
  'conversation.plan-review.actions': { kind: 'list', scope: 'session' },
  'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
  'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session' },
}

function chatSnapshot() {
  return {
    chat: {
      order: [], locations: { getTurn: () => [], getStep: () => [] },
      entries: [], groups: { get: () => undefined },
      navigation: { items: () => [] },
      timeline: { turnOrder: [], turns: new Map() },
      legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
      nodes: { get: () => undefined, values: () => [] },
    },
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: CHAT_SLOTS } as never, () => null)
  const execute = vi.fn((_sessionId: SessionId, _line: string) =>
    Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success' as const } } }))
  const commandsRemote = { execute }
  const session = createSnapshotStore(chatSnapshot())
  const binding = { session }
  const sessions = {
    binding: vi.fn(() => binding),
    subagentAddress: vi.fn(() => undefined),
    retain: vi.fn(),
  }
  const sidebarRight = {
    mounted: createSnapshotStore<SessionId | undefined>(SID),
    openSessionResource: vi.fn(),
  }
  const disposers: ReturnType<typeof vi.fn>[] = []
  const conversationEvents = { register: vi.fn((_definition: unknown) => { const d = vi.fn(); disposers.push(d); return d }) }
  const sidebarRightTabs = { register: vi.fn((_definition: unknown) => { const d = vi.fn(); disposers.push(d); return d }) }
  ctx.provide('remote', { commands: commandsRemote })
  ctx.provide('remote.commands', commandsRemote)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', sessions)
  ctx.provide('sidebarRight', sidebarRight)
  ctx.provide('conversationEvents', conversationEvents)
  ctx.provide('sidebarRightTabs', sidebarRightTabs)
  return { ctx, slots, execute, sessions, sidebarRight, conversationEvents, sidebarRightTabs, disposers }
}

describe('ui-plan browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual([
      'slots', 'remote', 'remote.commands', 'locale',
      'conversationEvents', 'sessions', 'sidebarRight', 'sidebarRightTabs',
    ])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers the plan definition and the plan Sidebar type', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.conversationEvents.register).toHaveBeenCalledWith(submittedPlanDefinition)
    const type = b.sidebarRightTabs.register.mock.calls[0]?.[0] as {
      kind: string
      patterns: readonly string[]
      canOpen: (address: string) => boolean
      resourceSession?: (address: string) => SessionId | undefined
      title: (address: string) => string
    }
    expect(type.kind).toBe('plan')
    expect(type.canOpen('dsh-resource://plan/s-1/c-1')).toBe(true)
    expect(type.canOpen('dsh-resource://plan-review/s-1/k')).toBe(true)
    expect(type.canOpen('dsh-resource://file/s-1/x.md')).toBe(false)
    expect(type.resourceSession?.('dsh-resource://plan/s-1/c-1')).toBe('s-1')
    expect(type.resourceSession?.('dsh-resource://plan/subagent/p/c/one-shot/x')).toBe('c')
    expect(type.resourceSession?.('dsh-resource://plan-review/s-1/k')).toBe('s-1')
    expect(type.title('dsh-resource://plan/s-1/c-1')).toBeTruthy()
    await fiber.dispose()
  })

  it('injects cards, review navigation, and both preview seats', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const tail = b.slots.entries('conversation.chat.turnTail').find(entry => entry.component === PlanCards)
    expect(tail).toBeDefined()
    const injected = (tail?.inject as never as (id: SessionId) => {
      keyedHooks: { plans: (turn: string) => { getSnapshot(): readonly unknown[] } }
      openPlan: (callId: string) => void
    })(SID)
    expect(injected.keyedHooks.plans('1').getSnapshot()).toEqual([])
    expect(injected.keyedHooks.plans('1')).toBe(injected.keyedHooks.plans('1'))
    injected.openPlan('c-1')
    expect(b.sidebarRight.openSessionResource).toHaveBeenCalledWith(SID, 'dsh-resource://plan/s-plan/c-1')

    b.sessions.subagentAddress.mockReturnValueOnce(
      { parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' } as never)
    injected.openPlan('c-2')
    expect(b.sidebarRight.openSessionResource).toHaveBeenCalledWith(
      SID, 'dsh-resource://plan/subagent/p/c/continuable/c-2')

    const review = b.slots.entries('conversation.plan-review.actions').find(entry => entry.component === PlanReviewOpen)
    const preview = b.slots.entries('sidebar.right.pane.tab').find(entry => entry.component === PlanPreview)
    const title = b.slots.entries('sidebar.right.pane.tab.title').find(entry => entry.component === PlanTitle)
    expect(review).toBeDefined()
    expect(preview).toBeDefined()
    expect(title).toBeDefined()
    await fiber.dispose()
  })

  it('opens logged calls and temporary previews from the review action', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('conversation.plan-review.actions').find(e => e.component === PlanReviewOpen)
    const injected = (entry?.inject as never as (id: SessionId) => {
      openReview: (review: unknown, requestKey: string) => boolean
      hooks: { sidebarMounted: unknown }
    })(SID)
    expect(injected.hooks.sidebarMounted).toBe(b.sidebarRight.mounted)

    expect(injected.openReview(
      { id: 'q', question: 'approve?', plan: '# Logged', callId: 'c-9', approve: { label: 'ok' } }, 'req-9',
    )).toBe(true)
    expect(b.sidebarRight.openSessionResource).toHaveBeenLastCalledWith(SID, 'dsh-resource://plan/s-plan/c-9')

    expect(injected.openReview(
      { id: 'q', question: 'approve?', plan: '# Pending\nbody', approve: { label: 'ok' } }, 'req-1',
    )).toBe(true)
    const [, previewAddress, previewOptions] = b.sidebarRight.openSessionResource.mock.calls.at(-1) as [
      SessionId, string, { params: { planReview: { markdown: string; title: string } } },
    ]
    expect(previewAddress.startsWith('dsh-resource://plan-review/s-plan/')).toBe(true)
    expect(decodeURIComponent(previewAddress.split('/').at(-1) ?? '').endsWith(':req-1')).toBe(true)
    expect(previewOptions.params.planReview).toEqual({ markdown: '# Pending\nbody', title: 'Pending' })

    ;(b.sidebarRight as { mounted?: unknown }).mounted = createSnapshotStore<SessionId | undefined>(undefined)
    expect(injected.openReview({ id: 'q', question: '', plan: '', approve: { label: 'ok' } }, 'req-2')).toBe(false)
    await fiber.dispose()
  })

  it('drives plan reads from both preview seats and resets them on reconnection', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const slot of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'] as const) {
      const entry = b.slots.entries(slot).find(e => e.component !== undefined)
      const injected = (entry?.inject as never as () => {
        hooks: { planDocument: { getSnapshot(): Record<string, { status: string } | undefined> } }
        loadPlan: (address: string) => Promise<void>
      })()
      await injected.loadPlan('dsh-resource://plan/s-1/c-1')
      expect(injected.hooks.planDocument.getSnapshot()['dsh-resource://plan/s-1/c-1']).toMatchObject({
        status: 'failed', failure: { code: 'plan/unavailable' },
      })
    }
    b.ctx.emit('connection/reset')
    const reads = (b.slots.entries('sidebar.right.pane.tab')[0]?.inject as never as () => {
      hooks: { planDocument: { getSnapshot(): Record<string, unknown> } }
    })().hooks.planDocument
    expect(reads.getSnapshot()).toEqual({})
    await fiber.dispose()
  })

  it('throws loud for a card seat injected into an unknown Session', async () => {
    const b = await bench()
    b.sessions.binding.mockReturnValueOnce(undefined as never)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const tail = b.slots.entries('conversation.chat.turnTail').find(entry => entry.component === PlanCards)
    expect(() => (tail?.inject as never as (id: SessionId) => unknown)('ghost' as SessionId)).toThrow('ui-plan: unknown session')
    await fiber.dispose()
  })

  it('unwinds every registration on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const name of Object.keys(CHAT_SLOTS) as Array<keyof typeof CHAT_SLOTS>) expect(b.slots.entries(name).length).toBeGreaterThan(0)
    await fiber.dispose()
    expect(b.slots.entries('conversation.input.plan')).toHaveLength(0)
    expect(b.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
    expect(b.slots.entries('conversation.plan-review.actions')).toHaveLength(0)
    expect(b.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
    expect(b.slots.entries('sidebar.right.pane.tab.title')).toHaveLength(0)
    for (const disposer of b.disposers) expect(disposer).toHaveBeenCalled()
  })

  it('registers the chip, executes /plan off, and reports failures', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('conversation.input.plan')[0]!
    expect(entry.component).toBe(PlanChip)
    const injected = (entry.inject as never as (id: SessionId) => PlanChipInjected)(SID)

    await expect(injected.exitPlanMode()).resolves.toBeNull()
    expect(b.execute).toHaveBeenLastCalledWith(SID, '/plan off', [])

    // Business failure folds to the composer-visible line: the generated method
    // reports the RPC failure in its error branch.
    b.execute.mockResolvedValueOnce({
      ok: false,
      error: { code: 'session-not-found', message: 'gone', details: {} },
    } as never)
    await expect(injected.exitPlanMode()).resolves.toBe('gone (session-not-found)')

    // Unmatched admission (plan-mode not composed host-side) is also a failure line.
    b.execute.mockResolvedValueOnce({ ok: true, value: undefined } as never)
    await expect(injected.exitPlanMode()).resolves.toBe('unknown command: /plan off')

    await fiber.dispose()
  })
})
