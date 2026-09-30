// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clientSessionKey, parseClientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '../src/client/api.ts'

describe('Client Session addresses', () => {
  it('separates identical Host IDs by runtime and round trips opaque punctuation without rewriting it', () => {
    const id = 'dsh-session:v1:[null,"nested"] / 😀' as SessionId
    const personal = clientSessionKey({ kind: 'personal' }, id)
    const project = clientSessionKey({ kind: 'project', projectId: 7, projectName: 'renameable' }, id)
    expect(personal).not.toBe(project)
    expect(project).toBe(clientSessionKey({ kind: 'project', projectId: 7 }, id))
    expect(parseClientSessionKey(personal)).toEqual({ runtime: { kind: 'personal' }, sessionId: id })
    expect(parseClientSessionKey(project)).toEqual({ runtime: { kind: 'project', projectId: 7 }, sessionId: id })
  })
  it.each(['raw', 'dsh-session:v1:{', 'dsh-session:v1:null', 'dsh-session:v1:[null]',
    'dsh-session:v1:[null,""]', 'dsh-session:v1:[0,"x"]', 'dsh-session:v1:[1.2,"x"]',
    'dsh-session:v1:["7","x"]', 'dsh-session:v1:[null, "x"]'])('rejects corrupt or noncanonical metadata %s', (value) => {
    expect(parseClientSessionKey(value)).toBeUndefined()
  })
})
