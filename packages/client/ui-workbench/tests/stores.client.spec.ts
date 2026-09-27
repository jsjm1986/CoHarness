import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createWorkbenchStore } from '../src/client/stores.ts'

describe('workbench chooser store', () => {
  it('tracks picker and browser state independently', () => {
    const inst = createWorkbenchStore().create()
    expect(inst.store.getSnapshot()).toEqual({ pickerOpen: false, replace: false, browser: undefined })
    inst.actions.openPicker(true)
    expect(inst.store.getSnapshot()).toMatchObject({ pickerOpen: true, replace: true })
    inst.actions.closePicker()
    expect(inst.store.getSnapshot()).toMatchObject({ pickerOpen: false, replace: true })
    const owner = { sessionId: 's' as SessionId, runtimeTarget: { kind: 'project' as const, projectId: 3 } }
    inst.actions.openBrowser(owner)
    expect(inst.store.getSnapshot().browser).toBe(owner)
    inst.actions.closeBrowser()
    expect(inst.store.getSnapshot().browser).toBeUndefined()
  })
})
