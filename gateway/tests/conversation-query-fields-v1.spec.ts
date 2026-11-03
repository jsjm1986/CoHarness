/** Durable legacy metadata cannot invent member attribution or normalize another tool's identity. @module */
import { describe, expect, it } from 'vitest'
import { conversationQueryFieldsV1 } from '../src/postgres/conversation-query-fields-v1.ts'

const read = (json: string) => { const value: unknown = JSON.parse(json); return conversationQueryFieldsV1(value) }

describe('version-one durable event query fields', () => {
  it.each(['null', '7', '"legacy"', '[]', '{"type":"user/message"}', '{"type":"user/message","data":null}',
    '{"type":"user/message","data":{}}', '{"type":"user/message","data":{"source":"user"}}',
    '{"type":"user/message","data":{"source":{"participant":null}}}',
    '{"type":"user/message","data":{"source":{"participant":7}}}',
  ])('retains no inferred identity for unsupported legacy JSON: %s', json => {
    expect(read(json)).toEqual({})
  })

  it.each(['7', 0, -1, 1.5, 9_007_199_254_740_992])('refuses a non-public-numeric participant id: %s', userId => {
    expect(read(JSON.stringify({ type: 'user/message', data: { source: { participant: { userId, displayName: 'Another member' } } } }))).toEqual({})
  })

  it('keeps the recorded display name, username fallback and absent label distinct', () => {
    const preferred = read(JSON.stringify({ type: 'user/message', data: { source: { participant: { userId: 7, displayName: 'Display\u0000name', username: 'Ignored' } } } }))
    expect(JSON.parse(preferred.actorLabelJson!)).toBe('Display\u0000name')
    const username = 'Name\u0000尾巴'
    for (const displayName of ['', 3, undefined]) {
      const fields = read(JSON.stringify({ type: 'user/message', data: { source: { participant: { userId: 7, username, displayName } } } }))
      expect(fields.actorUid).toBe('7')
      expect(JSON.parse(fields.actorLabelJson!)).toBe(username)
    }
    expect(read('{"type":"user/message","data":{"source":{"participant":{"userId":7}}}}')).toEqual({ actorUid: '7' })
  })

  it('keeps NUL call ids uncorrelated while preserving exact free-text arguments', () => {
    const argumentsText = JSON.stringify({ questions: [{ question: 'Question\u0000text' }] })
    const fields = read(JSON.stringify({ type: 'tool/call', data: { callId: 'original\u0000suffix', arguments: argumentsText } }))
    expect(fields.callId).toBeUndefined()
    expect(JSON.parse(fields.argumentsJson!)).toBe(argumentsText)
    expect(read('{"type":"tool/call","data":{}}')).toEqual({})
    expect(read('{"type":"state","data":{"callId":"original"}}')).toEqual({})
    expect(read('{"type":"tool/result","data":{"callId":"original","arguments":"ignored"}}')).toEqual({ callId: 'original' })
  })

  it('keeps a zero turn distinct from an unsupported legacy turn value', () => {
    expect(read('{"type":"turn/start","data":{"turn":0}}')).toEqual({ turn: '0' })
    expect(read('{"type":"turn/start","data":{"turn":"0"}}')).toEqual({})
  })
})
