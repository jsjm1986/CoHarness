/** Activity feed grouping, member roster, and label rendering. */
import { describe, expect, it } from 'vitest'
import {
  agoLabel,
  convTone,
  feedMembers,
  groupItems,
  relativeDayLabel,
  timeLabel,
  type ActivityItem,
} from '../src/client/feed.ts'

function item(partial: Partial<ActivityItem> & Pick<ActivityItem, 'kind' | 'occurredAt'>): ActivityItem {
  return {
    sessionId: 'session-a',
    conversationTitle: 'Migration',
    actorUserId: 7,
    actorLabel: 'Lin',
    seq: 3,
    text: 'body',
    ...partial,
  }
}

const TITLE = (sessionId: string): string => `untitled ${sessionId}`

describe('groupItems', () => {
  const rows = [
    item({ kind: 'message', occurredAt: '2026-10-17T09:00:00', sessionId: 'a', conversationTitle: 'Alpha' }),
    item({ kind: 'message', occurredAt: '2026-10-17T10:00:00', sessionId: 'b', conversationTitle: 'Beta' }),
    item({ kind: 'answer', occurredAt: '2026-10-17T11:00:00', sessionId: 'a', conversationTitle: 'Alpha', text: 'Approve' }),
    item({ kind: 'message', occurredAt: '2026-10-16T08:00:00', sessionId: 'a', conversationTitle: 'Alpha' }),
  ]

  it('folds one section per day in time mode, rows staying in feed order', () => {
    const sections = groupItems(rows, 'time', TITLE)
    expect(sections.map(section => [section.day, section.rows.length])).toEqual([
      ['2026-10-17', 3],
      ['2026-10-16', 1],
    ])
    expect(sections[0]?.rows.map(row => row.occurredAt)).toEqual([
      '2026-10-17T09:00:00',
      '2026-10-17T10:00:00',
      '2026-10-17T11:00:00',
    ])
    expect(sections.every(section => section.day !== undefined)).toBe(true)
  })

  it('groups by conversation ordered by latest activity', () => {
    const sections = groupItems(rows, 'conversation', TITLE)
    expect(sections.map(section => [section.title, section.rows.length])).toEqual([
      ['Alpha', 3],
      ['Beta', 1],
    ])
    expect(sections.every(section => section.day === undefined)).toBe(true)
    expect(sections[0]?.latest).toBe('2026-10-17T11:00:00')
  })

  it('groups by member ordered by latest activity', () => {
    const members = [
      item({ kind: 'message', occurredAt: '2026-10-17T09:00:00', actorUserId: 7, actorLabel: 'Lin' }),
      item({ kind: 'message', occurredAt: '2026-10-17T10:00:00', actorUserId: 8, actorLabel: 'Zhou' }),
      item({ kind: 'answer', occurredAt: '2026-10-17T11:00:00', actorUserId: 7, actorLabel: 'Lin' }),
    ]
    const sections = groupItems(members, 'member', TITLE)
    expect(sections.map(section => [section.title, section.rows.length])).toEqual([
      ['Lin', 2],
      ['Zhou', 1],
    ])
  })

  it('surfaces the newest answer as the section digest and counts answers and actors', () => {
    const sections = groupItems(rows, 'conversation', TITLE)
    const alpha = sections[0]
    expect(alpha?.answers).toBe(1)
    expect(alpha?.digest?.kind).toBe('answer')
    expect(alpha?.digest?.text).toBe('Approve')
    expect(alpha?.actors).toEqual([{ userId: 7, label: 'Lin' }])
    const beta = sections[1]
    expect(beta?.answers).toBe(0)
    expect(beta?.digest?.kind).toBe('message')
  })

  it('falls back to the conversation-title resolver for null titles', () => {
    const sections = groupItems(
      [item({ kind: 'message', occurredAt: '2026-10-17T09:00:00Z', conversationTitle: null, sessionId: 'x' })],
      'conversation', TITLE,
    )
    expect(sections[0]?.title).toBe('untitled x')
  })
})

describe('feedMembers', () => {
  it('lists each actor once in first-seen order', () => {
    const members = feedMembers([
      item({ kind: 'message', occurredAt: 'a', actorUserId: 7, actorLabel: 'Lin' }),
      item({ kind: 'message', occurredAt: 'b', actorUserId: 8, actorLabel: 'Zhou' }),
      item({ kind: 'answer', occurredAt: 'c', actorUserId: 7, actorLabel: 'Lin' }),
    ])
    expect(members).toEqual([{ userId: 7, label: 'Lin' }, { userId: 8, label: 'Zhou' }])
  })
})

describe('convTone', () => {
  it('keeps one conversation on one tone and lands inside the palette', () => {
    expect(convTone('session-a')).toBe(convTone('session-a'))
    expect(convTone('session-a')).toBeGreaterThanOrEqual(0)
    expect(convTone('session-a')).toBeLessThan(5)
  })
})

describe('timeLabel', () => {
  it('renders HH:mm in local time', () => {
    const label = timeLabel('2026-10-17T09:05:00')
    expect(label).toMatch(/^\d{2}:\d{2}$/)
    expect(label.endsWith(':05')).toBe(true)
  })
})

describe('relativeDayLabel', () => {
  it('labels today and yesterday, older days keep the raw date', () => {
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const fmt = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    const labels = { today: 'Today', yesterday: 'Yesterday' }
    expect(relativeDayLabel(fmt(now), labels)).toBe('Today')
    expect(relativeDayLabel(fmt(new Date(Date.now() - 86_400_000)), labels)).toMatch(/^Yesterday · \d{2}-\d{2}$/)
    expect(relativeDayLabel('2026-01-01', labels)).toBe('2026-01-01')
  })
})

describe('agoLabel', () => {
  it('shows HH:mm today, yesterday word yesterday, MM-DD otherwise', () => {
    const now = new Date()
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T15:44:00`
    expect(agoLabel(iso, 'Yesterday')).toBe('15:44')
    const yesterday = new Date(Date.now() - 86_400_000)
    const yIso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}T15:44:00`
    expect(agoLabel(yIso, 'Yesterday')).toBe('Yesterday 15:44')
    expect(agoLabel('2026-01-02T15:44:00', 'Yesterday')).toBe('01-02')
  })
})
