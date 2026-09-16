/** Root-scoped workbench chooser state shared by the toolbar and pane actions. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, WorkspaceResourceOpenRequest, WorkspaceResourceTarget } from '@deepseek-ai/dsh-client-runtime/client'

/** Workspace file browser binding: the owning pane Session and its runtime target. */
export interface WorkspaceBrowserOwner {
  readonly sessionId: SessionId
  readonly runtimeTarget: WorkspaceResourceTarget
}

interface WorkbenchState {
  pickerOpen: boolean
  replace: boolean
  preview: WorkspaceResourceOpenRequest | undefined
  browser: WorkspaceBrowserOwner | undefined
}
type WorkbenchActions = {
  openPicker: (draft: WorkbenchState, replace?: boolean) => void
  closePicker: (draft: WorkbenchState) => void
  openPreview: (draft: WorkbenchState, request: WorkspaceResourceOpenRequest) => void
  closePreview: (draft: WorkbenchState) => void
  openBrowser: (draft: WorkbenchState, owner: WorkspaceBrowserOwner) => void
  closeBrowser: (draft: WorkbenchState) => void
}

/** Declare the transient workbench interaction store.
 * @returns a handle shared by root-scoped contributors.
 */
export function createWorkbenchStore(): EngineStoreHandle<WorkbenchState, WorkbenchActions> {
  return defineStore({
    init: (): WorkbenchState => ({ pickerOpen: false, replace: false, preview: undefined, browser: undefined }),
    actions: {
      openPicker: (draft, replace = false) => { draft.pickerOpen = true; draft.replace = replace },
      closePicker: (draft) => { draft.pickerOpen = false },
      openPreview: (draft, request) => { draft.preview = request },
      closePreview: (draft) => { draft.preview = undefined },
      openBrowser: (draft, owner) => { draft.browser = owner },
      closeBrowser: (draft) => { draft.browser = undefined },
    },
  })
}
