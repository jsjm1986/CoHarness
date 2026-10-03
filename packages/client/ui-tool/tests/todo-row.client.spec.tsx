// @vitest-environment jsdom
/** todo_write atomic Tool presentation and its plan-summary model. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { UseDisclosure } from '../src/client/contract/slots.ts'
import type { ConversationSnapshot, TodoItem, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TodoRow, todoToolview } from '../src/client/tool/toolviews/todo-row.tsx'
import { planSummary } from '../src/client/tool/toolviews/plan-summary.ts'
import { CONVERSATION_NS as NS } from '../src/client/locale.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

type TodoRowProps = Parameters<typeof TodoRow>[0]

const t: TodoRowProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

const LIST: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

const PARALLEL: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '跑后台构建', status: 'in_progress' },
  { content: '读源码', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

const useDisclosure: UseDisclosure = () => {
  const [expanded, setExpanded] = useState(false)
  return { expanded, setExpanded, toggle: () => { setExpanded(value => !value) } }
}

describe('planSummary', () => {
  it('counts done/total and names the single active item with no extra count', () => {
    expect(planSummary(LIST)).toEqual({ done: 1, total: 3, activeContent: '写组件', activeExtra: 0 })
  })

  it('reports the extra active count separately when several items are in progress', () => {
    expect(planSummary(PARALLEL)).toEqual({ done: 1, total: 5, activeContent: '写组件', activeExtra: 2 })
  })

  it('has no hint when nothing is in progress', () => {
    expect(planSummary([{ content: '都完了', status: 'completed' }]))
      .toEqual({ done: 1, total: 1, activeContent: null, activeExtra: 0 })
  })

  it('has no hint when the first active item carries no usable content', () => {
    expect(planSummary([{ status: 'in_progress' }, { content: 'x', status: 'in_progress' }]))
      .toMatchObject({ activeContent: null, activeExtra: 0 })
    expect(planSummary([{ content: 42, status: 'in_progress' }]).activeContent).toBeNull()
    expect(planSummary([{ content: '', status: 'in_progress' }]).activeContent).toBeNull()
    expect(planSummary([{ content: '   ', status: 'in_progress' }, { content: 'x', status: 'in_progress' }]))
      .toMatchObject({ activeContent: null, activeExtra: 0 })
  })

  it('is empty-safe', () => {
    expect(planSummary([])).toEqual({ done: 0, total: 0, activeContent: null, activeExtra: 0 })
  })
})

const resultNode = (argsRaw: string, over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callTime: 1_000, callId: 'c1',
  call: { name: 'todo_write', argsRaw },
  content: [], isError: false, callView: null, resultView: null, subCalls: [], ...over,
})

function rowProps(block: unknown): TodoRowProps {
  const snapshot = {
    views: { get: () => undefined },
    hasMore: false,
  } as unknown as ConversationSnapshot
  return {
    callId: 'c1', toolName: 'todo_write', block,
    openFile: vi.fn(),
    sessionId: 's1',
    useSessions: () => undefined,
    useSession: ((selector: (value: ConversationSnapshot) => unknown) => selector(snapshot)) as TodoRowProps['useSession'],
    t, useDisclosure,
  } as unknown as TodoRowProps
}

describe('TodoRow', () => {
  const ARGS = JSON.stringify({ todos: LIST })

  it('summarizes counts and the active item from the call args', () => {
    render(<TodoRow {...rowProps(resultNode(ARGS))} />)
    expect(screen.getByText('更新任务清单')).toBeTruthy()
    expect(screen.getByText('1/3 已完成 · 写组件')).toBeTruthy()
  })

  it('reports the extra active count outside the ellipsized summary text', () => {
    const { container } = render(<TodoRow {...rowProps(resultNode(JSON.stringify({ todos: PARALLEL })))} />)
    const text = screen.getByText('1/5 已完成 · 写组件')
    const extra = screen.getByText('+2')
    expect(text.contains(extra)).toBe(false)
    expect(container.textContent).toContain('1/5 已完成 · 写组件+2')
  })

  it('omits the active clause when no item is in progress and reads running-call args', () => {
    const args = JSON.stringify({ todos: [{ content: 'x', status: 'completed' }] })
    render(<TodoRow {...rowProps({ phase: 'start', callId: 'c1', name: 'todo_write', argsRaw: args, turn: 1, step: 1, time: 1_000, callView: null })} />)
    expect(screen.getByText('1/1 已完成')).toBeTruthy()
  })

  it('keeps the counts when an active item has unusable content', () => {
    const args = JSON.stringify({ todos: [{ content: 'done', status: 'completed' }, { content: 42, status: 'in_progress' }] })
    const { container } = render(<TodoRow {...rowProps(resultNode(args))} />)
    expect(screen.getByText('1/2 已完成')).toBeTruthy()
    expect(container.textContent).not.toContain('+')
  })

  it('keeps non-ok execution states visible through the shared row states', () => {
    const args = JSON.stringify({ todos: LIST })
    const running = render(<TodoRow {...rowProps({ phase: 'start', callId: 'c1', name: 'todo_write', argsRaw: args, turn: 1, step: 1, time: 1_000, callView: null, subCalls: [] })} />)
    expect(running.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(running.container.querySelector('[data-state="running"] svg')).not.toBeNull()
    running.unmount()
    const stopped = render(<TodoRow {...rowProps(resultNode(args, { isError: true, error: { name: 'Interrupted', code: 'interrupted' } }))} />)
    expect(stopped.container.querySelector('[data-state="stopped"]')).not.toBeNull()
  })

  it('falls back to the generic summary on malformed args and marks the error state', () => {
    const view = render(<TodoRow {...rowProps(resultNode('not json', { isError: true }))} />)
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(screen.getByText('not json')).toBeTruthy()
  })

  it('falls back when parsed args carry no todos array', () => {
    render(<TodoRow {...rowProps(resultNode('{"other":1}'))} />)
    expect(screen.getByText('{"other":1}')).toBeTruthy()
  })

  it('leading toggle expands a read-only checklist when no recorded predecessor is loaded', () => {
    render(<TodoRow {...rowProps(resultNode(ARGS))} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(screen.getByText('搭骨架')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByLabelText('进行中')).toBeTruthy()
    expect(screen.getByText('旧清单不可用')).toBeTruthy()
    expect(screen.queryByText('输入')).toBeNull()
  })

  it.each([
    { label: 'null root', argsRaw: 'null' },
    { label: 'non-object root', argsRaw: '42' },
    { label: 'null items', argsRaw: '{"todos":[null]}' },
  ])('falls back to the generic summary on valid JSON with an invalid shape ($label)', ({ argsRaw }) => {
    render(<TodoRow {...rowProps(resultNode(argsRaw))} />)
    expect(screen.getByText(argsRaw)).toBeTruthy()
  })

  it('window-truncated result falls back to the callId summary', () => {
    render(<TodoRow {...rowProps(resultNode('', { call: null }))} />)
    expect(screen.getByText('c1')).toBeTruthy()
  })

  it('injects the keyed toolview declaration directly and installs the recorded history', () => {
    expect(todoToolview.name).toBe('todo-toolview')
    expect(todoToolview.inject).toEqual(['slots', 'conversationEvents', 'conversationViews'])
    const register = vi.fn(() => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    const events = { register: vi.fn(() => () => undefined) }
    const views = { register: vi.fn(() => () => undefined) }
    todoToolview.apply({ slots: { inject, register }, conversationEvents: events, conversationViews: views } as never)
    expect(events.register).toHaveBeenCalledTimes(2)
    expect(views.register).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenCalledWith('tool.call.toolview', expect.any(Function))
    expect(register).toHaveBeenCalledWith({ name: 'tool.call.toolview', key: 'todo_write', locale: NS }, TodoRow)
  })
})
