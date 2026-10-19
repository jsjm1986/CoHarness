// @vitest-environment jsdom
/**
 * Plan transcript cards and Sidebar previews: cards open the exact logged
 * plan, a pending review opens automatically once a Session is on screen and
 * keeps a manual opener after the user closes it, and the tab body renders
 * logged or temporary Markdown with localized loading and failure states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler, useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {
  ChatNodeStore, ChatSnapshot, ConversationSnapshot, QueuedMessage, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { PlanReview } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PlanCards, PlanReviewOpen } from '../src/client/PlanCard.tsx'
import { PlanPreview, PlanTitle } from '../src/client/PlanPreview.tsx'
import { plansSourceFor } from '../src/client/plan-definition.ts'
import type { PlanRead } from '../src/client/plan-resource.ts'
import { reviewPreviewAddress } from '../src/client/review-preview.ts'
import { createPlanReviewStore } from '../src/client/review-store.ts'
import type { SubmittedPlan } from '../src/client/plan.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as never

const PLAN: SubmittedPlan = { callId: 'c-1' as ToolCallId, markdown: '# Draft plan\nbody', title: 'Draft plan' }

function turn(number: number): TurnLocation {
  return { turn: number, status: 'closed' } as Partial<TurnLocation> as TurnLocation
}

/** Keyed-hook double over a static value: `(key, selector?, equal?)` with no re-render plumbing. */
function keyedValue(value: unknown) {
  return ((_key: string, selector?: (next: unknown) => unknown) =>
    selector === undefined ? value : selector(value)) as never
}

/** Framework-supplied standard kit (global + session), faked for direct renders. */
function sessionStandard() {
  const staticHook = bindSnapshotSelector({ getSnapshot: () => ({}), subscribe: () => () => {} })
  return {
    sessionId: 's-1' as SessionId,
    useSession: staticHook as never,
    useProjection: (() => undefined) as never,
    useInput: staticHook as never,
    inputActions: {} as never,
    useSessions: staticHook as never,
    useWorkspaces: staticHook as never,
    usePanelInfo: (() => ({})) as never,
  }
}

describe('PlanCards', () => {
  function setup(plans: readonly SubmittedPlan[] = [PLAN]) {
    const openPlan = vi.fn()
    const view = render(<PlanCards
      {...sessionStandard()}
      turn={turn(1)} seq={10} openFile={() => {}}
      usePlans={keyedValue(plans)} openPlan={openPlan} t={t} />)
    return { openPlan, view }
  }

  it('renders one card per invocation and opens its exact call', () => {
    const { openPlan } = setup([PLAN, { ...PLAN, callId: 'c-2' as ToolCallId, title: 'Second' }])
    fireEvent.click(screen.getByRole('button', { name: '打开计划：Draft plan' }))
    expect(openPlan).toHaveBeenCalledWith('c-1')
    fireEvent.click(screen.getByRole('button', { name: '打开计划：Second' }))
    expect(openPlan).toHaveBeenCalledWith('c-2')
  })

  it('renders nothing for a Turn without plans', () => {
    const { view } = setup([])
    expect(view.container.innerHTML).toBe('')
  })
})

