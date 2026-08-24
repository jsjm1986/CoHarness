// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrajectoryMobileFeed, type TrajectoryMobileFeedItem } from '../src/client/TrajectoryMobileFeed.tsx'
import type { TrajectoryCellProps } from '../src/client/trajectory-record.ts'

const cell = (over: Partial<TrajectoryCellProps> = {}): TrajectoryCellProps => ({
  index: 1,
  recordId: 'tool-1',
  kind: 'tool',
  text: 'bash · {"command":"echo ok"}',
  timeSeconds: 0.125,
  startedAt: 1_700_000_000_000,
  outputDetail: 'ok',
  ...over,
})

const item = (over: Partial<TrajectoryMobileFeedItem> = {}): TrajectoryMobileFeedItem => ({
  record: {
    turn: 1,
    section: 0,
    group: 'Step 1',
    groupStart: true,
    turnStart: true,
    cell: cell(),
    turnEnd: true,
  },
  position: 0,
  request: 1,
  requestInfo: { number: 1, status: 'complete', seq: 10 },
  requestSelected: false,
  terminalRequestBoundary: false,
  ...over,
})

function mount(items: readonly TrajectoryMobileFeedItem[] = [item()]) {
  const onRecordSelect = vi.fn()
  const onRequestSelect = vi.fn()
  const onToggleTurn = vi.fn()
  const onToggleAssistant = vi.fn()
  const view = render(
    <TrajectoryMobileFeed
      items={items}
      logicalCount={items.length}
      scrollReady
      virtualTop={0}
      virtualBottom={0}
      historyLoading={false}
      olderBusy={false}
      hasOlderRecords={false}
      selectedIndex={null}
      timelineFocusIndexes={null}
      onRecordSelect={onRecordSelect}
      onRequestSelect={onRequestSelect}
      onToggleTurn={onToggleTurn}
      onToggleAssistant={onToggleAssistant}
    />,
  )
  return { view, onRecordSelect, onRequestSelect, onToggleTurn, onToggleAssistant }
}

afterEach(cleanup)

describe('TrajectoryMobileFeed', () => {
  it('renders a flat event stream with request metadata and no table', () => {
    mount()
    expect(screen.getByRole('list', { name: 'Trajectory events' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Request #1$/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: /TOOL, bash/ })).toBeTruthy()
    expect(document.querySelector('table')).toBeNull()
  })

  it('separates request selection from record selection', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Request #1' }))
    expect(b.onRequestSelect).toHaveBeenCalledWith({ turn: 1, group: 'Step 1', seq: 10 })
    expect(b.onRecordSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /TOOL, bash/ }))
    expect(b.onRecordSelect).toHaveBeenCalledWith(1)
  })

  it('uses the compact fold row action and exposes running/error metadata', () => {
    const summary = item({
      record: {
        ...item().record,
        cell: cell({ index: 2, recordId: 'assistant-2', kind: 'message', text: 'Tool call only' }),
        collapsedSummary: '2 tool calls',
        collapsedSummaryKind: 'assistant',
      },
    })
    delete summary.request
    delete summary.requestInfo
    const runningCell = cell({ index: 3, kind: 'tool' })
    delete runningCell.outputDetail
    const running = item({
      record: { ...item().record, cell: runningCell },
    })
    delete running.request
    delete running.requestInfo
    const b = mount([summary, running])
    fireEvent.click(screen.getByRole('button', { name: /ASSISTANT, 2 tool calls/ }))
    expect(b.onToggleAssistant).toHaveBeenCalledWith('assistant-2')
    expect(screen.getByRole('button', { name: /Pending/ })).toBeTruthy()
  })
})
