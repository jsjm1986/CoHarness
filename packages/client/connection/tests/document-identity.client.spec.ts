// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseDocumentIdentity } from '../src/client/document-identity.ts'

describe('authenticated document identity input', () => {
  it('retains describe-first admission when the page supplies no identity', () => {
    expect(parseDocumentIdentity(undefined)).toBeUndefined()
  })

  it.each([
    { kind: 'personal' },
    { kind: 'project', projectId: 42 },
    { kind: 'personal', runtimeId: 'd441ed6a-1643-4405-a29b-71d1e8be3eb0' },
    { kind: 'project', projectId: 42, runtimeId: 'd441ed6a-1643-4405-a29b-71d1e8be3eb0' },
  ])('detaches a valid $kind identity from the HTML value', (runtimeTarget) => {
    const input = { version: 1, principalId: 7, runtimeTarget }
    const parsed = parseDocumentIdentity(input)
    expect(parsed).toEqual({ principalId: 7, runtimeTarget })
    input.principalId = 8
    runtimeTarget.kind = 'changed'
    expect(parsed?.principalId).toBe(7)
    expect(parsed?.runtimeTarget.kind).not.toBe('changed')
  })

  it.each([
    null, [], false, 1, 'identity', {},
    { version: 2, principalId: 7, runtimeTarget: { kind: 'personal' } },
    { version: 1, principalId: 0, runtimeTarget: { kind: 'personal' } },
    { version: 1, principalId: 7.5, runtimeTarget: { kind: 'personal' } },
    { version: 1, principalId: Number.MAX_SAFE_INTEGER + 1, runtimeTarget: { kind: 'personal' } },
    { version: 1, principalId: 7 },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'unknown' } },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'personal', projectId: 42 } },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'project' } },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'project', projectId: -1 } },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'project', projectId: '42' } },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'project', projectId: 42, canManage: true } },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'personal', runtimeId: '' } },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'personal', runtimeId: 42 } },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'personal', nodeId: 'not-an-input' } },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'project', projectId: 42, nodeId: 'not-an-input' } },
    { version: 1, principalId: 7, runtimeTarget: { kind: 'personal' }, credential: 'not-an-input' },
  ])('rejects malformed or authority-bearing HTML input %#', (value) => {
    expect(() => parseDocumentIdentity(value)).toThrow(/Connection document/)
  })
})
