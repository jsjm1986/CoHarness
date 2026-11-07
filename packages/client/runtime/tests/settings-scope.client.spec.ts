/** Per-field settings controls follow the selected persistence source. */
import { describe, expect, it, vi } from 'vitest'
import { settingsFieldControlState } from '../src/client/contract/settings-scope.ts'
import type { SettingsControlState, SettingsScope } from '../src/client/contract/settings-scope.ts'

describe('settingsFieldControlState', () => {
  const snapshot = {
    status: 'ready' as const, value: {}, base: {}, user: {}, revision: 1,
    writable: true, writableReason: undefined, write: { status: 'idle' as const }, mode: 'account' as const,
  }
  const single: SettingsScope<unknown> = {
    getSnapshot: () => snapshot, subscribe: () => () => {},
    set: async () => {}, unset: async () => {},
  }

  it('uses namespace availability for a single persistence source', () => {
    expect(settingsFieldControlState(single, 'preference')).toMatchObject({ writable: true, mode: 'account' })
  })

  it('uses field availability before the merged namespace answer', () => {
    const state: SettingsControlState = {
      status: 'ready', writable: false, writableReason: 'project', write: { status: 'idle' }, mode: 'host',
    }
    const getFieldControlState = vi.fn(() => state)
    expect(settingsFieldControlState({ ...single, getFieldControlState }, 'fontSize')).toBe(state)
    expect(getFieldControlState).toHaveBeenCalledWith('fontSize')
  })
})
