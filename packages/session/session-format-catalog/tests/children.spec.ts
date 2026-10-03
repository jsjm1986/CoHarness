import { describe, expect, it } from 'vitest'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '../src/index.ts'

const header = { type: 'session', version: 6, id: 'parent', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const policy = { recovery: 'strict', validation: 'current' } as const

describe('parent-specific catalog assembly', () => {
  it('refuses embedded child evidence: CoHarness logs carry parent-owned catalog events', () => {
    expect(() => createSessionFormatCatalogWithChildren([{ childId: 'child', childCreatedAt: 2 }]))
      .toThrow(/embedded child session evidence/)
  })

  it('isolates interleaved restores across parent catalogs', () => {
    const left = createSessionFormatCatalogWithChildren([])
    const first = left.createRestore(header, policy)
    const second = createSessionFormatCatalogWithChildren([])
      .createRestore({ ...header, id: 'other-parent' }, policy)
    const repeated = left.createRestore(header, policy)
    const row = { type: 'feedback/record', seq: 0, time: 5, data: { text: 'retained' } }
    first.decodeRow(row)
    second.decodeRow(row)
    repeated.decodeRow(row)
    const right = second.finish()
    const result = first.finish()
    expect(result.events).toEqual([row])
    expect(right.header.id).toBe('other-parent')
    expect(repeated.finish()).toEqual(result)
    const physical = sessionFormatCatalog.encodeCurrentHeader(result.header, result.inheritedEventCount)
    const reopened = sessionFormatCatalog.createRestore(physical, policy)
    for (const event of result.events) reopened.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
    expect(reopened.finish()).toEqual(result)
  })
})
