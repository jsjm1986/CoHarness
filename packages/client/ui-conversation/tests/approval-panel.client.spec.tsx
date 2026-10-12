// @vitest-environment jsdom
// ApprovalPanel headline resolution: the asker's displayReason localizes the
// prompt while the audited reason stays English; without one the raw reason
// renders, and with neither the tool-name escalation fallback renders.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS, PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
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

function mount(payload: ApprovalWait['payload'], resolveReason: ApprovalComposerProps['resolveReason'] = reason => reason.zh ?? reason.en) {
  const matched = new PendingWait('approval', RpcId(`a-${payload.approvalId}`), SID, payload, vi.fn())
  const props = {
    matched,
    resolveReason,
    t,
    useSession: bindSnapshotSelector(createSnapshotStore(snapshotOf())),
    useSessions: bindSnapshotSelector(createSnapshotStore({ phase: 'ready' })),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({ phase: 'ready' })),
    usePanelInfo: bindSnapshotSelector(createSnapshotStore({ activePanelId: null })),
    useStore: bindSnapshotSelector(createSnapshotStore({})),
    renderSlot: () => null,
  } as unknown as ApprovalComposerProps
  return render(<ApprovalPanel {...props} />)
}

afterEach(() => { cleanup() })

describe('ApprovalPanel headline', () => {
  it('resolves a displayReason map through the injected locale resolver', () => {
    mount({
      approvalId: 'ap1', toolName: 'bash',
      reason: 'Auto review denied tool "bash"',
      displayReason: { en: 'Auto review denied this call.', zh: 'Auto review 拒绝了此调用。' },
    } as unknown as ApprovalWait['payload'])
    expect(screen.getByText('Auto review 拒绝了此调用。')).toBeTruthy()
    expect(screen.queryByText('Auto review denied tool "bash"')).toBeNull()
  })

  it('renders the audited reason verbatim without a displayReason', () => {
    mount({ approvalId: 'ap2', toolName: 'bash', reason: 'sandbox escalation' } as unknown as ApprovalWait['payload'])
    expect(screen.getByText('sandbox escalation')).toBeTruthy()
  })

  it('falls back to the escalation copy with neither reason', () => {
    mount({ approvalId: 'ap3', toolName: 'bash' } as unknown as ApprovalWait['payload'])
    expect(screen.getByText(/bash/)).toBeTruthy()
  })
})
