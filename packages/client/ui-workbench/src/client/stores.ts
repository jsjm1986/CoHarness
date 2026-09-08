/** Root-scoped workbench chooser state shared by the toolbar and pane actions. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

interface WorkbenchState { pickerOpen: boolean; replace: boolean }
type WorkbenchActions = {
  openPicker: (draft: WorkbenchState, replace?: boolean) => void
  closePicker: (draft: WorkbenchState) => void
}

/** Declare the transient workbench interaction store.
 * @returns a handle shared by root-scoped contributors.
 */
export function createWorkbenchStore(): EngineStoreHandle<WorkbenchState, WorkbenchActions> {
  return defineStore({
    init: (): WorkbenchState => ({ pickerOpen: false, replace: false }),
    actions: {
      openPicker: (draft, replace = false) => { draft.pickerOpen = true; draft.replace = replace },
      closePicker: (draft) => { draft.pickerOpen = false },
    },
  })
}
