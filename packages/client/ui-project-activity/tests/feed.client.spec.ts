/** Activity feed grouping, member roster, and label rendering. */
import { describe, expect, it } from 'vitest'
import { feedMembers, groupItems, timeLabel, type ActivityItem } from '../src/client/feed.ts'

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

  it('nests day over conversation in time mode, merging same-day rows of one conversation', () => {
    const sections = groupItems(rows, 'time', TITLE)
    expect(sections.map(section => [section.day, section.title, section.rows.length])).toEqual([
      ['2026-10-17', 'Alpha', 2],
      ['2026-10-17', 'Beta', 1],
      ['2026-10-16', 'Alpha', 1],
    ])
    expect(sections.every(section => section.day !== undefined)).toBe(true)
  })

  it('groups by conversation ordered by latest activity, without day headers', () => {
    const sections = groupItems(rows, 'conversation', TITLE)
    expect(sections.map(section => [section.title, section.rows.length])).toEqual([
      ['Alpha', 3],
      ['Beta', 1],
    ])
    expect(sections.every(section => section.day === undefined)).toBe(true)
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

describe('timeLabel', () => {
  it('renders HH:mm in local time', () => {
    const label = timeLabel('2026-10-17T09:05:00')
    expect(label).toMatch(/^\d{2}:\d{2}$/)
    expect(label.endsWith(':05')).toBe(true)
  })
})
