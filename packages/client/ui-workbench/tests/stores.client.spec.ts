import { describe, expect, it } from 'vitest'
import type { SessionId, WorkspaceResourceOpenRequest } from '@deepseek-ai/dsh-client-runtime/client'
import { createWorkbenchStore } from '../src/client/stores.ts'

describe('workbench chooser store', () => {
  it('tracks picker, preview and browser state independently', () => {
    const inst = createWorkbenchStore().create()
    expect(inst.store.getSnapshot()).toEqual({ pickerOpen: false, replace: false, preview: undefined, browser: undefined })
    inst.actions.openPicker(true)
    expect(inst.store.getSnapshot()).toMatchObject({ pickerOpen: true, replace: true })
    inst.actions.closePicker()
    expect(inst.store.getSnapshot()).toMatchObject({ pickerOpen: false, replace: true })
    const request: WorkspaceResourceOpenRequest = {
      runtimeTarget: { kind: 'base' }, sessionId: 's' as SessionId, path: 'a.txt', address: 'r' as never,
    }
    inst.actions.openPreview(request)
    expect(inst.store.getSnapshot().preview).toBe(request)
    inst.actions.closePreview()
    expect(inst.store.getSnapshot().preview).toBeUndefined()
    const owner = { sessionId: 's' as SessionId, runtimeTarget: { kind: 'project' as const, projectId: 3 } }
    inst.actions.openBrowser(owner)
    expect(inst.store.getSnapshot().browser).toBe(owner)
    inst.actions.closeBrowser()
    expect(inst.store.getSnapshot().browser).toBeUndefined()
  })
})
