// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readWorkbenchRegistry, writeWorkbenchRegistry, type WorkbenchLayout, type WorkbenchRegistrySnapshot } from '../src/client/registry.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

const KEY = 'dsh.conversation.workbenches.v1'

const layout = (overrides: Partial<WorkbenchLayout> = {}): WorkbenchLayout => ({
  id: 'w1', name: 'Sessions', paneIds: ['s1' as SessionId], paneRatios: [1], updatedAt: 10, ...overrides,
})

const snapshot = (overrides: Partial<WorkbenchRegistrySnapshot> = {}): WorkbenchRegistrySnapshot => ({
  version: 1, activeId: 'w1', workbenches: [layout()], ...overrides,
})

beforeEach(() => globalThis.localStorage.clear())
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('readWorkbenchRegistry', () => {
  it('returns the fallback when nothing is stored', () => {
    expect(readWorkbenchRegistry(layout({ id: 'fb' }))).toEqual({ version: 1, activeId: 'fb', workbenches: [layout({ id: 'fb' })] })
  })

  it('returns a stored valid snapshot', () => {
    const stored = snapshot()
    globalThis.localStorage.setItem(KEY, JSON.stringify(stored))
    expect(readWorkbenchRegistry(layout({ id: 'fb' }))).toEqual(stored)
  })

  it('falls back on a malformed JSON blob', () => {
    globalThis.localStorage.setItem(KEY, '{not json')
    expect(readWorkbenchRegistry(layout({ id: 'fb' })).activeId).toBe('fb')
  })

  it('falls back when the stored value is not a valid registry snapshot', () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ version: 2, activeId: 'x', workbenches: [] }))
    expect(readWorkbenchRegistry(layout({ id: 'fb' })).activeId).toBe('fb')
  })

  it('falls back when storage access throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode') })
    expect(readWorkbenchRegistry(layout({ id: 'fb' })).activeId).toBe('fb')
  })

  it('falls back when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readWorkbenchRegistry(layout({ id: 'fb' })).activeId).toBe('fb')
  })
})

describe('writeWorkbenchRegistry', () => {
  it('persists the snapshot as JSON', () => {
    const value = snapshot()
    writeWorkbenchRegistry(value)
    expect(globalThis.localStorage.getItem(KEY)).toBe(JSON.stringify(value))
  })

  it('swallows a storage quota/private-mode failure', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => writeWorkbenchRegistry(snapshot())).not.toThrow()
  })

  it('swallows a missing localStorage', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => writeWorkbenchRegistry(snapshot())).not.toThrow()
  })
})

describe('registry validation', () => {
  it('rejects a snapshot with a non-object body', () => {
    globalThis.localStorage.setItem(KEY, 'null')
    expect(readWorkbenchRegistry(layout({ id: 'fb' })).activeId).toBe('fb')
  })

  it('rejects a snapshot whose workbench item has a non-array paneIds', () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ version: 1, activeId: 'w1', workbenches: [{ id: 'w1', name: 'x', paneIds: 'no' }] }))
    expect(readWorkbenchRegistry(layout({ id: 'fb' })).activeId).toBe('fb')
  })

  it('rejects a snapshot missing an item string field', () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ version: 1, activeId: 'w1', workbenches: [{ id: 'w1', name: 4, paneIds: [] }] }))
    expect(readWorkbenchRegistry(layout({ id: 'fb' })).activeId).toBe('fb')
  })
})
