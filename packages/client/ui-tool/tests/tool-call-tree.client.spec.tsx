// @vitest-environment jsdom
/** ToolCallTree-owned root/subcall markers and selection projection. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { HostDescription } from '@deepseek-ai/dsh-client-connection/client'
import type { ConversationSnapshot, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ToolTreeProps } from '../src/client/contract/slots.ts'
import { ToolCallTree } from '../src/client/tool/ToolCallTree.tsx'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

afterEach(cleanup)

const t: ToolTreeProps['t'] = makeTranslate(zh, commonZh)

const root = (callId: string, call: ToolResultNode['call']): ToolResultNode => ({
  kind: 'tool-result', seq: 3, time: 3_000, callId, call, callTime: 2_000,
  content: [], isError: false, callView: null, resultView: null, subCalls: [],
})

function props(
  block: ToolResultNode,
  selectedCallId?: string,
  description?: HostDescription,
  useDisclosureReset: ToolTreeProps['useDisclosureReset'] = () => 0,
): ToolTreeProps {
  const snapshot = {} as ConversationSnapshot
  const useSession = ((selector: (value: ConversationSnapshot) => unknown) => selector(snapshot)) as ToolTreeProps['useSession']
  const renderSlot = ((_key: string, _owner: object, options?: { fallback?: React.ReactNode }) =>
    options?.fallback ?? null) as unknown as ToolTreeProps['renderSlot']
  return {
    useSession,
    renderSlot,
    useDisclosureReset,
    node: {
      key: `tool:${block.callId}`,
      kind: 'tool-call',
      id: block.callId,
      target: 'chat',
      anchorSeq: block.seq,
      location: { kind: 'session' },
      visibility: 'visible',
      data: { root: block },
    },
    selectedCallId,
    openFile: vi.fn(),
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    fileMentions: vi.fn(),
    renderMessageImages: () => null,
    useTurnData: () => undefined,
    useDisclosure: () => ({ expanded: false, setExpanded: () => {}, toggle: () => {} }),
    useHostDescription: selector => selector(description),
    SessionProvider: ({ children }) => <>{children('s1' as ToolTreeProps['sessionId'])}</>,
    sessionId: 's1' as ToolTreeProps['sessionId'],
    useSessions: () => { throw new Error('unused') },
    useWorkspaces: () => { throw new Error('unused') },
    usePanelInfo: () => { throw new Error('unused') },
    useProjection: () => undefined,
    useInput: () => { throw new Error('unused') },
    inputActions: {
      setDraft: () => {}, addImages: () => true, removeImage: () => {},
      pruneImages: () => {}, addDocuments: () => true, removeDocument: () => {},
      pruneDocuments: () => {}, captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: () => false, submit: () => {},
    },
    t,
  }
}

describe('ToolCallTree', () => {
  it('owns the root marker, generic fallback, and selected state for a window-truncated call', () => {
    const block = root('w1', null)
    const view = render(<ToolCallTree {...props(block, 'w1')} />)
    const row = view.container.querySelector('[data-chat-call-id="w1"]')
    expect(row?.getAttribute('data-chat-anchor-key')).toBe('call:w1')
    expect(row?.getAttribute('data-selected')).toBe('true')
    expect(view.container.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(view.getByText('w1')).toBeTruthy()
  })

  it('recursively renders a selected leaf without selecting its ancestors', () => {
    const leaf = root('parent:ptc:1:ptc:1', { name: 'read', argsRaw: '{"path":"a.ts"}' })
    const child = {
      ...root('parent:ptc:1', { name: 'run_code', argsRaw: '{"code":"return 1"}' }),
      subCalls: [leaf],
    }
    const block = {
      ...root('parent', { name: 'run_code', argsRaw: '{"code":"return 1"}' }),
      subCalls: [child],
    }
    const view = render(<ToolCallTree {...props(block, leaf.callId)} />)
    const nests = view.container.querySelectorAll('[data-subcalls]')
    expect(nests[0]?.parentElement).toBe(view.container.querySelector('[data-chat-call-id="parent"]'))
    expect(nests[1]?.parentElement).toBe(view.container.querySelector('[data-chat-call-id="parent:ptc:1"]'))
    expect(view.container.querySelector('[data-chat-call-id="parent"]')?.hasAttribute('data-selected')).toBe(false)
    expect(view.container.querySelector('[data-chat-call-id="parent:ptc:1"]')?.hasAttribute('data-selected')).toBe(false)
    expect(view.container.querySelector('[data-chat-call-id="parent:ptc:1:ptc:1"]')?.getAttribute('data-selected')).toBe('true')
    expect(nests).toHaveLength(2)
  })

  it('collapses root and nested call disclosures when the seat generation advances', () => {
    const leaf = root('parent:ptc:1', { name: 'bash', argsRaw: '{"command":"ls"}' })
    const block = {
      ...root('parent', { name: 'run_code', argsRaw: '{"code":"return 1"}' }),
      subCalls: [leaf],
    }
    let generation = 0
    const treeProps = props(block, undefined, undefined, () => generation)
    const view = render(<ToolCallTree {...treeProps} />)
    const rowOf = (callId: string): HTMLElement =>
      view.container.querySelector(`[data-chat-call-id="${callId}"] [data-disclosure-row]`) as HTMLElement
    const rootRow = rowOf('parent')
    const leafRow = rowOf('parent:ptc:1')
    fireEvent.click(rootRow)
    fireEvent.click(leafRow)
    expect(rootRow.getAttribute('aria-expanded')).toBe('true')
    expect(leafRow.getAttribute('aria-expanded')).toBe('true')

    // A fold bumps the seat generation; mounted cells keep their record but it
    // no longer matches, so both levels read collapsed without unmounting.
    generation = 1
    view.rerender(<ToolCallTree {...treeProps} />)
    expect(rootRow.getAttribute('aria-expanded')).toBe('false')
    expect(leafRow.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-chat-call-id="parent:ptc:1"]')).not.toBeNull()
  })

  it('abbreviates a POSIX home path in the generic tool summary', () => {
    const block = root('w1', { name: 'read', argsRaw: '{"path":"/h/docs/a.ts"}' })
    const view = render(<ToolCallTree {...props(block, 'w1', {
      version: '0', cwd: '/tmp', attachedSessions: 0, home: '/h', canOpenPath: false,
    })} />)
    expect(view.getByText('~/docs/a.ts')).toBeTruthy()
  })
})
