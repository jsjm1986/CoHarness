// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSnapshot, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule/client'
import {
  formatScheduleFrequency, formatScheduleLocalTime, formatScheduleRelative, orderScheduleRecords, ScheduleCatalogAction,
  type ScheduleCatalogActionProps,
} from '../src/client/ScheduleCatalogAction.tsx'
import { en, zh } from '../src/client/locales.ts'

const START = Date.parse('2026-08-25T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function record(
  id: string,
  kind: ScheduleRecord['kind'],
  at: number,
  options: { prompt?: string; everySeconds?: number } = {},
): ScheduleRecord {
  const common = {
    id: ScheduleId(id),
    kind,
    prompt: options.prompt ?? id,
    scheduledAt: new Date(at).toISOString(),
  }
  if (kind === 'after') return { ...common, kind, afterSeconds: 30 }
  if (kind === 'every') return { ...common, kind, everySeconds: options.everySeconds ?? 300 }
  return { ...common, kind }
}

function snapshot(openState: ConversationSnapshot['openState']): ConversationSnapshot {
  return {
    sessionId: 'schedule-session' as never,
    queue: [], pendingSubmissions: [], running: false, subagent: null, removed: false,
    openState, openError: null, hasMore: false, loadingOlder: false, promptError: null,
    blank: false, lastAgentError: null,
    promptAttempted: false, awaitingFirstTurn: false,
  } as unknown as ConversationSnapshot
}

function props(
  records: readonly ScheduleRecord[] | undefined,
  openState: ConversationSnapshot['openState'] = 'open',
  dictionary: typeof zh | typeof en = en,
): ScheduleCatalogActionProps {
  const state = snapshot(openState)
  const useSession = <T,>(select: (value: ConversationSnapshot) => T): T => select(state)
  const useProjection = ((key: string, select?: (value: unknown) => unknown) => {
    const value = key === 'schedule' ? records : undefined
    return select === undefined ? value : select(value)
  }) as UseProjection
  return {
    sessionId: state.sessionId,
    useSession,
    useProjection,
    t: makeTranslate(dictionary),
  } as unknown as ScheduleCatalogActionProps
}

function prompts(): string[] {
  return within(screen.getByRole('list', { name: en['list.aria'] }))
    .getAllByRole('listitem')
    .map(item => item.querySelector('[class*="prompt"]')?.textContent ?? '')
}

describe('Schedule catalog formatting', () => {
  it('chooses exact recurring units and keeps stable ordering', () => {
    const tEn = makeTranslate(en)
    const tZh = makeTranslate(zh)
    expect(formatScheduleFrequency(record('d', 'every', START, { everySeconds: 86_400 }), tEn)).toBe('Every 1 day')
    expect(formatScheduleFrequency(record('m', 'every', START, { everySeconds: 301 }), tZh)).toBe('301秒一次')
    expect(formatScheduleFrequency(record('once', 'at', START), tEn)).toBe('Once')
    const first = record('first', 'at', START + 1_000)
    const second = record('second', 'at', START + 1_000)
    expect(orderScheduleRecords([first, second], START).map(item => item.id)).toEqual(['first', 'second'])
    expect(formatScheduleRelative(new Date(START + 61_000).toISOString(), START, tEn)).toBe('in 2 minutes')
  })

  it('formats all clock units, the exact due boundary, and both locales', () => {
    const tEn = makeTranslate(en)
    const tZh = makeTranslate(zh)
    const samples = [
      [86_400, 'Every 1 day', '1天一次'],
      [172_800, 'Every 2 days', '2天一次'],
      [3_600, 'Every 1 hour', '1小时一次'],
      [7_200, 'Every 2 hours', '2小时一次'],
      [300, 'Every 5 minutes', '5分钟一次'],
      [301, 'Every 301 seconds', '301秒一次'],
    ] as const
    for (const [seconds, english, chinese] of samples) {
      const item = record(String(seconds), 'every', START + 1_000, { everySeconds: seconds })
      expect(formatScheduleFrequency(item, tEn)).toBe(english)
      expect(formatScheduleFrequency(item, tZh)).toBe(chinese)
    }
    expect(formatScheduleFrequency(record('once', 'at', START + 1_000), tZh)).toBe('单次')
    expect(formatScheduleRelative(new Date(START).toISOString(), START, tEn)).toBe('Due now')
    expect(formatScheduleRelative(new Date(START + 500).toISOString(), START, tEn)).toBe('in 1 second')
    expect(formatScheduleRelative(new Date(START - 3_600_000).toISOString(), START, tEn)).toBe('1 hour overdue')
    expect(formatScheduleRelative(new Date(START - 172_800_000).toISOString(), START, tEn)).toBe('2 days overdue')
    expect(tZh('status.scheduled')).toBe('等待中')
    expect(tZh('status.overdue')).toBe('已逾期')
  })

  it('formats absolute time using the requested locale', () => {
    const scheduledAt = new Date(START + 3_600_000).toISOString()
    expect(formatScheduleLocalTime(scheduledAt, 'de-DE')).not.toBe(formatScheduleLocalTime(scheduledAt))
  })
})

