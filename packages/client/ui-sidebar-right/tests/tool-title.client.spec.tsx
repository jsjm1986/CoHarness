// @vitest-environment jsdom
/** The tool-details chip resolves the call's name and card from the loaded window. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationNode, ConversationSnapshot, RunningToolCall, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { toolAddress } from '../src/client/tabs/tool/address.ts'
import { toolCallPresentation } from '../src/client/tabs/tool/name.ts'
import { ToolDetailsTitle } from '../src/client/tabs/tool/ToolDetailsTitle.tsx'

const SESSION = 's-tool' as SessionId

function result(callId: string, name: string | null, card?: string, subCalls: ToolCallBlock[] = [], callCard: string | null = 'generic'): ConversationNode {
  return {
    kind: 'tool-result', seq: 1, time: 0, callId,
    call: name === null ? null : { name, argsRaw: '{}' },
    callTime: 0, content: [], isError: false,
    callView: callCard === null ? null : { card: callCard, title: 'call' },
    resultView: card === undefined ? null : { card },
    subCalls,
  } as ConversationNode
}

function running(callId: string, name: string, card?: string, subCalls: ToolCallBlock[] = []): RunningToolCall {
  return {
    phase: 'start', callId, name, turn: 1, step: 1, time: 0,
    argsRaw: '{}', callView: card === undefined ? null : { card, title: 'call' }, subCalls,
  } as RunningToolCall
}

function snapshot(nodes: ConversationNode[], runningCalls: RunningToolCall[] = []): Pick<ConversationSnapshot, 'nodes' | 'runningCalls'> {
  return { nodes, runningCalls }
}

function props(address: string, snap: Pick<ConversationSnapshot, 'nodes' | 'runningCalls'>, title = 'call-9') {
  return {
    sessionId: SESSION,
    useSession: (selector: (snapshot: Pick<ConversationSnapshot, 'nodes' | 'runningCalls'>) => unknown) => selector(snap),
    useTabInfo: () => ({ tab: { title, navigation: { address } } }),
  } as Parameters<typeof ToolDetailsTitle>[0]
}

afterEach(cleanup)

describe('toolCallPresentation', () => {
  it('names a settled call from its call head, and a headless result from its id', () => {
    const snap = snapshot([result('call-1', 'bash', 'terminal'), result('call-2', null)])
    expect(toolCallPresentation(snap, 'call-1')).toEqual({ name: 'bash', card: 'terminal' })
    expect(toolCallPresentation(snap, 'call-2')).toEqual({ name: 'call-2', card: undefined })
  })

  it('finds a running call and a nested sub-call', () => {
    const snap = snapshot(
      [result('call-1', 'read', 'read', [running('call-9', 'bash', 'terminal')])],
      [running('call-7', 'pwsh')],
    )
    expect(toolCallPresentation(snap, 'call-7')).toEqual({ name: 'pwsh', card: undefined })
    expect(toolCallPresentation(snap, 'call-9')).toEqual({ name: 'bash', card: 'terminal' })
  })

  it('reads the settled result card, then the call intent, else nothing', () => {
    const snap = snapshot([result('call-1', 'web_search', 'web')])
    expect(toolCallPresentation(snap, 'call-1')?.card).toBe('web')
  })

  it('ignores generic card marks and skips nodes that are not tool results', () => {
    const snap = snapshot([
      { kind: 'unknown', seq: 1, time: 0, type: 'text', data: null },
      result('call-1', 'bash', 'generic'),
      result('call-2', 'bash', undefined, [], 'terminal'),
      result('call-3', 'bash', undefined, [], null),
    ], [running('call-4', 'bash', 'generic')])
    expect(toolCallPresentation(snap, 'call-1')).toEqual({ name: 'bash', card: undefined })
    expect(toolCallPresentation(snap, 'call-2')).toEqual({ name: 'bash', card: 'terminal' })
    expect(toolCallPresentation(snap, 'call-3')).toEqual({ name: 'bash', card: undefined })
    expect(toolCallPresentation(snap, 'call-4')).toEqual({ name: 'bash', card: undefined })
  })

  it('returns undefined for a call outside the loaded window', () => {
    const withSubtree = snapshot([result('call-1', 'bash', undefined, [running('sub-1', 'read')])])
    expect(toolCallPresentation(withSubtree, 'call-9')).toBeUndefined()
    expect(toolCallPresentation(snapshot([result('call-1', 'bash')]), 'call-9')).toBeUndefined()
  })
})

describe('ToolDetailsTitle', () => {
  it('renders the call intent glyph and the resolved name', () => {
    const view = render(<ToolDetailsTitle {...props(
      toolAddress(SESSION, 'call-9'),
      snapshot([result('call-9', 'bash', 'terminal')]),
    )} />)
    expect(view.container.querySelector('svg')).not.toBeNull()
    expect(view.container.textContent).toBe('bash')
  })

  it.each(['terminal', 'diff', 'search', 'read', 'web'])('draws the %s card glyph', (card) => {
    const view = render(<ToolDetailsTitle {...props(
      toolAddress(SESSION, 'call-9'),
      snapshot([result('call-9', 'bash', card)]),
    )} />)
    expect(view.container.querySelector('svg')).not.toBeNull()
    expect(view.container.textContent).toBe('bash')
  })

  it('keeps the recorded title and generic glyph for a call outside the window or an unreadable address', () => {
    const settled = render(<ToolDetailsTitle {...props(toolAddress(SESSION, 'call-9'), snapshot([]))} />)
    expect(settled.container.querySelector('svg')).not.toBeNull()
    expect(settled.container.textContent).toBe('call-9')
    cleanup()
    const invalid = render(<ToolDetailsTitle {...props('sidebar://guide', snapshot([result('call-9', 'bash')]))} />)
    expect(invalid.container.textContent).toBe('call-9')
  })
})
