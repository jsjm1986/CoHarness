// @vitest-environment jsdom
/** Cancellable independent Tool details reject stale results and expose failed reads. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, ToolCallBlock, SessionId, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { DetailsSlotProps } from '../src/client/contract/slots.ts'
import { DetailsPanel } from '../src/client/skeleton/DetailsPanel.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

afterEach(cleanup)
const SID = 'detail-session' as SessionId
function props(readCall: DetailsSlotProps['readCall']): DetailsSlotProps {
  const snapshot: ConversationSnapshot = {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: true, loadingOlder: false, historyWindowMode: 'tail', historyDetail: 'full', promptError: null, blank: false, subagent: null, lastAgentError: null,
  }
  return {
    sessionId: SID, callId: 'first', readCall, closeDetails: vi.fn(), t: makeTranslate(en, commonEn),
    loadImage: Object.assign(
      () => Promise.reject(new Error('no attachment store in test')),
      { peek: () => undefined },
    ),
    SessionProvider: ({ children }) => children(SID),
    useSession: bindSnapshotSelector(createSnapshotStore(snapshot)),
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>({ ids: [], byId: {}, archivedById: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore<WorkspaceListState>({ items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined })),
    useProjection: () => undefined,
    useInput: () => { throw new Error('unused') },
    inputActions: {
      setDraft: () => {}, addImages: () => true, removeImage: () => {}, pruneImages: () => {},
      addDocuments: () => true, removeDocument: () => {}, pruneDocuments: () => {}, submit: () => {},
    },
    renderSlot: vi.fn((_name: string, _owner: unknown, options?: { fallback?: unknown }) => options?.fallback ?? null) as never,
  }
}
function result(callId: string, text: string): ToolCallBlock {
  return { kind: 'tool-result', seq: 3, time: 3, callId, call: { name: callId, argsRaw: '{}' },
    callTime: 2, content: [{ type: 'text', text }], isError: false, callView: null, resultView: null, subCalls: [] }
}

describe('independent Tool details', () => {
  it('defers hidden reads and aborts pending content when the tab becomes hidden', async () => {
    const pending = Promise.withResolvers<ToolCallBlock>()
    const readCall = vi.fn((_id: string, _signal: AbortSignal) => pending.promise)
    const base = props(readCall)
    const view = render(<DetailsPanel {...base} readEnabled={false} />)
    expect(readCall).not.toHaveBeenCalled()
    view.rerender(<DetailsPanel {...base} readEnabled />)
    expect(readCall).toHaveBeenCalledOnce()
    view.rerender(<DetailsPanel {...base} readEnabled={false} />)
    expect(readCall.mock.calls[0]![1].aborted).toBe(true)
    await act(async () => { pending.resolve(result('first', 'hidden late data')); await pending.promise })
    expect(view.queryByText('hidden late data')).toBeNull()
  })

  it('rejects a late response from a previous call and aborts on unmount', async () => {
    const first = Promise.withResolvers<ToolCallBlock>()
    const second = Promise.withResolvers<ToolCallBlock>()
    const readCall = vi.fn((callId: string, _signal: AbortSignal) => callId === 'first' ? first.promise : second.promise)
    const base = props(readCall)
    const view = render(<DetailsPanel {...base} />)
    expect(view.getByText('Loading call details…')).toBeTruthy()
    view.rerender(<DetailsPanel {...base} callId="second" />)
    expect(readCall.mock.calls[0]![1].aborted).toBe(true)
    await act(async () => { second.resolve(result('second', 'current output')); await second.promise })
    expect(view.getByText('current output')).toBeTruthy()
    await act(async () => { first.resolve(result('first', 'private old output')); await first.promise })
    expect(view.queryByText('private old output')).toBeNull()
    view.unmount()
    expect(readCall.mock.calls[1]![1].aborted).toBe(true)
  })

  it('shows a rejected read as an error and retries without treating it as missing', async () => {
    const readCall = vi.fn<DetailsSlotProps['readCall']>().mockRejectedValueOnce(new Error('Access revoked')).mockResolvedValueOnce(result('first', 'allowed output'))
    const view = render(<DetailsPanel {...props(readCall)} />)
    expect((await view.findByRole('alert')).textContent).toBe('Access revoked')
    expect(view.queryByText('This call was not found in the Session log')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Retry read' }))
    expect(await view.findByText('allowed output')).toBeTruthy()
    expect(readCall).toHaveBeenCalledTimes(2)
  })

  it('routes the details tool gallery through the sibling images slot with the session loader', async () => {
    const readCall = vi.fn<DetailsSlotProps['readCall']>().mockResolvedValue(result('first', 'out'))
    const base = props(readCall)
    const view = render(<DetailsPanel {...base} />)
    await view.findByText('out')
    const renderSlot = base.renderSlot as ReturnType<typeof vi.fn>
    const toolCall = renderSlot.mock.calls.find(call => call[0] === 'conversation.details.tool')
    const owner = toolCall?.[1] as { renderMessageImages?: (owner: { images: unknown[] }) => unknown }
    expect(owner?.renderMessageImages).toBeTypeOf('function')
    // The owner-side renderer dispatches the sibling seat, carrying the panel's
    // session-authorized loader into the attachment presentation plugin.
    owner?.renderMessageImages?.({ images: [] })
    const imageCall = renderSlot.mock.calls.find(call => call[0] === 'conversation.details.images')
    expect(imageCall?.[1]).toMatchObject({ images: [], loadImage: base.loadImage })
  })
})
