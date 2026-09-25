/** Root-scoped workbench chooser state shared by the toolbar and pane actions. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, WorkspaceResourceTarget } from '@deepseek-ai/dsh-client-runtime/client'

/** Workspace file browser binding: the owning pane Session and its runtime target. */
export interface WorkspaceBrowserOwner {
  readonly sessionId: SessionId
  readonly runtimeTarget: WorkspaceResourceTarget
}

interface WorkbenchState {
  pickerOpen: boolean
  replace: boolean
  browser: WorkspaceBrowserOwner | undefined
}
type WorkbenchActions = {
  openPicker: (draft: WorkbenchState, replace?: boolean) => void
  closePicker: (draft: WorkbenchState) => void
  openBrowser: (draft: WorkbenchState, owner: WorkspaceBrowserOwner) => void
  closeBrowser: (draft: WorkbenchState) => void
}

/** Declare the transient workbench interaction store.
 * @returns a handle shared by root-scoped contributors.
 */
export function createWorkbenchStore(): EngineStoreHandle<WorkbenchState, WorkbenchActions> {
  return defineStore({
    init: (): WorkbenchState => ({ pickerOpen: false, replace: false, browser: undefined }),
    actions: {
      openPicker: (draft, replace = false) => { draft.pickerOpen = true; draft.replace = replace },
      closePicker: (draft) => { draft.pickerOpen = false },
      openBrowser: (draft, owner) => { draft.browser = owner },
      closeBrowser: (draft) => { draft.browser = undefined },
    },
  })
}