describe('PlanCards isolation', () => {
  function planNode(seq: number, plan: SubmittedPlan, turnNumber = 1): ChatNode<'submitted-plan'> {
    return {
      key: `plan:${plan.callId}`,
      id: plan.callId,
      target: 'chat',
      kind: 'submitted-plan',
      anchorSeq: seq,
      location: { kind: 'turn', turn: turn(turnNumber) },
      visibility: 'hidden',
      data: plan,
    }
  }

  function chatWith(nodes: ChatNodeStore): ChatSnapshot {
    return {
      order: [], entries: [], nodes,
      locations: { getTurn: () => [], getStep: () => [] },
      groups: { get: () => undefined },
      navigation: { items: () => [] },
      timeline: { turnOrder: [], turns: new Map() },
      legacy: { nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
    }
  }

  function nodeStore(list: readonly ChatNode<'submitted-plan'>[]): ChatNodeStore {
    const byKey = new Map(list.map(node => [node.key, node]))
    return { get: key => byKey.get(key), values: () => [...byKey.values()] }
  }

  function sessionStore(nodes: readonly ChatNode<'submitted-plan'>[]) {
    return createSnapshotStore<ConversationSnapshot>({
      chat: chatWith(nodeStore(nodes)),
    } as ConversationSnapshot)
  }

  it('republishes a stable plan list through unrelated session commits', () => {
    const plan = planNode(3, PLAN)
    const store = sessionStore([plan])
    const source = plansSourceFor(store, 1)
    const first = source.getSnapshot()
    expect(first).toEqual([PLAN])
    // Unrelated commits (running flag, queue churn, a fresh snapshot object):
    // the derived list keeps its identity, so card subscribers never repaint.
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        store.set({
          ...store.getSnapshot(),
          running: i % 2 === 0,
          queue: [{
            id: `q-${i}` as QueuedMessage['id'],
            messageId: `m-q-${i}` as QueuedMessage['messageId'],
            placement: 'queued', content: [], preview: `q-${i}`, text: `q-${i}`,
          }],
        })
      })
      expect(source.getSnapshot()).toBe(first)
    }
    // A real plan change republishes exactly once.
    const second = { ...PLAN, callId: 'c-2' as ToolCallId, title: 'Second' }
    act(() => { store.set({ ...store.getSnapshot(), chat: chatWith(nodeStore([plan, planNode(4, second)])) }) })
    const republished = source.getSnapshot()
    expect(republished).not.toBe(first)
    expect(republished).toEqual([PLAN, second])
    // ...and stays stable through the next unrelated commit.
    act(() => { store.set({ ...store.getSnapshot(), running: true }) })
    expect(source.getSnapshot()).toBe(republished)
  })

  it('does not re-render the cards when an unrelated session field moves', () => {
    const plan = planNode(3, PLAN)
    const store = sessionStore([plan])
    const source = plansSourceFor(store, 1)
    // Mirror of the renderer's keyedHooks binding: one uSES subscription over
    // the keyed source, identity selector. The Profiler commit count measures
    // the card subtree itself — the subscription lives inside PlanCards.
    const usePlans = ((_key: string) => useSyncExternalStore(
      onStoreChange => source.subscribe(onStoreChange),
      () => source.getSnapshot(),
    )) as never
    let commits = 0
    render(
      <Profiler id="plan-cards" onRender={() => { commits += 1 }}>
        <PlanCards
          {...sessionStandard()}
          turn={turn(1)} seq={10} openFile={() => {}}
          usePlans={usePlans} openPlan={() => {}} t={t} />
      </Profiler>,
    )
    expect(commits).toBe(1)
    act(() => { store.set({ ...store.getSnapshot(), running: true }) })
    act(() => {
      store.set({
        ...store.getSnapshot(),
        chat: { ...store.getSnapshot().chat, order: ['other:node'] },
      })
    })
    expect(commits).toBe(1)
    // A plan entering the Turn republishes and repaints exactly once.
    act(() => {
      store.set({
        ...store.getSnapshot(),
        chat: chatWith(nodeStore([plan, planNode(4, { ...PLAN, callId: 'c-2' as ToolCallId, title: 'Second' })])),
      })
    })
    expect(commits).toBe(2)
    expect(screen.getByRole('button', { name: '打开计划：Second' })).toBeTruthy()
  })
})

