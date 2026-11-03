// @vitest-environment jsdom
// ApprovalPanel headline resolution: the asker's displayReason localizes the
// prompt while the audited reason stays English; without one the raw reason
// renders, and with neither the tool-name escalation fallback renders.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { conversationContextKey, createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS, PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatConversationViewNode, ConversationSnapshot, RunningToolCall, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ApprovalPanel } from '../src/client/skeleton/ApprovalPanel.tsx'
import type { ApprovalComposerProps, ApprovalWait } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'

const SID = 's1' as SessionId
const t = makeTranslate(zh, commonZh)

function snapshotOf(): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), openTurn: undefined, partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false, historyWindowMode: 'tail', historyDetail: 'full',
    promptError: null, blank: false, subagent: null, lastAgentError: null,
  }
}

function mount(payload: ApprovalWait['payload'], resolveReason: ApprovalComposerProps['resolveReason'] = reason => reason.zh ?? reason.en,
  snapshot = snapshotOf(), respond = vi.fn<ConstructorParameters<typeof PendingWait<'approval'>>[4]>(async () => ({ accepted: true }))) {
  const matched = new PendingWait('approval', RpcId(`a-${payload.approvalId}`), SID, payload, respond)
  const props = {
    matched,
    resolveReason,
    t,
    useSession: bindSnapshotSelector(createSnapshotStore(snapshot)),
    useSessions: bindSnapshotSelector(createSnapshotStore({ phase: 'ready' })),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({ phase: 'ready' })),
    usePanelInfo: bindSnapshotSelector(createSnapshotStore({ activePanelId: null })),
    useStore: bindSnapshotSelector(createSnapshotStore({})),
    renderSlot: () => null,
  } as never as ApprovalComposerProps
  return { ...render(<ApprovalPanel {...props} />), respond }
}

function withCall(name: string, argsRaw: string): ConversationSnapshot {
  const call: RunningToolCall = { phase: 'start', callId: 'call-1', name, argsRaw, turn: 1, step: 1, time: 0, callView: null, subCalls: [] }
  const node: ChatConversationViewNode = {
    key: conversationContextKey('tool-call', call.callId), id: call.callId, kind: 'tool-call', target: 'chat',
    anchorSeq: 0, location: { kind: 'session' }, visibility: 'visible', data: { root: call },
  }
  return { ...snapshotOf(), chat: { ...EMPTY_CHAT_SNAPSHOT, nodes: {
    get: key => key === node.key ? node : undefined, values: () => [node],
  } } }
}

afterEach(() => { cleanup() })

describe('ApprovalPanel headline', () => {
  it('keeps the tool and non-shell arguments visible without changing the submitted decision', async () => {
    const { respond } = mount({ approvalId: 'ap-write', toolName: 'write', callId: 'call-1', reason: 'Needs access' } as never,
      undefined, withCall('write', '{"path":"/workspace/notes.txt","content":"hello"}'))
    expect(screen.getByText(t('approval.escalation', { toolName: 'write' }))).toBeTruthy()
    expect(screen.getByText('Needs access')).toBeTruthy()
    expect(screen.getByLabelText(zh['approval.arguments']).textContent).toContain('"path": "/workspace/notes.txt"')
    fireEvent.click(screen.getByRole('button', { name: zh['approval.allowOnce'] }))
    await waitFor(() => { expect(respond).toHaveBeenCalledOnce() })
    expect(respond).toHaveBeenCalledWith({ type: 'client-response', rpcId: 'a-ap-write', result: {
      ok: true, value: { sessionId: SID, approvalId: 'ap-write', outcome: 'allowed-once' },
    } })
  })

  it('keeps malformed arguments inspectable and shell commands readable', () => {
    mount({ approvalId: 'ap-raw', toolName: 'write', callId: 'call-1' } as never, undefined, withCall('write', '{incomplete'))
    expect(screen.getByLabelText(zh['approval.arguments']).textContent).toBe('{incomplete')
    cleanup()
    mount({ approvalId: 'ap-shell', toolName: 'bash', callId: 'call-1' } as never, undefined, withCall('bash', '{"command":"echo hello"}'))
    expect(screen.getByText('echo hello')).toBeTruthy()
  })

  it('reports a failed decision and retries only after another user click', async () => {
    const respond = vi.fn<ConstructorParameters<typeof PendingWait<'approval'>>[4]>()
      .mockResolvedValueOnce({ accepted: false, reason: 'not-pending' }).mockResolvedValueOnce({ accepted: true })
    mount({ approvalId: 'ap-retry', toolName: 'bash' } as never, undefined, snapshotOf(), respond)
    const allow = screen.getByRole('button', { name: zh['approval.allowOnce'] })
    fireEvent.click(allow)
    expect((await screen.findByRole('alert')).textContent).toBe(zh['approval.failed'])
    expect(allow.hasAttribute('disabled')).toBe(false)
    expect(respond).toHaveBeenCalledOnce()
    fireEvent.click(allow)
    await waitFor(() => { expect(respond).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('resolves a displayReason map through the injected locale resolver', () => {
    mount({
      approvalId: 'ap1', toolName: 'bash',
      reason: 'Auto review denied tool "bash"',
      displayReason: { en: 'Auto review denied this call.', zh: 'Auto review 拒绝了此调用。' },
    } as never)
    expect(screen.getByText('Auto review 拒绝了此调用。')).toBeTruthy()
    expect(screen.queryByText('Auto review denied tool "bash"')).toBeNull()
  })

  it('renders the audited reason verbatim without a displayReason', () => {
    mount({ approvalId: 'ap2', toolName: 'bash', reason: 'sandbox escalation' } as never)
    expect(screen.getByText('sandbox escalation')).toBeTruthy()
  })

  it('falls back to the escalation copy with neither reason', () => {
    mount({ approvalId: 'ap3', toolName: 'bash' } as never)
    expect(screen.getByText(/bash/)).toBeTruthy()
  })
})
