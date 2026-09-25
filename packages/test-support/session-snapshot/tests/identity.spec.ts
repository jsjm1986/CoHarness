import { describe, expect, it } from 'vitest'
import { redactSessionSnapshotIds } from '../src/identity.ts'

const parentId = '11111111-1111-4111-8111-111111111111'
const childId = '22222222-2222-4222-8222-222222222222'
const messageId = '33333333-3333-4333-8333-333333333333'
const approvalId = '44444444-4444-4444-8444-444444444444'
const runId = '55555555-5555-4555-8555-555555555555'
const otherId = '66666666-6666-4666-8666-666666666666'
const proseUuid = '77777777-7777-4777-8777-777777777777'

describe('session snapshot identity redaction', () => {
  it('preserves arbitrary business ids even when they use UUID syntax', () => {
    const log = (id: string) => JSON.stringify({ type: 'example', data: { id, orderId: id, text: id } })
    const [output] = redactSessionSnapshotIds([log(otherId)])
    expect(output).toBe(log(otherId))
    expect(redactSessionSnapshotIds([log(otherId)])).not.toEqual(redactSessionSnapshotIds([log(proseUuid)]))
  })

  it('reserves later canonical identities before assigning new ordinals', () => {
    const source = [
      { type: 'session', id: parentId },
      { type: 'example', data: { sessionId: '{{session:1}}', messageId, other: '{{message:1}}' } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([source])
    expect(output).toContain('"id":"{{session:2}}"')
    expect(output).toContain('"sessionId":"{{session:1}}"')
    expect(output).toContain('"messageId":"{{message:2}}"')
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('keeps project, runtime, participant and target relationships distinct', () => {
    const log = (secondProject: string) => [
      { type: 'session', id: parentId },
      { type: 'example', data: { projectId: childId, runtimeId: messageId, participantId: approvalId,
        executionTargetId: runId, resourceId: otherId } },
      { type: 'example', data: { projectId: secondProject, runtimeId: messageId } },
    ].map(record => JSON.stringify(record)).join('\n')
    const same = redactSessionSnapshotIds([log(childId)])
    const different = redactSessionSnapshotIds([log(proseUuid)])
    expect(same).not.toEqual(different)
    expect(same[0]).toContain('"projectId":"{{project:1}}"')
    expect(different[0]).toContain('"projectId":"{{project:2}}"')
    expect(same[0]).toContain('"runtimeId":"{{runtime:1}}"')
    expect(same[0]).toContain('"participantId":"{{principal:1}}"')
    expect(same[0]).toContain('"executionTargetId":"{{target:1}}"')
    expect(same[0]).toContain('"resourceId":"{{resource:1}}"')
  })

  it('does not replace identity substrings in ordinary words or longer identifiers', () => {
    const raw = [
      { type: 'session', id: 's' },
      { type: 'example', data: { text: 'status s. s-other', requestId: `prefix-${proseUuid}` } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([raw])
    expect(output).toContain('status {{session:1}}. s-other')
    expect(output).toContain(`prefix-${proseUuid}`)
  })

  it('preserves feedback versions and target relationships without redacting unrelated prose', () => {
    const source = [
      { type: 'session', id: parentId },
      { type: 'assistant/message', data: { message: { id: messageId, role: 'assistant', content: [], source: {} } } },
      { type: 'feedback/message-put', data: { sessionId: parentId, item: { messageId, version: approvalId, note: proseUuid } } },
      { type: 'feedback/message-put', data: { sessionId: parentId, item: { messageId, version: runId } } },
      { type: 'feedback/message-delete', data: { sessionId: parentId, messageId } },
      { type: 'example', data: { version: proseUuid } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([source])
    expect(output).toContain('"version":"{{id:1}}"')
    expect(output).toContain('"version":"{{id:2}}"')
    expect(output?.match(/"messageId":"{{message:1}}"/g)).toHaveLength(3)
    expect(output).toContain(proseUuid)
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('preserves typed relationships across parent and child logs', () => {
    const parent = [
      JSON.stringify({ type: 'session', id: parentId, createdAt: 1, cwd: '/tmp/work' }),
      JSON.stringify({
        type: 'agent/inbox/spliced',
        data: {
          inserted: [{
            role: 'user',
            content: [{ type: 'text', text: `keep unrelated ${proseUuid}; session ${childId}` }],
            source: { kind: 'user' },
            id: messageId,
          }],
        },
      }),
      JSON.stringify({ type: 'approval/asked', data: { id: approvalId } }),
      JSON.stringify({ type: 'tool-workflow/run-start', data: { runId } }),
      JSON.stringify({ type: 'example', data: { requestId: otherId, echoed: otherId } }),
      '',
    ].join('\n')
    const child = [
      JSON.stringify({ type: 'session', id: childId, parentSession: parentId, createdAt: 2, cwd: '/tmp/work' }),
      JSON.stringify({
        type: 'user/message',
        data: {
          role: 'user', content: [], source: { kind: 'user' }, id: messageId,
        },
      }),
      '',
    ].join('\n')

    const redacted = redactSessionSnapshotIds([parent, child])
    expect(redacted[0]).toContain('"id":"{{session:1}}"')
    expect(redacted[1]).toContain('"id":"{{session:2}}"')
    expect(redacted[1]).toContain('"parentSession":"{{session:1}}"')
    expect(redacted.join('\n').match(/\{\{message:1\}\}/g)).toHaveLength(2)
    expect(redacted[0]).toContain('"id":"{{approval:1}}"')
    expect(redacted[0]).toContain('"runId":"{{workflow:1}}"')
    expect(redacted[0]).toContain(`"requestId":"${otherId}"`)
    expect(redacted[0]).toContain(`"echoed":"${otherId}"`)
    expect(redacted[0]).toContain(proseUuid)
    expect(redacted[0]).toContain('session {{session:2}}')
    expect(redactSessionSnapshotIds(redacted)).toEqual(redacted)
  })

  it('classifies command, RPC and retry fields without treating prose as identity declarations', () => {
    const semanticMessage = '88888888-8888-4888-8888-888888888888'
    const anonymousUser = '99999999-9999-4999-8999-999999999999'
    const retryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const source = [
      JSON.stringify({ type: 'not-a-session', data: { value: 'plain' } }),
      JSON.stringify({
        type: 'example',
        data: {
          commandId: 'command-7',
          rpcId: 'rpc-9',
          retryId,
          requestId: 'stable-readable-id',
          text: `Retain this as message ${semanticMessage}. Anonymous user: ${anonymousUser}`,
        },
      }),
    ].join('\n')

    const [redacted] = redactSessionSnapshotIds([source])
    expect(redacted).toContain('"commandId":"{{command:1}}"')
    expect(redacted).toContain('"rpcId":"{{rpc:1}}"')
    expect(redacted).toContain('"retryId":"{{retry:1}}"')
    expect(redacted).toContain(`as message ${semanticMessage}`)
    expect(redacted).toContain(`Anonymous user: ${anonymousUser}`)
    expect(redacted).toContain('"requestId":"stable-readable-id"')
    expect(redacted?.endsWith('\n')).toBe(false)
  })

  it('uses the feedback command lifecycle to identify its generated acknowledgement', () => {
    const source = [
      { type: 'command/run', data: { commandId: 'feedback-1', name: 'feedback' } },
      { type: 'command/done', data: { commandId: 'feedback-1', text: `Feedback recorded for session fixed\nAnonymous user: ${otherId}. Session sharing is disabled.` } },
      { type: 'command/done', data: { commandId: 'other', text: `Anonymous user: ${proseUuid}.` } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [result] = redactSessionSnapshotIds([source])
    expect(result).toContain('Anonymous user: {{principal:1}}')
    expect(result).toContain(proseUuid)
  })

  it('collapses branded goal-<uuid> compounds across state and literal payloads', () => {
    const goalUuid = 'aaaaaaaa-0000-4000-8000-00000000000a'
    const goalId = `goal-${goalUuid}`
    const source = [
      { type: 'session', id: parentId },
      { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create',
        goal: { id: goalId, revision: 1, objective: 'ship it', phase: 'active', maxGoalRounds: 2 },
        roundsStarted: 0, createdAt: 0, updatedAt: 0 } },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'update_goal',
        arguments: `{"goal_id":"${goalId}","action":"complete"}` } },
      { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'clear',
        cleared: { id: goalId, revision: 2 }, clearedAt: 1 } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([source])
    expect(output).not.toContain(goalUuid)
    expect(output?.match(/goal-\{\{goal:1\}\}/g)).toHaveLength(3)
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('replaces a claimed uuid inside a hyphenated compound while keeping prose boundaries', () => {
    const parentLog = [
      { type: 'session', id: 's' },
      { type: 'example', data: { sessionId: childId, text: `child agent id is "session-${childId}"`, probe: `x-${childId}` } },
    ].map(record => JSON.stringify(record)).join('\n')
    const childLog = [
      { type: 'session', id: childId, parentSessionId: 's' },
      { type: 'example', data: { text: 'child ran' } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [parentOut, childOut] = redactSessionSnapshotIds([parentLog, childLog])
    expect(parentOut).toContain('session-{{session:2}}')
    expect(parentOut).toContain('x-{{session:2}}')
    expect(parentOut).not.toContain(childId)
    expect(childOut).toContain('"id":"{{session:2}}"')
    expect(redactSessionSnapshotIds([parentOut!, childOut!])).toEqual([parentOut, childOut])
  })

  it('keeps a canonical token first seen through a generic id key', () => {
    const canonical = '{{message:7}}'
    const nextMessage = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const source = [
      JSON.stringify({ type: 'example', data: { requestId: canonical } }),
      JSON.stringify({
        type: 'user/message',
        data: { role: 'user', content: [], source: { kind: 'user' }, id: canonical },
      }),
      JSON.stringify({
        type: 'user/message',
        data: { role: 'user', content: [], source: { kind: 'user' }, id: nextMessage },
      }),
      '',
    ].join('\n')

    const [redacted] = redactSessionSnapshotIds([source])
    expect(redacted?.match(/\{\{message:7\}\}/g)).toHaveLength(2)
    expect(redacted).toContain('"id":"{{message:8}}"')
    expect(redacted).not.toContain('{{id:')
  })
})
