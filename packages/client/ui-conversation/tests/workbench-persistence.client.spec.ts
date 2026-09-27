// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseWorkbenchRecord, readWorkbenchRecord, writeWorkbenchRecord, readLegacyWorkbenchRecord } from '../src/client/workbench-persistence.ts'
import type { WorkbenchRecord } from '../src/client/workbench-persistence.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

const A = 'a' as SessionId
const record: WorkbenchRecord = { version: 2, mode: 'workbench', activeId: 'default', workbenches: [
  { id: 'default', name: 'Personal layout', paneIds: [A], activePaneId: A, paneRatios: [1], updatedAt: 1 },
] }
beforeEach(() => { localStorage.clear() })

describe('workbench persistence document', () => {
  it('keeps complete records separate by principal without reading unscoped legacy metadata', () => {
    writeWorkbenchRecord('account:1', record)
    expect(readWorkbenchRecord('account:1')).toEqual(record)
    expect(readWorkbenchRecord('account:2')).toBeUndefined()
    expect(readWorkbenchRecord('local')).toBeUndefined()
    expect(localStorage.getItem('dsh.conversation.workbench.v1')).toBeNull()
    expect(localStorage.getItem('dsh.conversation.workbenches.v1')).toBeNull()
  })

  it.each([
    null, [], { ...record, version: 3 }, { ...record, mode: 'unknown' },
    { ...record, activeId: 'missing' }, { ...record, workbenches: [...record.workbenches, ...record.workbenches] },
    ...[
      { paneIds: ['a', 'a'] }, { paneIds: ['a', 2] }, { paneIds: ['a', 'b', 'c', 'd', 'e'] },
      { activePaneId: 'missing' }, { paneRatios: [] }, { paneRatios: [0] }, { paneRatios: [Infinity] },
      { updatedAt: NaN }, { name: false }, { id: '' },
    ].map(patch => ({ ...record, workbenches: [{ ...record.workbenches[0], ...patch }] })),
  ])('rejects invalid browser metadata: %j', (value) => {
    expect(parseWorkbenchRecord(value)).toBeUndefined()
  })

  it('imports only visible legacy panes and retains their corresponding ratios and active selection', () => {
    localStorage.setItem('dsh.conversation.workbench.v1', JSON.stringify({ mode: 'workbench', paneIds: ['a', 'denied', 'b'], activePaneId: 'b', paneRatios: [2, 100, 3] }))
    const imported = readLegacyWorkbenchRecord(id => id !== 'denied')
    expect(imported?.workbenches[0]).toMatchObject({ paneIds: ['a', 'b'], activePaneId: 'b', paneRatios: [0.4, 0.6] })
  })

  it('treats denied storage and corrupt JSON as unavailable without affecting in-memory operation', () => {
    localStorage.setItem('dsh.conversation.workbenches.v2.account%3A1', '{')
    expect(readWorkbenchRecord('account:1')).toBeUndefined()
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    try {
      expect(readWorkbenchRecord('local')).toBeUndefined()
      expect(readLegacyWorkbenchRecord(() => true)).toBeUndefined()
      expect(() =>{  writeWorkbenchRecord('local', record) }).not.toThrow()
    } finally { get.mockRestore(); set.mockRestore() }
  })
})
