import { describe, expect, it } from 'vitest'
import {
  isCollaborationAttributionNotice, messageSender,
} from '../src/client/chat/message-sender.ts'

const participant = {
  userId: 7,
  username: 'lin',
  displayName: 'Lin',
  role: 'user' as const,
  scope: { kind: 'project' as const, projectId: 9, projectName: 'Payments', mode: 'rw' as const },
}

describe('messageSender', () => {
  it('reads the display name from a project user source', () => {
    expect(messageSender({ kind: 'user', participant })).toEqual({ name: 'Lin', admin: false })
  })

  it('marks an administrator sender', () => {
    expect(messageSender({
      kind: 'user',
      participant: { ...participant, role: 'admin' },
    })).toEqual({ name: 'Lin', admin: true })
  })

  it('falls back to username when the display name is blank', () => {
    expect(messageSender({
      kind: 'user',
      participant: { ...participant, displayName: '   ' },
    })).toEqual({ name: 'lin', admin: false })
  })

  it('returns undefined without a readable participant name', () => {
    expect(messageSender({ kind: 'user' })).toBeUndefined()
    expect(messageSender({ kind: 'user', participant: { role: 'user' } })).toBeUndefined()
    expect(messageSender(null)).toBeUndefined()
  })
})

describe('isCollaborationAttributionNotice', () => {
  it('recognizes the durable collaboration-context notice source', () => {
    expect(isCollaborationAttributionNotice({
      kind: 'plugin',
      plugin: 'collaboration-context',
      form: 'notice',
      participant,
    })).toBe(true)
  })

  it('rejects other plugin or user sources', () => {
    expect(isCollaborationAttributionNotice({
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'notice',
    })).toBe(false)
    expect(isCollaborationAttributionNotice({ kind: 'user', participant })).toBe(false)
    expect(isCollaborationAttributionNotice(null)).toBe(false)
  })
})