describe('PlanReviewOpen', () => {
  const review: PlanReview = {
    id: 'q-1', question: 'approve?', plan: '# Under review',
    approve: { label: 'Approve' },
  }

  function setup(options: {
    preopened?: readonly string[]
    mounted?: SessionId | undefined
    reaches?: boolean
    review?: PlanReview
  } = {}) {
    const { preopened = [], reaches = true } = options
    const given = options.review ?? review
    const mounted = 'mounted' in options ? options.mounted : ('s-1' as SessionId)
    const mountedStore = createSnapshotStore<SessionId | undefined>(mounted)
    const openReview = vi.fn(() => reaches)
    const store = createPlanReviewStore().create('s-1')
    for (const identity of preopened) store.actions.markOpened(identity)
    const useSidebarMounted = bindSnapshotSelector(mountedStore) as never
    const useStore = bindSnapshotSelector(store) as never
    const view = render(<PlanReviewOpen
      {...sessionStandard()}
      review={given} requestKey="req-1"
      openReview={openReview} useSidebarMounted={useSidebarMounted} useStore={useStore} actions={store.actions} t={t} />)
    return { openReview, store, mountedStore, view }
  }

  it('opens automatically once a Session is mounted and keeps a manual opener', async () => {
    const { openReview } = setup()
    await waitFor(() => { expect(openReview).toHaveBeenCalledWith(review, 'req-1') })
    expect(openReview).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: zh['preview.open'] }))
    expect(openReview).toHaveBeenCalledTimes(2)
  })

  it('waits for a mounted Session before the automatic open', async () => {
    const { openReview, view } = setup({ mounted: undefined })
    await Promise.resolve()
    expect(openReview).not.toHaveBeenCalled()
    view.unmount()
  })

  it('retries the automatic open until one reaches the seat', async () => {
    const { openReview, store, mountedStore } = setup({ mounted: undefined })
    await Promise.resolve()
    expect(openReview).not.toHaveBeenCalled()
    act(() => { mountedStore.set('s-1' as SessionId) })
    await waitFor(() => { expect(openReview).toHaveBeenCalled() })
    expect(store.getSnapshot().opened['review:req-1']).toBe(true)
  })

  it('leaves the review pending while the open cannot reach a seat', async () => {
    const { openReview, store } = setup({ reaches: false })
    await waitFor(() => { expect(openReview).toHaveBeenCalled() })
    expect(store.getSnapshot().opened['review:req-1']).toBeUndefined()
  })

  it('does not reopen a review the user already dismissed', async () => {
    const { openReview } = setup({ preopened: ['review:req-1'] })
    await Promise.resolve()
    expect(openReview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['preview.open'] }))
    expect(openReview).toHaveBeenCalledWith(review, 'req-1')
  })

  it('keys the opened mark by the logged call identity when one exists', async () => {
    const logged: PlanReview = { ...review, callId: 'c-7' as ToolCallId }
    const { store } = setup({ review: logged })
    await waitFor(() => { expect(store.getSnapshot().opened['call:c-7']).toBe(true) })
  })
})