describe('Schedule catalog visibility and interaction', () => {
  it('only renders for an open Session with active records', () => {
    const view = render(<ScheduleCatalogAction {...props(undefined)} />)
    expect(view.container.innerHTML).toBe('')
    view.rerender(<ScheduleCatalogAction {...props([], 'open')} />)
    expect(view.container.innerHTML).toBe('')
    for (const state of ['cold', 'loading', 'error'] as const) {
      view.rerender(<ScheduleCatalogAction {...props([record('hidden', 'at', START + 60_000)], state)} />)
      expect(view.container.innerHTML).toBe('')
    }
    view.rerender(<ScheduleCatalogAction {...props([record('active', 'after', START + 60_000)])} />)
    expect(screen.getByRole('button', { name: '1 reminder' })).toBeDefined()
  })

  it('closes and removes the trigger when the last live record disappears', () => {
    const active = [record('active', 'after', START + 60_000)]
    const view = render(<><button type="button">Neighbor</button><ScheduleCatalogAction {...props(active)} /></>)
    const trigger = screen.getByRole('button', { name: '1 reminder' })
    fireEvent.click(trigger)
    expect(screen.getByRole('list', { name: en['list.aria'] })).toBeDefined()
    view.rerender(<><button type="button">Neighbor</button><ScheduleCatalogAction {...props([])} /></>)
    expect(screen.queryByRole('button', { name: '1 reminder' })).toBeNull()
  })

  it('portals rows, orders overdue records first, and dismisses outside', () => {
    const active = record('active', 'after', START + 60_000)
    const overdue = record('overdue', 'at', START - 60_000)
    render(<ScheduleCatalogAction {...props([active, overdue])} />)
    const trigger = screen.getByRole('button', { name: '2 reminders' })
    fireEvent.click(trigger)
    const list = screen.getByRole('list', { name: en['list.aria'] })
    expect(list.parentElement).toBe(document.body)
    expect(within(list).getAllByRole('listitem')[0]?.textContent).toContain('Overdue')
    fireEvent.pointerDown(document.body)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('renders complete row metadata and keeps prompt text literal', () => {
    const rawPrompt = '<img src=x onerror=alert(1)> Keep this prompt'
    const overdue = record('hidden-id', 'after', START - 60_000, { prompt: rawPrompt })
    const every = record('every-id', 'every', START + 300_000, { prompt: 'Check metrics', everySeconds: 300 })
    const at = record('at-id', 'at', START + 3_600_000, { prompt: 'Join meeting' })
    render(<ScheduleCatalogAction {...props([at, every, overdue])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(prompts()).toEqual([rawPrompt, 'Check metrics', 'Join meeting'])
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]!).getByText('Overdue', { exact: true })).toBeDefined()
    expect(within(rows[1]!).getByText('Scheduled', { exact: true })).toBeDefined()
    expect(rows[0]?.textContent).toContain('Once')
    expect(rows[0]?.textContent).toContain('1 minute overdue')
    expect(rows[1]?.textContent).toContain('Every 5 minutes')
    expect(rows[1]?.textContent).toContain('in 5 minutes')
    expect(rows[2]?.textContent).toContain('in 1 hour')
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByRole('list').textContent).not.toContain('hidden-id')
  })

  it('updates overdue status on the open catalog clock', () => {
    const first = record('first', 'at', START + 500)
    const second = record('second', 'at', START + 500)
    render(<ScheduleCatalogAction {...props([first, second])} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByRole('listitem').every(row => within(row).queryByText('Scheduled', { exact: true }) !== null)).toBe(true)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getAllByRole('listitem').every(row => within(row).queryByText('Overdue', { exact: true }) !== null)).toBe(true)
  })

  it('restores trigger focus when Escape closes the catalog', () => {
    render(<ScheduleCatalogAction {...props([record('active', 'after', START + 60_000)])} />)
    const trigger = screen.getByRole('button')
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('list'), { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })

  it('ignores non-Escape keys and Escape while already closed', () => {
    render(<ScheduleCatalogAction {...props([record('active', 'after', START + 60_000)])} />)
    const trigger = screen.getByRole('button')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps an Escape on a sibling control out of the catalog handler', () => {
    render(<><ScheduleCatalogAction {...props([record('active', 'after', START + 60_000)])} /><button type="button">Sibling</button></>)
    const trigger = screen.getByRole('button', { name: '1 reminder' })
    const sibling = screen.getByRole('button', { name: 'Sibling' })
    fireEvent.click(trigger)
    sibling.focus()
    fireEvent.keyDown(sibling, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('stops and restarts its clock with the catalog lifecycle', () => {
    const view = render(<ScheduleCatalogAction {...props([record('active', 'after', START + 60_000)])} />)
    const trigger = screen.getByRole('button')
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(trigger)
    expect(vi.getTimerCount()).toBe(1)
    fireEvent.click(trigger)
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(trigger)
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
