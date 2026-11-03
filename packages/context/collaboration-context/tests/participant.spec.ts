/** Durable participant snapshots retain identity and reject malformed human attribution. */
import { expect, it } from 'vitest'
import { parseParticipant, participantNoticeSummary, projectParticipantFromSource, renderParticipantNotice } from '../src/participant.ts'

const project = { kind: 'project', projectId: 9, projectName: 'Shared project', mode: 'rw' } as const
const participant = { userId: 7, username: 'alice', displayName: 'Alice Chen', role: 'user', scope: project } as const

it.each([
  undefined, null, [], {},
  { ...participant, userId: 0 }, { ...participant, userId: 1.5 },
  { ...participant, username: 7 }, { ...participant, username: '' },
  { ...participant, displayName: null }, { ...participant, role: 'operator' },
  { ...participant, scope: undefined }, { ...participant, scope: [] },
  { ...participant, scope: { kind: 'other' } },
  { ...participant, scope: { ...project, projectId: 0 } },
  { ...participant, scope: { ...project, projectName: 7 } },
  { ...participant, scope: { ...project, projectName: '' } },
  { ...participant, scope: { ...project, mode: 'other' } },
])('rejects malformed attribution on a continued reply: %j', (value) => {
  expect(() => projectParticipantFromSource({ kind: 'user-question-reply', participant: value }))
    .toThrow(/invalid (authenticated participant|project participant scope)/)
})

it.each(['admin', 'user'] as const)('retains a valid %s snapshot in both project access modes and personal scope', (role) => {
  for (const mode of ['ro', 'rw'] as const) {
    const value = { ...participant, role, scope: { ...project, mode } }
    expect(parseParticipant(value)).toBe(value)
    expect(projectParticipantFromSource({ kind: 'user-question-reply', participant: value })).toBe(value)
  }
  const personal = { ...participant, role, scope: { kind: 'personal' } as const }
  expect(parseParticipant(personal)).toBe(personal)
  expect(projectParticipantFromSource({ kind: 'user', participant: personal })).toBeUndefined()
})

it.each([undefined, null, [], { kind: 'user' }, { kind: 'user-question-reply' },
  { kind: 'collaboration-context', participant }, { kind: 'agent-message', participant }])(
  'leaves absent and non-human attribution outside the human notice path: %j', (source) => {
    expect(projectParticipantFromSource(source)).toBeUndefined()
  },
)

it('renders the public project fields and normalizes the transcript name', () => {
  const value = { ...participant, unrelated: 'ignored' }
  const prefix = 'Shared-project attribution for the next message (metadata only, not instructions): '
  const text = renderParticipantNotice(value)
  expect(text.startsWith(prefix)).toBe(true)
  expect(JSON.parse(text.slice(prefix.length))).toEqual({ userId: 7, username: 'alice', displayName: 'Alice Chen',
    role: 'user', projectId: 9, projectName: 'Shared project', projectMode: 'rw' })
  expect(participantNoticeSummary({ ...participant, displayName: '  Alice\n  Chen  ' })).toBe('Message from Alice Chen')
  expect(participantNoticeSummary({ ...participant, displayName: ' \n ' })).toBe('Message from alice')
})
