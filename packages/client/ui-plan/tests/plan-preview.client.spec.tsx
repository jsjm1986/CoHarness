// @vitest-environment jsdom
/**
 * Plan transcript cards and Sidebar previews: cards open the exact logged
 * plan, a pending review opens automatically once a Session is on screen and
 * keeps a manual opener after the user closes it, and the tab body renders
 * logged or temporary Markdown with localized loading and failure states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { TurnLocation } from '@deepseek-ai/dsh-client-runtime/client'
import type { PlanReview } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PlanCards, PlanReviewOpen } from '../src/client/PlanCard.tsx'
import { PlanPreview, PlanTitle } from '../src/client/PlanPreview.tsx'
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

describe('PlanReviewOpen', () => {
  const review: PlanReview = {
    id: 'q-1', question: 'approve?', plan: '# Under review',
    approve: { label: 'Approve' },
  }

  function setup(options: {
    preopened?: readonly string[]
    mounted?: SessionId | undefined
    reaches?: boolean
  } = {}) {
    const { preopened = [], reaches = true } = options
    const mounted = 'mounted' in options ? options.mounted : ('s-1' as SessionId)
    const mountedStore = createSnapshotStore<SessionId | undefined>(mounted)
    const openReview = vi.fn(() => reaches)
    const store = createPlanReviewStore().create('s-1')
    for (const identity of preopened) store.actions.markOpened(identity)
    const useSidebarMounted = bindSnapshotSelector(mountedStore) as never
    const useStore = bindSnapshotSelector(store) as never
    const view = render(<PlanReviewOpen
      {...sessionStandard()}
      review={review} requestKey="req-1"
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
  it('replaces the registry label with the recovered plan heading', async () => {
    const address = 'dsh-resource://plan/s-1/c-1'
    const state = createSnapshotStore<Record<string, PlanRead | undefined>>({
      [address]: { status: 'ready', plan: PLAN },
    })
    const info = {
      sidebar: { expanded: true, fullscreen: false }, panel: { id: 'p1' },
      tab: {
        id: 't1', kind: 'plan', contentId: address, title: '计划', visible: true,
        navigation: { address, params: undefined, revision: 1 },
        signal: new AbortController().signal, actions: {},
      },
    }
    render(<PlanTitle
      {...sessionStandard()}
      useTabInfo={(() => info) as never}
      usePlanDocument={bindSnapshotSelector(state) as never}
      loadPlan={vi.fn(async () => {})} />)
    expect(await screen.findByText('Draft plan')).toBeTruthy()
  })
})