describe('PlanPreview', () => {
  function tabInfo(address: string, params?: { planReview: { markdown: string; title: string } }) {
    return {
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'p1' },
      tab: {
        id: 't1', kind: 'plan', contentId: address, title: '计划', visible: true,
        navigation: { address, params, revision: 1 },
        signal: new AbortController().signal,
        actions: {},
      },
    }
  }

  function setup(
    address: string,
    reads: Record<string, PlanRead | undefined>,
    params?: { planReview: { markdown: string; title: string } },
  ) {
    const state = createSnapshotStore<Record<string, PlanRead | undefined>>(reads)
    const loadPlan = vi.fn((next: string) => {
      state.update((draft) => { if (draft[next] === undefined) draft[next] = { status: 'loading' } })
      return Promise.resolve()
    })
    const useTabInfo = (() => tabInfo(address, params)) as never
    const usePlanDocument = bindSnapshotSelector(state) as never
    const view = render(<PlanPreview
      {...sessionStandard()}
      useTabInfo={useTabInfo} usePlanDocument={usePlanDocument} loadPlan={loadPlan} t={t} />)
    return { state, loadPlan, view }
  }

  it('loads a logged plan and renders its Markdown', async () => {
    const { state } = setup('dsh-resource://plan/s-1/c-1', {})
    await waitFor(() => { expect(state.getSnapshot()['dsh-resource://plan/s-1/c-1']).toBeDefined() })
    state.update((draft) => { draft['dsh-resource://plan/s-1/c-1'] = { status: 'ready', plan: PLAN } })
    expect(await screen.findByText('body')).toBeTruthy()
    expect(document.querySelector('[data-plan-preview="c-1"]')).not.toBeNull()
  })

  it('shows loading, then a localized failure line', async () => {
    const { state } = setup('dsh-resource://plan/s-1/c-1', {})
    expect(screen.getByText(zh['preview.loading'])).toBeTruthy()
    state.update((draft) => {
      draft['dsh-resource://plan/s-1/c-1'] = { status: 'failed', failure: { code: 'plan/not-found', message: 'wire' } }
    })
    expect(await screen.findByText(zh['preview.failed'])).toBeTruthy()
    expect(screen.getByText(zh['preview.notFound'])).toBeTruthy()
  })

  it('renders a temporary review document from navigation params', () => {
    const address = reviewPreviewAddress('s-1' as SessionId, 'w:req-1')
    setup(address, {}, { planReview: { markdown: '# Pending\napprove?', title: 'Pending' } })
    expect(screen.getByText('approve?')).toBeTruthy()
  })

  it('shows the expired state when a restored review lost its params', () => {
    const address = reviewPreviewAddress('s-1' as SessionId, 'w:req-1')
    setup(address, {})
    expect(screen.getByText(zh['preview.expired'])).toBeTruthy()
  })
})

describe('PlanTitle', () => {
  function setup(address: string, params?: { planReview: { markdown: string; title: string } }) {
    const state = createSnapshotStore<Record<string, PlanRead | undefined>>({})
    const loadPlan = vi.fn(async (_address: string) => {})
    const info = {
      sidebar: { expanded: true, fullscreen: false }, panel: { id: 'p1' },
      tab: {
        id: 't1', kind: 'plan', contentId: address, title: '计划', visible: true,
        navigation: { address, params, revision: 1 },
        signal: new AbortController().signal, actions: {},
      },
    }
    render(<PlanTitle
      {...sessionStandard()}
      useTabInfo={(() => info) as never}
      usePlanDocument={bindSnapshotSelector(state) as never}
      loadPlan={loadPlan} />)
    return { state, loadPlan }
  }

  it('replaces the registry label with the recovered plan heading', async () => {
    const address = 'dsh-resource://plan/s-1/c-1'
    const { state } = setup(address)
    act(() => {
      state.update((draft) => { draft[address] = { status: 'ready', plan: PLAN } })
    })
    expect(await screen.findByText('Draft plan')).toBeTruthy()
  })

  it('requests the logged plan and falls back to the tab label while it loads', async () => {
    const address = 'dsh-resource://plan/s-1/missing'
    const { loadPlan } = setup(address)
    await waitFor(() => { expect(loadPlan).toHaveBeenCalledWith(address) })
    expect(screen.getByText('计划')).toBeTruthy()
  })

  it('reads a temporary review heading from navigation params and never loads', async () => {
    const address = reviewPreviewAddress('s-1' as SessionId, 'w:req-1')
    const { loadPlan } = setup(address, { planReview: { markdown: '# Pending', title: 'Pending' } })
    expect(await screen.findByText('Pending')).toBeTruthy()
    await Promise.resolve()
    expect(loadPlan).not.toHaveBeenCalled()
  })

  it('keeps the tab label when a restored review lost its params', async () => {
    const address = reviewPreviewAddress('s-1' as SessionId, 'w:req-1')
    setup(address)
    expect(await screen.findByText('计划')).toBeTruthy()
  })
})
