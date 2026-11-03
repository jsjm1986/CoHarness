import { describe, expect, it } from 'vitest'
import { decodeUserDocIdentity } from '../src/index.ts'

const identity = { incarnationId: 'incarnation:one', revision: 2, origin: 'upload', createdBy: 'user:7' }

describe('document identity JSON decoding', () => {
  it('retains the document version and original publication actor without unknown metadata', () => {
    expect(decodeUserDocIdentity({ ...identity, privatePath: '/private/control' })).toEqual(identity)
    expect(decodeUserDocIdentity({ incarnationId: 'legacy:one', revision: 1, origin: 'legacy' }))
      .toEqual({ incarnationId: 'legacy:one', revision: 1, origin: 'legacy' })
  })

  it.each(['upload', 'transfer', 'legacy', 'admin'] as const)('reads the %s publication origin', (origin) => {
    expect(decodeUserDocIdentity({ ...identity, origin })?.origin).toBe(origin)
  })

  it.each([
    null, [], 'identity', {}, { ...identity, incarnationId: '' }, { ...identity, incarnationId: 'bad\0id' },
    { ...identity, incarnationId: 'x'.repeat(4097) }, { ...identity, revision: 0 }, { ...identity, revision: 1.5 },
    { ...identity, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...identity, revision: '2' },
    { ...identity, origin: 'future-origin' }, { ...identity, createdBy: null }, { ...identity, createdBy: '' },
    { ...identity, createdBy: 'bad\nactor' }, { ...identity, createdBy: 'x'.repeat(4097) },
  ])('refuses malformed identity metadata %j', (value) => {
    expect(decodeUserDocIdentity(value)).toBeUndefined()
  })
})
